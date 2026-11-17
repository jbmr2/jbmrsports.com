'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const WS = require('ws');
const { install } = require('../lib/live-socket.cjs');
const { createReader, mergeHeads } = require('../lib/live-score-heads.cjs');
const source = 'a'.repeat(32);
const wait = ms => new Promise(done => setTimeout(done, ms));
function data(runs = 196, status = 'live') {
  return { [source]: { installation_id: source, tables: {
    matches: { 90: { id: 90, tournament_id: 9, status, format: 'test' } },
    innings: { 515: { id: 515, match_id: 90, number: 3, completed: status === 'completed' ? 1 : 0,
      state: { runs, wickets: 2, legal_balls: 285 } } },
    balls: { 1: { id: 1, innings_id: 515, runs: 4 } },
    players: { 1: { id: 1, name: 'Player' } }
  } } };
}
function heads(runs, status) {
  const state = data(runs, status);
  delete state[source].tables.balls; delete state[source].tables.players;
  return { scorers: state, revision: JSON.stringify(state), observedAt: Date.now(), dbReadMs: 1, readMs: 2 };
}
async function until(get, label) {
  for (let i = 0; i < 150; i++) { const value = get(); if (value) return value; await wait(10); }
  assert.fail('Missing ' + label);
}
async function setup(t, options = {}) {
  const server = http.createServer();
  const hub = install(server, { verifyToken: async () => ({}), invalidate() {},
    loadHeads: async () => heads(196), loadSnapshot: async () => ({ scorers: data() }),
    intervalMs: 10, reconcileMs: 60000, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const c of hub.clients) c.terminate(); await new Promise(done => hub.close(done)); await new Promise(done => server.close(done)); });
  async function connect() {
    const ws = new WS(`ws://127.0.0.1:${server.address().port}/api/live-updates`), messages = [];
    ws.on('message', raw => messages.push(JSON.parse(raw)));
    await once(ws, 'open'); ws.send(JSON.stringify({ token: 'fixture', scoreSnapshots: true, scoreDeltas: true }));
    await until(() => messages.find(m => m.type === 'score_state'), 'initial state');
    return { ws, messages };
  }
  return { hub, connect };
}
test('score update and undo bypass a blocked history load; stale details cannot revert the score', async t => {
  let runs = 196, reads = 0, finish;
  const { hub, connect } = await setup(t, {
    loadHeads: async () => heads(runs),
    loadSnapshot: async () => ++reads === 1 ? { scorers: data() } : new Promise(resolve => { finish = resolve; })
  });
  const { ws, messages } = await connect();
  const start = performance.now(); runs = 200;
  const changed = await until(() => messages.find(m => m.type === 'score_delta' && m.changes.some(c => c.table === 'innings' && c.upsert[0]?.state.runs === 200)), 'fast score');
  assert.ok(performance.now() - start < 250, 'score must not wait for history');
  await until(() => finish, 'blocked history');
  runs = 198;
  await until(() => messages.find(m => m.type === 'score_delta' && m.changes.some(c => c.table === 'innings' && c.upsert[0]?.state.runs === 198)), 'undo');
  finish({ scorers: data(196) }); await wait(60);
  const scores = messages.flatMap(m => (m.changes || []).filter(c => c.table === 'innings').flatMap(c => c.upsert.map(r => r.state.runs)));
  assert.deepEqual(scores, [200, 198]);
  assert.ok(Buffer.byteLength(JSON.stringify(changed)) < 1500);
  ws.send(JSON.stringify({ type: 'score_applied', deliveryId: changed.deliveryId, decodeMs: 2, applyMs: 3 }));
  await until(() => hub.liveHealth().lastClientAckAt, 'client acknowledgement');
  assert.equal(hub.liveHealth().lastClientApplyMs, 3);
  assert.equal(hub.liveHealth().commitTimestampAvailable, false);
});
test('reconnect and completion deliver current final status and score in the same version', async t => {
  let runs = 196, status = 'live';
  const { connect } = await setup(t, { loadHeads: async () => heads(runs, status), loadSnapshot: async () => ({ scorers: data(runs, status) }) });
  const first = await connect(); first.ws.close(); await once(first.ws, 'close');
  runs = 201; status = 'completed';
  const next = await connect();
  const initial = next.messages.find(m => m.type === 'score_state');
  assert.equal(initial.scorers[source].tables.matches[90].status, 'completed');
  assert.equal(initial.scorers[source].tables.innings[515].state.runs, 201);
  assert.equal(initial.scorers[source].tables.innings[515].completed, 1);
});
test('post-commit notification wakes the reader without waiting for the poll interval', async t => {
  let runs = 196;
  const { hub, connect } = await setup(t, { intervalMs: 60000,
    loadHeads: async () => heads(runs), loadSnapshot: async () => ({ scorers: data(runs) }) });
  const { messages } = await connect();
  runs = 202; hub.notifyCommitted();
  await until(() => messages.find(m => m.type === 'score_delta'), 'notification update');
});
test('head reader keeps publication restrictions, strips private fields and caches only rules', async () => {
  let show = true, time = 0, reads = 0, policyReads = 0;
  const read = createReader({ now: () => time, read: async () => {
    reads++;
    return { installation_id: source, tables: { matches: [{ id: 90, tournament_id: 9, secret: 'private' }],
      innings: [{ id: 515, match_id: 90, number: 4, state: { runs: reads, privateField: 'private' } }] } };
  }, visibility: async () => { policyReads++; return { matches: { [`${source}:90`]: { show } } }; }, resolve: async (_, rules) => rules });
  const first = await read(), second = await read();
  assert.notEqual(first.revision, second.revision); assert.equal(policyReads, 1);
  assert.ok(!JSON.stringify(first).includes('private'));
  time = 1001; show = false;
  const hidden = await read();
  assert.equal(Object.keys(hidden.scorers[source].tables.matches).length, 0);
  const merged = mergeHeads(data(), hidden.scorers);
  assert.equal(Object.keys(merged[source].tables.balls).length, 0);
});
test('compact read uses one committed view and does not read history, players or photos', async () => {
  const calls = [];
  const conn = { beginTransaction: async () => calls.push('begin'), commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'), release: () => calls.push('release'),
    query: async ({ sql, timeout }) => { calls.push(sql); assert.ok(timeout <= 3000);
      return [sql.includes('matches') ? [{ id: 90, rules_json: '{"scoring_format":"test"}' }] : [{ id: 515, state: '{"runs":196}' }]]; } };
  const result = await require('../lib/mysql-scoring.cjs').scoreHeads({ getConnection: async () => conn });
  assert.equal(result.tables.matches[0].format, 'test');
  assert.deepEqual(calls, ['begin', 'SELECT * FROM matches ORDER BY id', 'SELECT * FROM innings ORDER BY id', 'commit', 'release']);
});
