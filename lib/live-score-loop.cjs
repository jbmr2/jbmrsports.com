'use strict';
const { performance } = require('node:perf_hooks');
const { mergeHeads } = require('./live-score-heads.cjs');

// The score lane never awaits the catalog/history lane. A slow or failed
// scorecard download therefore cannot hold up a committed score change.
function start(wss, { loadHeads, loadSnapshot, invalidate, intervalMs = 100,
  reconcileMs = 10000, snapshotTimeoutMs = 8000 }) {
  const stream = require('./score-delta.cjs').createStream();
  let closed = false, checking = false, latest, refreshing = false, detailRequested = true;
  let snapshotFlight, retryTimer, lastDetailAt = 0, deliverySequence = 0;
  const recent = [];
  const metrics = { mode: 'mysql-score-heads', scoreBootstrap: 'heads-first', pollIntervalMs: intervalMs,
    commitTimestampAvailable: false, checks: 0, changes: 0, errors: 0, broadcasts: 0,
    detailErrors: 0, acknowledgementMeaning: 'server send to client state applied and acknowledgement return; includes network round trip' };
  const clients = () => [...wss.clients].filter(c => c.readyState === 1 && c.isLiveAuthorized?.());
  function send(message, recipients = clients()) {
    if (!message || !recipients.length) return;
    const deliveryId = String(++deliverySequence), sentAt = Date.now();
    const data = JSON.stringify({ ...message, deliveryId, serverSentAt: sentAt });
    const monotonic = performance.now();
    const tracked = message.type === 'score_state' || message.type === 'score_delta' || message.type === 'score_snapshot';
    for (const client of recipients) {
      if (client.bufferedAmount > 2 * 1024 * 1024) { client.close(1013, 'Resync required'); continue; }
      if (tracked) {
        client.scoreDeliveries ||= new Map();
        client.scoreDeliveries.set(deliveryId, monotonic);
        while (client.scoreDeliveries.size > 32) client.scoreDeliveries.delete(client.scoreDeliveries.keys().next().value);
      }
      client.send(data);
    }
    if (tracked) {
      metrics.broadcasts++;
      metrics.lastSentAt = sentAt;
      metrics.lastPayloadBytes = Buffer.byteLength(data);
      metrics.lastMessageType = message.type;
      metrics.lastVersion = message.version;
    }
  }
  function publish(scorers) {
    const update = stream(scorers);
    const list = clients().filter(c => c.scoreSnapshots);
    const starting = list.filter(c => c.needsInitialState);
    if (starting.length) {
      send(stream.state(), starting.filter(c => c.scoreDeltas));
      send({ type: 'score_snapshot', scorers }, starting.filter(c => !c.scoreDeltas));
      for (const client of starting) client.needsInitialState = false;
    }
    if (update) {
      send(update, list.filter(c => !starting.includes(c) && c.scoreDeltas));
      send({ type: 'score_snapshot', scorers }, list.filter(c => !starting.includes(c) && !c.scoreDeltas));
    }
  }
  function recordHeads(value) {
    metrics.checks++;
    metrics.lastCheckAt = Date.now();
    metrics.reachable = true;
    metrics.lastDBReadMs = value.dbReadMs;
    metrics.lastHeadReadMs = value.readMs;
    if (latest?.revision === value.revision) { latest = value; return false; }
    const wasReady = Boolean(latest);
    latest = value;
    if (wasReady) { metrics.changes++; metrics.latestChangeAt = value.observedAt; }
    const start = performance.now();
    const previous = stream.state();
    publish(previous ? mergeHeads(previous.scorers, latest.scorers) : latest.scorers);
    if (wasReady) {
      metrics.lastDetectedToSendMs = performance.now() - start;
      recent.push({ detectedAt: value.observedAt, dbReadMs: value.dbReadMs,
        detectedToSendMs: metrics.lastDetectedToSendMs, payloadBytes: metrics.lastPayloadBytes });
      if (recent.length > 30) recent.shift();
      send({ type: 'score_changed' }, clients().filter(c => !c.scoreSnapshots));
    }
    detailRequested = true;
    return true;
  }
  async function boundedSnapshot() {
    snapshotFlight ||= Promise.resolve().then(loadSnapshot).finally(() => { snapshotFlight = undefined; });
    let timer;
    try { return await Promise.race([snapshotFlight, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Score details timed out')), snapshotTimeoutMs);
    })]); } finally { clearTimeout(timer); }
  }
  async function refreshDetails() {
    if (closed || refreshing || !clients().some(c => c.scoreSnapshots)) return;
    refreshing = true;
    detailRequested = false;
    const start = performance.now();
    try {
      invalidate();
      const { scorers } = await boundedSnapshot();
      // Re-read after the slower request so a late HTTP/history response can
      // never restore older runs, wickets, targets or completion status.
      const heads = await loadHeads();
      recordHeads(heads);
      if (closed) return;
      publish(mergeHeads(scorers, heads.scorers));
      lastDetailAt = Date.now();
      metrics.lastDetailReadMs = performance.now() - start;
      metrics.lastDetailAt = lastDetailAt;
    } catch (error) {
      metrics.detailErrors++;
      metrics.lastDetailError = String(error.code || error.message).slice(0, 100);
      detailRequested = true;
      send({ type: 'score_changed' }, clients().filter(c => c.needsInitialState));
    } finally {
      refreshing = false;
      clearTimeout(retryTimer);
      // Coalesce bursts, but retry failures even if the score does not change.
      if (detailRequested && !closed) retryTimer = setTimeout(refreshDetails, 1000);
    }
  }
  async function check() {
    if (closed || checking || !clients().length) return;
    checking = true;
    try {
      const changed = recordHeads(await loadHeads());
      const initial = clients().some(c => c.scoreSnapshots && c.needsInitialState);
      if (initial && stream.state()) publish(stream.state().scorers);
      if (changed || initial || (Date.now() - lastDetailAt >= reconcileMs && !refreshing)) {
        detailRequested = true;
        void refreshDetails();
      }
    } catch (error) {
      metrics.errors++;
      metrics.reachable = false;
      metrics.lastError = String(error.code || error.message).slice(0, 100);
    } finally { checking = false; }
  }
  wss.acknowledgeScore = (socket, message) => {
    const id = String(message.deliveryId || '');
    const started = socket.scoreDeliveries?.get(id);
    if (started == null) return;
    socket.scoreDeliveries.delete(id);
    metrics.lastClientAckAt = Date.now();
    metrics.lastSendToAckMs = performance.now() - started;
    for (const name of ['decodeMs', 'applyMs']) {
      if (Number.isFinite(message[name]) && message[name] >= 0 && message[name] <= 60000) {
        metrics[name === 'decodeMs' ? 'lastClientDecodeMs' : 'lastClientApplyMs'] = message[name];
      }
    }
  };
  wss.requestInitial = () => { setImmediate(check); };
  wss.notifyCommitted = () => { detailRequested = true; setImmediate(check); void refreshDetails(); };
  wss.liveHealth = () => ({ ...metrics, clients: clients().length, detailReadInFlight: refreshing, recent: [...recent] });
  wss.scoreStateVersion = () => {
    const state = stream.state();
    return state ? { epoch: state.epoch, version: state.version } : {};
  };
  const timer = setInterval(check, intervalMs);
  timer.unref();
  wss.on('close', () => { closed = true; clearInterval(timer); clearTimeout(retryTimer); });
  return wss;
}
module.exports = { start };
