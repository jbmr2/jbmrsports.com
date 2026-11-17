'use strict';
// Authenticated clients receive only notifications; scores use existing APIs.
function install(server, { verifyToken, verifyAdmin, revision, invalidate, intervalMs = 400, loadSnapshot = () => require('./ott-feed-api.cjs').productionData(), snapshotTimeoutMs = 8000 }) {
  const { WebSocketServer, WebSocket } = require('ws');
  const wss = new WebSocketServer({ server, path: '/api/live-updates', maxPayload: 8192 });
  let lastRevision, checking = false, loading;
  const deltaStream = require('./score-delta.cjs').createStream();
  async function boundedSnapshot() {
    loading ||= Promise.resolve().then(loadSnapshot).finally(() => { loading = undefined; });
    let timeout;
    try { return await Promise.race([loading, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(Error('Score snapshot timed out')), snapshotTimeoutMs);
    })]); } finally { clearTimeout(timeout); }
  }
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.readyState !== WebSocket.OPEN || !socket.isLiveAuthorized?.()) continue;
      if (socket.bufferedAmount > 16 * 1024 * 1024) { socket.terminate(); continue; }
      socket.send(JSON.stringify({ type: 'heartbeat' }));
    }
  }, 5000);
  heartbeat.unref();
  wss.on('connection', socket => {
    let authenticated = false;
    let cancelExpiry;
    const deadline = setTimeout(() => { if (!authenticated) socket.close(1008, 'Authentication required'); }, 5000);
    socket.once('message', async raw => {
      try {
        const { token, adminDeviceToken, scoreSnapshots, scoreDeltas } = JSON.parse(raw.toString());
        const admin = adminDeviceToken && verifyAdmin?.(adminDeviceToken);
        const user = admin ? null : await verifyToken(token);
        if (!admin && (!user || (user.simulator_preview && !require('./simulator-preview.cjs').allowedSession(user)))) throw Error('Unauthorized');
        if (user?.exp) {
          if (user.exp * 1000 <= Date.now()) throw Error('Session expired');
          cancelExpiry = require('./session-expiry.cjs').scheduleExpiry(user.exp * 1000, () => socket.close(1008, 'Session expired'));
        }
        socket.scoreSnapshots = scoreSnapshots === true && !admin && !user?.simulator_preview;
        socket.scoreDeltas = socket.scoreSnapshots && scoreDeltas === true;
        socket.needsInitialState = socket.scoreDeltas;
        authenticated = true; clearTimeout(deadline);
        socket.send(JSON.stringify({ type: 'ready', scoreDeltas: socket.scoreDeltas }));
      } catch { socket.close(1008, 'Authentication failed'); }
    });
    socket.on('close', () => { clearTimeout(deadline); cancelExpiry?.(); });
    socket.on('error', () => {});
    socket.isLiveAuthorized = () => authenticated;
  });
  const timer = setInterval(async () => {
    if (checking || ![...wss.clients].some(client => client.isLiveAuthorized?.())) return;
    checking = true;
    try {
      const current = await revision();
      if ((lastRevision !== undefined && current !== lastRevision) || [...wss.clients].some(socket => socket.isLiveAuthorized?.() && socket.needsInitialState)) {
        invalidate();
        const clients = [...wss.clients].filter(socket => socket.readyState === WebSocket.OPEN && socket.isLiveAuthorized?.());
        for (const socket of clients.filter(client => !client.scoreSnapshots)) {
          socket.send(JSON.stringify({ type: 'score_changed' }));
        }
        let snapshotMessage, scoringData;
        let delivered = true;
        if (clients.some(socket => socket.scoreSnapshots)) {
          try {
            const { scorers } = await boundedSnapshot();
            scoringData = scorers;
            snapshotMessage = JSON.stringify({ type: 'score_snapshot', scorers });
          } catch (error) {
            delivered = false;
            console.warn('Live score snapshot unavailable', error.code || error.message);
          }
        }
        const deltaUpdate = scoringData ? deltaStream(scoringData) : null;
        const deltaMessage = deltaUpdate ? JSON.stringify(deltaUpdate) : null;
        const stateMessage = scoringData && clients.some(socket => socket.needsInitialState) ? JSON.stringify(deltaStream.state()) : null;
        for (const socket of clients.filter(client => client.scoreSnapshots)) {
          if (socket.readyState !== WebSocket.OPEN) continue;
          if (socket.scoreDeltas && scoringData) {
            const message = socket.needsInitialState ? stateMessage : deltaMessage;
            socket.needsInitialState = false;
            if (message) socket.send(message);
          } else {
            socket.send(snapshotMessage || JSON.stringify({ type: 'score_changed' }));
          }
        }
        if (!delivered) return;
      }
      lastRevision = current;
    } catch (error) { console.warn('Live scoring change detection unavailable', error.code || error.message); }
    finally { checking = false; }
  }, intervalMs);
  timer.unref();
  wss.on('close', () => { clearInterval(timer); clearInterval(heartbeat); });
  return wss;
}
module.exports = { install };
