const test = require('node:test');
const assert = require('node:assert/strict');
const { publishedArchives, install } = require('../lib/public-archives.cjs');
function fixture() {
  return { installation_id: 'synthetic-a', synced_at: 12, private_note: 'PRIVATE',
    archive_manifest: { match_uid: 'match-a', match_id: 1, tournament_id: 9, revision: 'r1', chunk_count: 2, private_note: 'PRIVATE' },
    tables: {
      matches: [{ id: 1, match_uid: 'match-a', tournament_id: 9, team_a_id: 1, team_b_id: 2, status: 'COMPLETED', result: 'Alpha won', private_note: 'PRIVATE', highlight: { url: 'https://example.invalid/h.mp4', status: 'ready', token: 'PRIVATE' } },
        { id: 2, tournament_id: 10, team_a_id: 3, team_b_id: 4, title: 'HIDDEN' }],
      innings: [{ id: 11, match_id: 1, number: 1, batting_team_id: 1, bowling_team_id: 2, state: { runs: 4, wickets: 0, legal_balls: 1, phone: 'PRIVATE' } }, { id: 22, match_id: 2 }],
      balls: [{ id: 111, innings_id: 11, striker_id: 1, non_striker_id: 2, bowler_id: 3, legal: 1, seq: 1, runs: 4,
        event_json: JSON.stringify({ bat_runs: 4, wide_runs: 0, dismissal: '', fielder_id: 4, private_note: 'PRIVATE' }),
        state_after: JSON.stringify({ runs: 4, wickets: 0, legal_balls: 1, email: 'PRIVATE' }),
        clip_status: 'ready', clip: { url: 'https://example.invalid/ball.mp4', status: 'ready', credentials: 'PRIVATE' } },
        { id: 222, innings_id: 22, striker_id: 5, event: { bat_runs: 6 } }],
      players: Object.fromEntries([1, 2, 3, 4, 5, 6].map(id => [String(id), { name: id === 5 ? 'HIDDEN' : `Player ${id}`, mobile: 'PRIVATE', performance_phone: 'PRIVATE', player_uid: 'PRIVATE', photo: { url: 'https://example.invalid/p.png', token: 'PRIVATE' } }])),
      teams: [1, 2, 3, 4].map(id => ({ id, name: id < 3 ? `Team ${id}` : 'HIDDEN', phone: 'PRIVATE' })),
      tournaments: [{ id: 9, name: 'Cup', logo: { url: 'https://example.invalid/logo.png', email: 'PRIVATE' } }, { id: 10, name: 'HIDDEN' }],
      match_lineups: [{ match_id: 1, player_id: 6, team_id: 1, position: 3 }, { match_id: 2, player_id: 5, team_id: 3 }],
      accounts: [{ password: 'PRIVATE' }]
    }
  };
}
const rules = { tournaments: { 9: { show: true } } };
test('public archives remove hidden rows and private fields including encoded nested JSON', () => {
  const source = fixture(), before = JSON.stringify(source);
  const result = publishedArchives([source], rules), output = JSON.stringify(result);
  assert.equal(result.length, 1);
  assert.equal(output.includes('PRIVATE'), false); assert.equal(output.includes('HIDDEN'), false);
  assert.equal(JSON.stringify(source), before, 'internal archive is not modified');
  const t = result[0].tables;
  assert.deepEqual(t.players.map(p => p.id), ['1', '2', '3', '4', '6']);
  assert.equal(t.balls.length, 1); assert.equal(t.balls[0].event_json.bat_runs, 4);
  assert.equal(t.balls[0].state_after.runs, 4); assert.equal(t.innings[0].state.runs, 4);
  assert.equal(t.balls[0].clip.url, source.tables.balls[0].clip.url);
  assert.equal(t.matches[0].highlight.url, source.tables.matches[0].highlight.url);
  assert.equal(result[0].archive_manifest.ball_record_count, 1);
});
test('publication denies by default and tournament hide overrides match show', () => {
  assert.deepEqual(publishedArchives([fixture()], {}), []);
  assert.deepEqual(publishedArchives([fixture()], { tournaments: { 9: { show: false } }, matches: { 1: { show: true } } }), []);
  assert.deepEqual(publishedArchives([fixture()], { ...rules, matches: { 1: { show: false } } }), []);
  assert.equal(publishedArchives([fixture()], { matches: { 1: { show: true } } }).length, 1);
});
test('an unrelated published match inside a backup cannot escape its manifest', () => {
  const input = fixture(); input.archive_manifest.match_id = 77; input.archive_manifest.match_uid = 'missing';
  assert.deepEqual(publishedArchives([input], { tournaments: { 9: { show: true }, 10: { show: true } } }), []);
  input.archive_manifest.match_id = 1;
  assert.deepEqual(publishedArchives([input], rules), [], 'conflicting UID is not trusted just because the number matches');
});
test('malformed scoring JSON is an error rather than a zero score', () => {
  const input = fixture(); input.tables.balls[0].event_json = '{invalid';
  assert.throws(() => publishedArchives([input], rules), /Malformed/);
});
test('archive endpoint keeps auth middleware and fails closed when visibility cannot load', async () => {
  let handlers, reads = 0;
  const auth = (_req, res) => res.status(401).json({ ok: false });
  const response = () => ({ set(k, v) { this[k] = v; return this; }, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } });
  install({ get(path, ...h) { assert.equal(path, '/api/scoring-archives'); handlers = h; } }, auth, {
    archives: async () => { reads++; return [fixture()]; }, visibility: async () => { throw Error('offline'); }
  });
  const denied = response(); handlers[0]({}, denied);
  assert.equal(denied.code, 401); assert.equal(reads, 0);
  const failed = response(); await handlers[1]({}, failed);
  assert.equal(failed.code, 502); assert.equal(failed.body.archives, undefined);
  assert.equal(failed['Cache-Control'], 'private, no-store');
});
test('public archive response includes an explicit partial-history report', async () => {
  let handlers;
  const app = { get(_path, ...registered) { handlers = registered; } };
  const report = { invalidArchives: 2, invalidMatchUIDs: ['broken-a', 'broken-b'] };
  install(app, (_req, _res, next) => next(), {
    archives: async () => [fixture()], visibility: async () => ({ tournaments: { 9: { show: true } } })
  });
  // The default diagnostics accessor is intentionally not mocked in this
  // contract test; it must always be shaped even when the count is zero.
  const res = { set() { return this; }, json(body) { this.body = body; } };
  await handlers[1]({}, res);
  assert.ok(res.body.archiveDiagnostics);
  assert.equal(typeof res.body.archiveDiagnostics.invalidArchives, 'number');
  assert.ok(Array.isArray(res.body.archiveDiagnostics.invalidMatchUIDs));
  void report;
});
