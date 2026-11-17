'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { install } = require('../lib/public-archives.cjs');

test('simulator completed history reads the MySQL archive and respects visibility', async () => {
  const source = 'a'.repeat(32), handlers = {};
  const archive = id => ({ installation_id: source, archive_manifest: { match_id: id, match_uid: `uid-${id}` },
    tables: { matches: [{ id, match_uid: `uid-${id}`, tournament_id: 3, status: 'completed' }],
      innings: [], balls: [], players: [], teams: [], tournaments: [], match_lineups: [] } });
  install({ get: (path, ...fns) => { handlers[path] = fns.at(-1); } }, () => {}, {
    archives: () => { throw Error('Legacy archives used'); },
    mysqlArchives: async () => [archive(1), archive(2)],
    visibility: async () => ({ matches: { [`${source}:1`]: { show: true }, [`${source}:2`]: { show: false } } })
  });
  let body;
  const res = { set() { return this; }, json(value) { body = value; return this; }, status() { throw Error('Unexpected error'); } };
  await handlers['/api/scoring-archives']({ simulatorPreview: true }, res);
  assert.equal(body.archives.length, 1);
  assert.equal(body.archives[0].archive_manifest.match_uid, 'uid-1');
});
