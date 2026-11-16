'use strict';
// Authenticated clients receive only notifications; scores use existing APIs.
function install(server, { verifyToken, verifyAdmin, revision, invalidate, intervalMs = 2000 }) {
  const { WebSocketServer, WebSocket } = require('ws');
  const wss = new WebSocketServer({ server, path: '/api/live-updates', maxPayload: 8192 });
  let lastRevision, checking = false;
  wss.on('connection', socket => {
    let authenticated = false;
    let expiryTimer;
    const deadline = setTimeout(() => { if (!authenticated) socket.close(1008, 'Authentication required'); }, 5000);
    socket.once('message', async raw => {
      try {
        const { token, adminDeviceToken } = JSON.parse(raw.toString());
        const admin = adminDeviceToken && verifyAdmin?.(adminDeviceToken);
        const user = admin ? null : await verifyToken(token);
        if (!admin && (!user || (user.simulator_preview && !require('./simulator-preview.cjs').allowedSession(user)))) throw Error('Unauthorized');
        if (user?.exp) expiryTimer = setTimeout(() => socket.close(1008, 'Session expired'), Math.max(0, user.exp * 1000 - Date.now()));
        authenticated = true; clearTimeout(deadline);
        socket.send(JSON.stringify({ type: 'ready' }));
      } catch { socket.close(1008, 'Authentication failed'); }
    });
    socket.on('close', () => { clearTimeout(deadline); clearTimeout(expiryTimer); });
    socket.on('error', () => {});
    socket.isLiveAuthorized = () => authenticated;
  });
  const timer = setInterval(async () => {
    if (checking || ![...wss.clients].some(client => client.isLiveAuthorized?.())) return;
    checking = true;
    try {
      const current = await revision();
      if (lastRevision !== undefined && current !== lastRevision) {
        invalidate();
        for (const socket of wss.clients) if (socket.readyState === WebSocket.OPEN && socket.isLiveAuthorized?.()) socket.send(JSON.stringify({ type: 'score_changed' }));
      }
      lastRevision = current;
    } catch (error) { console.warn('Live scoring change detection unavailable', error.code || error.message); }
    finally { checking = false; }
  }, intervalMs);
  timer.unref();
  wss.on('close', () => clearInterval(timer));
  return wss;
}
module.exports = { install };
