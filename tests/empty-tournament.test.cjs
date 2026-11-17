'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { publicScorers, liveFeed } = require('../lib/ott-feed-api.cjs');
const { resolve } = require('../lib/mysql-match-identity.cjs');
const source = require('../lib/mysql-scoring.cjs').SOURCE;
test('published empty tournament appears; hidden and unset tournaments remain private', () => {
  const payload = { installation_id: source, tables: { tournaments: [
    { id: 11, name: 'Published empty cup', logo_url: 'https://example.org/cup.png' },
    { id: 12, name: 'Hidden cup' }, { id: 13, name: 'Unset cup' }
  ], matches: [] } };
  const rules = { tournaments: { [`${source}:11`]: { show: true }, [`${source}:12`]: { show: false } } };
  const effective = resolve(payload, rules, []);
  const scorers = publicScorers({ [source]: payload }, effective);
  const feed = liveFeed({ scorers });
  assert.deepEqual(Object.keys(feed.tournaments), [`${source}:11`]);
  assert.deepEqual(feed.tournaments[`${source}:11`].matches, {});
  assert.equal(feed.tournaments[`${source}:11`].logoUrl, 'https://example.org/cup.png');
});
