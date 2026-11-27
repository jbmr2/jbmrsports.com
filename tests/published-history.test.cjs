'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { read, readForPlayerAnalytics } = require('../lib/published-history.cjs');
const { publishedArchives } = require('../lib/public-archives.cjs');
const { resolveMappedPlayerKeys, scopedPlayerKey } = require('../lib/player-ownership.cjs');

const current = 'a'.repeat(32), legacy = 'b'.repeat(32);
const number = '0000000001';
const match = { id: 21, match_uid: 'verified-match', tournament_id: 4, status: 'completed', team_a_id: 1, team_b_id: 2 };
const innings = [{ id: 3, match_id: 21, number: 1, batting_team_id: 1, state: { runs: 4, wickets: 0 } }];
const players = [{ id: 8, name: 'Batter', player_uid: 'stable-8' }];
const balls = [{ id: 5, innings_id: 3, striker_id: 8, event: { bat_runs: 4 } }];
const makePayload = source => ({ installation_id: source, archive_manifest: { match_id: 21, match_uid: match.match_uid },
  tables: { matches: [match], innings, balls, players } });

test('currently published MySQL completion is served even with an empty migrated archive', async () => {
  const requested = [];
  const result = await read({ readArchive: async () => [],
    readScores: async () => ({ installation_id: current, tables: { matches: [match, { ...match, id: 22, match_uid: 'hidden' }] } }),
    readVisibility: async () => ({ matches: { [`${current}:21`]: { show: true } } }), resolve: async (_, rules) => rules,
    readMatch: async id => { requested.push(id); return makePayload(current); } });
  const output = result.selected.flatMap(item => publishedArchives([item.payload], item.rules));
  assert.deepEqual(requested, ['21']);
  assert.equal(output[0].tables.balls[0].event.bat_runs, 4);
  assert.equal(result.diagnostics.currentCompleted, 2);
  assert.equal(result.diagnostics.completedReturned, 1);
});

test('private My Performance history includes completed MySQL matches hidden from public feeds', async () => {
  let visibilityReads = 0;
  const result = await readForPlayerAnalytics({
    readArchive: async () => [makePayload(legacy)],
    readScores: async () => ({ installation_id: current, tables: { matches: [match] } }),
    readVisibility: async () => { visibilityReads++; throw Error('Player analytics must not depend on publication visibility'); },
    resolve: async () => { throw Error('Player analytics must not resolve public publication rules'); },
    readMatch: async () => makePayload(current)
  });
  assert.equal(visibilityReads, 0);
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].payload.installation_id, current);
  assert.equal(result.selected[0].backups.length, 1);
});

test('same verified legacy match recovers ownership but current hides and revocations are honored', async () => {
  const rules = { matches: { [`${current}:21`]: { show: true }, [`${legacy}:21`]: { show: true } } };
  const get = () => read({ readArchive: async () => [makePayload(legacy)], readScores: async () => makePayload(current),
    readVisibility: async () => rules, resolve: async (_, visibility) => visibility,
    readMatch: async () => makePayload(current) });
  const result = await get();
  assert.equal(result.selected.length, 1);
  const [{ payload, backups }] = result.selected;
  const options = { archives: [{ ...payload, ownershipBackups: backups }], verifiedPhone: number,
    playerDirectory: { [legacy]: [{ player_id: 8, public_player_uid: 'stable-8', mobile: number }] } };
  assert.deepEqual([...resolveMappedPlayerKeys(options)], [scopedPlayerKey(current, 8)]);
  assert.equal(resolveMappedPlayerKeys({ ...options, playerDownloadLinks: { [legacy]: { 8: { phone: '' } } } }).size, 0);
  assert.equal(resolveMappedPlayerKeys({ ...options, verifiedPhone: '0000000002' }).size, 0);
  rules.matches[`${current}:21`].show = false;
  assert.equal((await get()).selected.length, 0);
});

test('the current scorer registry uses public_uid and cannot be replaced by archived contact data', async () => {
  const { playerDirectory } = require('../lib/mysql-scoring.cjs');
  const directory = await playerDirectory({ query: async () => [[{ id: 8, public_uid: 'stable-8', mobile: number }]] });
  const archive = makePayload(current);
  archive.tables.players = [{ id: 8, public_uid: 'stable-8', mobile: '0000000002' }];
  const args = { archives: [archive], verifiedPhone: number, playerDirectory: { [current]: directory } };
  assert.deepEqual([...resolveMappedPlayerKeys(args)], [scopedPlayerKey(current, 8)]);
  assert.equal(resolveMappedPlayerKeys({ ...args, verifiedPhone: '0000000002' }).size, 0);
  assert.equal(resolveMappedPlayerKeys({ ...args, playerDownloadLinks: { [current]: { 8: { phone: '' } } } }).size, 0);
});
