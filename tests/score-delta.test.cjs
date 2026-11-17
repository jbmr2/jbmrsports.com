const test = require('node:test');
const assert = require('node:assert/strict');
const { createStream } = require('../lib/score-delta.cjs');
const source = 'a'.repeat(32);
function state(runs = 115, ball = true) {
  return { [source]: { tables: {
    matches: { 18: { id: 18, status: 'live' } },
    innings: { 3: { id: 3, number: 3, state: { runs, wickets: 2 } } },
    balls: ball ? { 6: { id: 6, event: { bat_runs: 4 } } } : {},
    players: Object.fromEntries(Array.from({length: 1000}, (_, id) => [id,{id,name:'Player '+id,photo_url:'https://example.com/'+id}]))
  } } };
}
test('new viewer gets baseline; one changed score excludes unchanged players and history', () => {
  const stream = createStream(), initial = stream(state());
  assert.equal(initial.type,'score_state'); assert.equal(initial.version,1);
  assert.equal(stream(state()),null);
  const delta = stream(state(119));
  assert.equal(delta.baseVersion,1); assert.equal(delta.version,2);
  assert.equal(delta.changes.length,1); assert.equal(delta.changes[0].table,'innings');
  assert.ok(JSON.stringify(delta).length < JSON.stringify(initial).length / 100);
  assert.equal(stream.state().version,2);
  console.log(JSON.stringify({baselineBytes:Buffer.byteLength(JSON.stringify(initial)),deltaBytes:Buffer.byteLength(JSON.stringify(delta))}));
});
test('undo, innings transition, visibility removal and process restart are explicit',()=>{
 const stream=createStream(); const first=stream(state());
 const undo=stream(state(111,false));
 assert.equal(undo.changes.find(x=>x.table==='balls').remove[0],'6');
 const changed=state(111,false);changed[source].tables.innings[4]={id:4,number:4,state:{runs:0}};
 assert.equal(stream(changed).changes[0].upsert[0].number,4);
 assert.deepEqual(stream({}).removedSources,[source]);
 assert.notEqual(createStream()(state()).epoch,first.epoch);
});
