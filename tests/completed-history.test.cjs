'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { read } = require('../lib/completed-history.cjs');

test('migrated completed history remains available during a Firestore outage', async () => {
  const complete = { installation_id: 'scorer', archive_manifest: { match_uid: 'fixture-match' } };
  const result = await read({
    firestore: async () => { throw Error('Firestore unavailable'); },
    migrated: async () => [complete]
  });
  assert.deepEqual(result.payloads, [complete]);
  assert.deepEqual(result.diagnostics.partialSources, ['firestore']);
});
