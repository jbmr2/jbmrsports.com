const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
function load(name, mocks) {
  const filename = path.resolve(__dirname, '../lib', name);
  const local = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, require: key => Object.hasOwn(mocks, key) ? mocks[key] : local(key),
    console: { info() {}, warn() {}, error() {} }, process: { env: {} }, Buffer, URL
  }, { filename });
  return module.exports;
}
const scorer = '80c7442eb2ca4aeabfb6779128d91b8a';
const phone = '0000000001';
function archive() {
  return { installation_id: scorer, archive_manifest: { match_uid: 'synthetic', match_id: 1 }, tables: {
    matches: [{ id: 1, status: 'COMPLETED', tournament_id: 9, team_a_id: 1, team_b_id: 2 }],
    innings: [{ id: 1, match_id: 1 }], players: [{ id: 11, player_uid: 'synthetic-player', name: 'Synthetic Batter' }],
    teams: [{ id: 1, name: 'Alpha' }, { id: 2, name: 'Beta' }], tournaments: [{ id: 9, name: 'Synthetic Cup' }],
    balls: [{ id: 1, innings_id: 1, striker_id: 11, bowler_id: 22, seq: 1,
      event: { bat_runs: 4 }, clip_status: 'ready', clip: { url: 'https://example.invalid/clip.mp4' } }]
  } };
}
test('clip API uses canonical archives without legacy reads and respects fresh visibility', async () => {
  const visibility = { tournaments: { 9: { show: true } } }, reads = [];
  const links = {};
  let archiveLoads = 0;
  const rtdb = { ref(key) { reads.push(key); return { get: async () => ({ val: () =>
    key === 'app_visibility' ? visibility : key === 'player_download_links' ? links : key === 'player_directory'
      ? { [scorer]: [{ player_id: 11, public_player_uid: 'synthetic-player', mobile: phone }] } : {} }) }; } };
  const actualAdmin = require('../lib/admin-visibility.cjs');
  const service = load('shorts.cjs', {
    'firebase-admin/database': { getDatabaseWithUrl: () => rtdb },
    'firebase-admin/firestore': { getFirestore: () => { throw Error('Unexpected legacy archive read'); } },
    'firebase-admin/auth': { getAuth: () => ({ getUser: async () => ({ phoneNumber: phone }) }) },
    './admin-visibility.cjs': { ...actualAdmin, archives: async () => { archiveLoads++; return [archive()]; } }
  });
  const routes = new Map();
  const app = { get: (p, ...handlers) => routes.set(p, handlers), post() {}, put() {}, delete() {} };
  service.install(app, () => {});
  const handler = routes.get('/api/my-performance').at(-1);
  async function request() {
    const res = { set() { return this; }, status(n) { this.code = n; return this; }, json(body) { this.body = body; } };
    await handler({ user: { uid: 'synthetic-user' } }, res); return res.body;
  }
  const result = await request();
  assert.equal(result.ok, true); assert.equal(result.linked, true);
  assert.equal(result.packages.length, 2); assert.equal(result.packages[0].runs, 4);
  assert.equal(result.diagnostic.status, 'clips_ready');
  visibility.tournaments[9].show = false;
  const hidden = await request();
  assert.equal(hidden.packages.length, 0); assert.equal(hidden.diagnostic.status, 'no_visible_performance');
  assert.equal(archiveLoads, 1); // Shared catalog can remain cached while visibility is refreshed.
  assert.equal(reads.filter(x => x === 'app_visibility').length, 2);
  // Revoke while scoring remains cached: neither stale directory nor archive
  // ownership can keep exposing the prior player's packages.
  visibility.tournaments[9].show = true;
  links[scorer] = { 11: { phone: '' } };
  const revoked = await request();
  assert.equal(revoked.linked, false); assert.equal(revoked.packages.length, 0);
  assert.equal(archiveLoads, 1);
  links[scorer][11].phone = '0000000002';
  const reassigned = await request();
  assert.equal(reassigned.linked, false); assert.equal(reassigned.packages.length, 0);
});
test('archive wrapper reports invalid history while preserving any valid archives', async () => {
  for (const valid of [[], [archive()]]) {
    const service = load('admin-visibility.cjs', {
      'firebase-admin/firestore': { getFirestore: () => ({}) },
      './match-archives.cjs': { readMatchArchives: async (_db, options) => {
        options.onInvalidArchive({ matchUID: 'broken', error: Error('missing chunk') }); return valid;
      } }
    });
    assert.equal((await service.archives()).length, valid.length);
    assert.equal(service.archiveDiagnostics().invalidArchives, 1);
  }
});
