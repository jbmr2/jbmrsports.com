const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const WS = require('ws');
const { install } = require('../lib/live-socket.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('hung snapshot times out, legacy viewer is notified immediately, failed revision retries', async t => {
  let revision = 0, checks = 0, resolve;
  const server = http.createServer();
  const hub = install(server, { verifyToken: async () => ({}), revision: async () => { checks++; return revision; },
    invalidate() {}, intervalMs: 10, snapshotTimeoutMs: 60,
    loadSnapshot: () => new Promise(done => { resolve = done; }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const c of hub.clients) c.terminate(); hub.close(); await new Promise(done => server.close(done)); });
  async function connect(direct) {
    const ws = new WS(`ws://127.0.0.1:${server.address().port}/api/live-updates`);
    const events = []; ws.on('message', data => events.push(JSON.parse(data)));
    await once(ws, 'open'); ws.send(JSON.stringify({ token: 'fixture', scoreSnapshots: direct }));
    return events;
  }
  const direct = await connect(true), legacy = await connect(false);
  async function waitFor(events, type) {
    for (let i=0;i<100;i++) { const event=events.find(x=>x.type===type); if(event) return event; await delay(10); }
    assert.fail('Missing '+type);
  }
  await waitFor(direct,'ready'); await waitFor(legacy,'ready');
  while(!checks) await delay(5); revision++;
  await waitFor(legacy,'score_changed');
  await waitFor(direct,'score_changed');
  for(let i=0;i<30;i++) { resolve({scorers:{runs:115}}); await delay(10); if(direct.some(x=>x.type==='score_snapshot')) break; }
  assert.equal((await waitFor(direct,'score_snapshot')).scorers.runs,115);
});
