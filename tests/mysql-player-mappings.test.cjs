'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { read, decodeRoot } = require('../lib/mysql-player-mappings.cjs');
const { resolveMappedPlayerKeys, scopedPlayerKey } = require('../lib/player-ownership.cjs');

test('current MySQL player record replaces stale phone mapping for that scorer player', async () => {
  const source = 'a'.repeat(32);
  const result = await read({
    scoring: { SOURCE: source, playerDirectory: async () => [
      { player_id: 195, public_player_uid: 'stable-195', mobile: '8295660857' }
    ] },
    appPool: () => ({ execute: async () => [[
      { root: 'player_directory', body: JSON.stringify({ [source]: [{ player_id: 195, public_player_uid: 'stable-195', mobile: '1111111111' }] }) },
      { root: 'player_download_links', body: '{}' }
    ]] })
  });
  assert.deepEqual(result.playerDirectory[source], [
    { player_id: 195, public_player_uid: 'stable-195', mobile: '8295660857' }
  ]);
  const archive = { installation_id: source, tables: { players: [{ id: 195, player_uid: 'stable-195' }] } };
  assert.deepEqual([...resolveMappedPlayerKeys({ archives: [archive], verifiedPhone: '+918295660857', ...result })],
    [scopedPlayerKey(source, 195)]);
});

test('missing optional MySQL mapping roots do not block mapping from current MySQL player profiles', async () => {
  const source = 'b'.repeat(32);
  const result = await read({
    scoring: { SOURCE: source, playerDirectory: async () => [
      { player_id: 195, public_player_uid: 'stable-195', mobile: '8295660857' }
    ] },
    appPool: () => ({ execute: async () => [[]] })
  });
  assert.equal(result.playerDirectory[source][0].mobile, '8295660857');
  assert.deepEqual(result.playerDownloadLinks, {});
});

test('duplicate and malformed MySQL roots fail closed', () => {
  assert.throws(() => decodeRoot([{ root: 'player_directory', body: '{}' }, { root: 'player_directory', body: '{}' }], 'player_directory'), /Duplicate/);
  assert.throws(() => decodeRoot([{ root: 'player_directory', body: '{' }], 'player_directory'));
});
