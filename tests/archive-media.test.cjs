const test = require('node:test');
const assert = require('node:assert/strict');
const {preserveArchiveMedia} = require('../lib/archive-media.cjs');
const match = extra => ({id:5,tournament_id:1,team_a_id:2,team_b_id:3,...extra});
const payload = row => ({tables:{matches:[row]}});
test('pending mirror keeps published highlight without replacing score', () => {
  const newer=match({highlight:{status:'pending_upload'},runs:120});
  preserveArchiveMedia([payload(match({highlight:{status:'ready',url:'https://example.com/h.mp4'}})),payload(newer)]);
  assert.equal(newer.highlight_url,'https://example.com/h.mp4');
  assert.equal(newer.runs,120);
});
test('different teams and conflicting match UID never inherit media', () => {
  const a=match({team_b_id:4}), b=match({match_uid:'other'});
  preserveArchiveMedia([payload(match({match_uid:'original',highlight_url:'https://example.com/h.mp4'})),payload(a),payload(b)]);
  assert.equal(a.highlight_url,undefined); assert.equal(b.highlight_url,undefined);
});
test('existing highlight remains authoritative', () => {
  const newer=match({highlight_url:'https://example.com/new.mp4'});
  preserveArchiveMedia([payload(match({highlight_url:'https://example.com/old.mp4'})),payload(newer)]);
  assert.equal(newer.highlight_url,'https://example.com/new.mp4');
});
