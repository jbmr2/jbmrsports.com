'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspect } = require('../lib/player-migration-status.cjs');
test('migration status identifies missing and matching roots without returning private data', () => {
  const source = { player_directory: { source: { 1: { phone: 'private' } } }, player_download_links: { source: { 1: { phone: 'private' } } } };
  const status = inspect(source, [{ root: 'player_directory', body: JSON.stringify(source.player_directory) }]);
  assert.equal(status.player_directory.matches, true);
  assert.equal(status.player_download_links.matches, false);
  assert.equal(status.player_download_links.mysqlRootCount, 0);
  assert.equal(JSON.stringify(status).includes('private'), false);
  assert.equal(inspect(source, [{root:'player_directory',body:'{}'},{root:'player_directory',body:'{}'}]).player_directory.matches, false);
});
