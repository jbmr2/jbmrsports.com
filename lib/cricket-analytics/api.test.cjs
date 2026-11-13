'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlayerAnalytics, install, resolveMappedPlayerKeys, normalizedMatchDate } = require('../my-performance-api.cjs');
const { analyzeArchives } = require('./index.cjs');

function archive(uid, scorer = 'scorer-a', date = '2026-11-08T10:00:00Z') {
  const state = { runs: 0, wickets: 0, legal_balls: 0 };
  const ball = { id: 1, innings_id: 1, seq: 1, striker_id: 11, non_striker_id: 12, bowler_id: 21, legal: 1,
    runs: 4, event: { bat_runs: 4, completed_runs: 0, wide_runs: 0, noball_runs: 0, bye_runs: 0, legbye_runs: 0, penalty_runs: 0, dead_ball: false, details_pending: false, dismissal: '', out_batter_id: null, boundary: 4 },
    state_before: { ...state }, state_after: { runs: 4, wickets: 0, legal_balls: 1 } };
  return { installation_id: scorer, archive_manifest: { match_uid: uid }, tables: {
    matches: [{ id: 1, match_uid: uid, status: 'COMPLETED', team_a_id: 'A', team_b_id: 'B', tournament_id: 1, total_overs: 20, match_date: date, result: 'Won by 4 runs' }],
    innings: [{ id: 1, match_id: 1, number: 1, batting_team_id: 'A', bowling_team_id: 'B', completed: true,
      initial_state: { runs: 0, wickets: 0, legal_balls: 0, striker_id: 11, non_striker_id: 12 }, state: { runs: 4, wickets: 0, legal_balls: 1 } }],
    balls: [ball], teams: [{ id: 'A', name: 'Alpha' }, { id: 'B', name: 'Beta' }], tournaments: [{ id: 1, name: 'Cup' }],
    players: [{ id: 11, name: 'Player A', team_id: 'A', player_uid: 'public-a', performance_phone: '0000000000' }, { id: 12, name: 'Player B', team_id: 'A' }, { id: 21, name: 'Bowler', team_id: 'B' }],
    match_lineups: [{ match_id: 1, player_id: 11, team_id: 'A' }, { match_id: 1, player_id: 12, team_id: 'A' }, { match_id: 1, player_id: 21, team_id: 'B' }]
  } };
}
function mappings(scorer = 'scorer-a', phone = '9876543210') {
  return {
    playerDirectory: { [scorer]: [{ player_id: 11, public_player_uid: 'public-a', mobile: phone }] },
    playerDownloadLinks: { [scorer]: {} }
  };
}
function ownKeys(archives, phone, map = mappings()) {
  return resolveMappedPlayerKeys({ archives, verifiedPhone: phone, ...map });
}
function installRoutes(data, map = mappings()) {
  const routes = new Map(), app = { get: (path, ...handlers) => routes.set(path, handlers) };
  install(app, (_req, _res, next) => next(), {
    getAuth: () => ({ getUser: async () => ({ phoneNumber: '+919876543210' }) }),
    getArchives: async () => data,
    getPlayerMappings: async () => map
  });
  return routes;
}

test('ownership uses verified RTDB directory mapping and ignores archive phone fields', () => {
  const data = [archive('match-owned')];
  const keys = ownKeys(data, '+91 98765 43210');
  const result = buildPlayerAnalytics({ archives: data, verifiedPhone: '+91 98765 43210', playerKeys: keys });
  assert.equal(result.players.length, 1); assert.equal(result.players[0].playerId, '11');
  assert.equal(result.players[0].batting.runs, 4); assert.equal(result.matches.length, 1);
  assert.equal(JSON.stringify(result).includes('9876543210'), false);
  assert.equal(ownKeys(data, '0000000000').size, 0);
  assert.equal(ownKeys(data, '9876543210', mappings('scorer-a', '1111111111')).size, 0);
});

test('public player UID mismatch cannot link a different scoring identity', () => {
  const data = [archive('match-owned')];
  const wrong = { playerDirectory: { 'scorer-a': [{ player_id: 11, public_player_uid: 'another-person', mobile: '9876543210' }] }, playerDownloadLinks: { 'scorer-a': {} } };
  assert.equal(ownKeys(data, '9876543210', wrong).size, 0);
});

test('player_download_links maps only the linked scorer player; client IDs cannot expand access', async () => {
  const data = [archive('match-owned'), archive('match-private', 'scorer-b')];
  const map = { playerDirectory: {}, playerDownloadLinks: { 'scorer-a': { '11': { phone: '9876543210' } }, 'scorer-b': { '11': { phone: '9999999999' } } } };
  const routes = installRoutes(data, map), handlers = routes.get('/api/my-performance/analytics/overview');
  const res = { set() { return this; }, status(n) { this.code = n; return this; }, json(v) { this.body = v; return this; } };
  await handlers[0]({ user: { uid: 'verified' }, query: { playerId: 'other-player' } }, res, () => {});
  await handlers[1]({}, res, () => {});
  await handlers[2]({ user: { uid: 'verified' }, query: { playerId: 'other-player' } }, res);
  assert.equal(res.body.players.length, 1); assert.equal(res.body.players[0].installationId, 'scorer-a');
  assert.equal(JSON.stringify(res.body).includes('9999999999'), false);
});

test('unmapped phone and invalid phone return no player identities', () => {
  const data = [archive('match-owned')];
  assert.equal(buildPlayerAnalytics({ archives: data, verifiedPhone: '0000000000', playerKeys: ownKeys(data, '0000000000') }).status, 'player_not_linked');
  assert.equal(resolveMappedPlayerKeys({ archives: data, verifiedPhone: 'not-a-phone', ...mappings() }).size, 0);
});

test('unauthenticated requests stop before mapping or archive lookup', async () => {
  const routes = new Map(), app = { get: (path, ...handlers) => routes.set(path, handlers) };
  let userLookups = 0, archiveReads = 0, mappingReads = 0;
  install(app, (_req, res) => res.status(401).json({ ok: false }), {
    getAuth: () => ({ getUser: async () => { userLookups++; throw Error('must not run'); } }),
    getArchives: async () => { archiveReads++; return []; },
    getPlayerMappings: async () => { mappingReads++; return {}; }
  });
  const handlers = routes.get('/api/my-performance/analytics/batting');
  const res = { status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } };
  handlers[0]({}, res, () => {});
  assert.equal(res.code, 401); assert.equal(userLookups, 0); assert.equal(archiveReads, 0); assert.equal(mappingReads, 0);
});

test('all endpoint schemas preserve Phase 2 calculations and include real labels/date', async () => {
  const data = [archive('match-owned')], expected = analyzeArchives(data).players.find(p => p.playerId === '11');
  const routes = installRoutes(data);
  async function response(name) {
    const handlers = routes.get(`/api/my-performance/analytics/${name}`);
    const res = { set() { return this; }, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
    await handlers[0]({}, res, () => {}); await handlers[1]({}, res, () => {});
    await handlers[2]({ user: { uid: 'uid' }, query: {} }, res);
    return res;
  }
  const overview = await response('overview'), batting = await response('batting'), bowling = await response('bowling');
  const h2h = await response('head-to-head'), opposition = await response('opposition');
  assert.equal(overview.body.players[0].runs, expected.batting.runs);
  assert.equal(overview.body.players[0].wickets, expected.bowling.wickets);
  assert.deepEqual(batting.body.players[0].batting, expected.batting);
  assert.deepEqual(bowling.body.players[0].bowling, expected.bowling);
  assert.equal(batting.body.matches[0].matchDate, '2026-11-08T10:00:00.000Z');
  assert.equal(batting.body.matches[0].teamAName, 'Alpha');
  assert.ok(h2h.body.headToHead.every(row => row.batterName && row.bowlerName));
  assert.ok(opposition.body.players[0].opposition.every(row => row.teamName));
  for (const res of [overview, batting, bowling, h2h, opposition]) {
    assert.equal(res.body.ok, true); assert.equal(JSON.stringify(res.body).includes('9876543210'), false);
  }
});

test('pagination is bounded, deterministic by date, and exposes missing dates as null', () => {
  const data = [archive('later', 'scorer-a', '2026-11-08'), archive('older', 'scorer-b', '2026-11-01'), archive('date-missing', 'scorer-c', null)];
  const keys = new Set([...ownKeys([data[0]], '9876543210'), ...ownKeys([data[1]], '9876543210', mappings('scorer-b')), ...ownKeys([data[2]], '9876543210', mappings('scorer-c'))]);
  const page = buildPlayerAnalytics({ archives: data, verifiedPhone: '9876543210', playerKeys: keys, limit: 2 });
  assert.deepEqual(page.matches.map(row => row.matchUid), ['later', 'older']);
  assert.equal(page.pagination.nextCursor, '2');
  const next = buildPlayerAnalytics({ archives: data, verifiedPhone: '9876543210', playerKeys: keys, limit: 2, cursor: page.pagination.nextCursor });
  assert.equal(next.matches.length, 1); assert.equal(next.matches[0].matchDate, null);
  assert.equal(normalizedMatchDate({ match_date: { seconds: 1794132000 } }), '2026-11-08T10:00:00.000Z');
  assert.throws(() => buildPlayerAnalytics({ archives: data, verifiedPhone: '9876543210', playerKeys: keys, cursor: 'bad' }), error => error.code === 'INVALID_CURSOR');
});

test('head-to-head pagination advances and does not repeat pair records', () => {
  const data = [archive('h2h-pages')], item = data[0];
  item.tables.players.push({ id: 22, name: 'Second Bowler', team_id: 'B' });
  item.tables.match_lineups.push({ match_id: 1, player_id: 22, team_id: 'B' });
  const first = item.tables.balls[0];
  item.tables.balls.push({ ...first, id: 2, seq: 2, bowler_id: 22, runs: 1,
    event: { ...first.event, bat_runs: 1, boundary: 0 },
    state_before: { runs: 4, wickets: 0, legal_balls: 1 }, state_after: { runs: 5, wickets: 0, legal_balls: 2 } });
  item.tables.innings[0].state = { runs: 5, wickets: 0, legal_balls: 2 };
  const keys = ownKeys(data, '9876543210');
  const page1 = buildPlayerAnalytics({ archives: data, verifiedPhone: '9876543210', playerKeys: keys, limit: 1 });
  assert.equal(page1.headToHead.length, 1); assert.equal(page1.pagination.headToHeadNextCursor, '1');
  const page2 = buildPlayerAnalytics({ archives: data, verifiedPhone: '9876543210', playerKeys: keys, limit: 1, cursor: page1.pagination.headToHeadNextCursor });
  assert.equal(page2.headToHead.length, 1); assert.notEqual(page1.headToHead[0].bowlerKey, page2.headToHead[0].bowlerKey);
  assert.equal(page2.pagination.headToHeadNextCursor, null);
});

test('existing clip-package route remains separately registered and analytics routes are additive', () => {
  const source = require('node:fs').readFileSync(require.resolve('../shorts.cjs'), 'utf8');
  assert.match(source, /app\.get\('\/api\/my-performance',authenticated,limited/);
  assert.match(source, /require\('\.\/my-performance-api\.cjs'\)\.install/);
});

test('API returns verified T10 totals without inventing unspecified phase splits', async () => {
  const input = archive('t10'); input.tables.matches[0].total_overs = 10;
  const routes = installRoutes([input]);
  const handlers = routes.get('/api/my-performance/analytics/batting');
  const response = { set() { return this; }, status(n) { this.code = n; return this; }, json(body) { this.body = body; } };
  await handlers.at(-1)({ user: { uid: 'user' }, query: {} }, response);
  assert.equal(response.code, undefined);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.players[0].batting.runs, 4);
  assert.equal(response.body.players[0].batting.powerplayRuns, null);
  assert.equal(response.body.players[0].batting.middleOversRuns, null);
  assert.equal(response.body.players[0].batting.deathOversRuns, null);
  assert.ok(response.body.warnings.some(w => w.code === 'UNSPECIFIED_PHASES'));
});
