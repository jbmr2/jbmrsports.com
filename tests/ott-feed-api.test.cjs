'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { liveFeed, publicScorers, install } = require('../lib/ott-feed-api.cjs');

const source = '1828191fb9a445a892ce12ae0dc737ee';
const payload = { tables: {
  matches: [{ id: 3, match_uid: 'match-uid', tournament_id: 1, team_a_id: 2, team_b_id: 1, status: 'live' }],
  teams: [{ id: 1, name: 'Red' }, { id: 2, name: 'Blue' }],
  tournaments: [{ id: 1, name: 'Cup' }], players: [{ id: 12, name: 'Batter', phone: 'PRIVATE' }],
  innings: [{ id: 1, match_id: 3, number: 1 }],
  balls: [{ id: 1, innings_id: 1, striker_id: 12, event: { bat_runs: 4, phone: 'PRIVATE' } }],
  match_lineups: []
} };
test('live scorer projection denies unpublished matches and excludes private fields', () => {
  const hidden = publicScorers({ [source]: payload }, {});
  assert.deepEqual(hidden[source].tables, {});
  const shown = publicScorers({ [source]: payload }, { matches: { 3: { show: true } } });
  assert.equal(shown[source].tables.matches['3'].match_uid, 'match-uid');
  assert.equal(JSON.stringify(shown).includes('PRIVATE'), false);
});
test('live feed preserves scoped match identity and real team names across source IDs', () => {
  const scorers = publicScorers({ [source]: payload }, { matches: { 3: { show: true } } });
  const feed = liveFeed({ scorers, tournamentFeed: { [source]: { tournaments: { uid: {
    tournament_id: 1, name: 'Cup', matches: { 'match-uid': { match_id: 3, status: 'live' } }
  } } } } });
  const match = feed.tournaments[`${source}:1`].matches[`${source}:3`];
  assert.equal(match.team1.name, 'Blue'); assert.equal(match.team2.name, 'Red');
  assert.equal(match.matchId, `${source}:3`);
});
test('both scoring routes keep auth before loading and surface upstream failures', async () => {
  const routes = new Map(); let reads = 0;
  const auth = (_req, res) => res.status(401).json({ ok: false });
  install({ get: (path, ...handlers) => routes.set(path, handlers) }, auth, {
    load: async () => { reads++; throw Error('offline'); }
  });
  for (const handlers of routes.values()) {
    const response = { set() { return this; }, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } };
    handlers[0]({}, response); assert.equal(response.code, 401); assert.equal(reads, 0);
  }
  const res = { set() { return this; }, status(n) { this.code = n; return this; }, json(body) { this.body = body; } };
  await routes.get('/api/public/live-feed')[1]({}, res);
  assert.equal(res.code, 503); assert.equal(res.body.ok, false);
});
