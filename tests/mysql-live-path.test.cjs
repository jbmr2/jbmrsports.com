'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { createStore, decode } = require('../lib/mysql-visibility.cjs');
const mysql = require('../lib/mysql-scoring.cjs');

test('missing or ambiguous migrated visibility fails closed', async () => {
  for (const rows of [[], [{body:'{}'},{body:'{}'}], [{body:'null'}]]) {
    assert.throws(() => decode(rows));
  }
  assert.deepEqual(decode([{body:'{"matches":{}}'}]), { matches: {} });
});
test('visibility changes preserve other rules and use a locked transaction', async () => {
  let saved, committed = 0, rolledBack = 0, released = 0;
  const original = { tournaments: {9:{show:true}}, matches: {2:{show:false}}, settings: {ads:{show:false}} };
  const conn = { beginTransaction: async()=>{}, commit: async()=>committed++, rollback: async()=>rolledBack++, release:()=>released++, execute: async(sql, args)=>{
    if (sql.startsWith('SELECT')) { assert.ok(sql.endsWith('FOR UPDATE')); return [[{namespace:'imported',body:JSON.stringify(original)}]]; }
    assert.equal(args[1],'imported'); saved=JSON.parse(args[0]); return [{affectedRows:1}];
  } };
  const store=createStore(()=>({getConnection:async()=>conn}));
  await store.change('matches','3',true);
  assert.equal(saved.matches[2].show,false); assert.equal(saved.matches[3].show,true);
  assert.deepEqual(saved.tournaments,original.tournaments); assert.equal(saved.settings.ads.show,false);
  assert.equal(committed,1); assert.equal(released,1);
  await assert.rejects(store.change('matches','../../invalid',true)); assert.equal(committed,1); assert.equal(rolledBack,0);
});
test('live production path reads MySQL only and preserves visibility and public projection', async () => {
  const filename=require.resolve('../lib/ott-feed-api.cjs');
  const local=createRequire(filename), module={exports:{}};
  let reads=0, cardReads=0, fail=false;
  const rules={matches:{[`${mysql.SOURCE}:7`]:{show:true}}};
  const payload={installation_id:mysql.SOURCE,tables:{matches:[{id:7,tournament_id:9,team_a_id:1,team_b_id:2,status:'live'}],
    tournaments:[{id:9,name:'Cup',logo_url:'https://example.invalid/logo.png'}], teams:[{id:1,name:'A'},{id:2,name:'B'}],
    innings:[{id:1,match_id:7,number:3,state:{runs:162,wickets:2}}],players:[],balls:[],match_lineups:[]}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,require:name=>{
    if(name.startsWith('firebase')) throw Error('Firebase must not be loaded');
    if(name==='./mysql-scoring.cjs')return {...mysql,
      snapshot:async()=>{reads++;if(fail)throw Error('DB unavailable');return payload;},
      scoreHeads:async(_db, {catalog})=>{assert.equal(catalog,true);cardReads++;return payload;}};
    if(name==='./mysql-match-identity.cjs')return {visibility:async(_payload,rules)=>rules};
    if(name==='./mysql-visibility.cjs')return {read:async()=>rules};
    return local(name);
  }});
  const result=await module.exports.productionData();
  assert.equal(reads,1); assert.equal(result.scorers[mysql.SOURCE].tables.innings[1].state.runs,162);
  assert.equal(result.feed.tournaments[`${mysql.SOURCE}:9`].logoUrl,'https://example.invalid/logo.png');
  const card = result.feed.tournaments[`${mysql.SOURCE}:9`].matches[`${mysql.SOURCE}:7`];
  assert.equal(card.innings[0].inningsNumber, 3);
  assert.equal(card.innings[0].runs, 162);
  assert.equal(card.innings[0].wickets, 2);
  fail=true;
  const fallback = await module.exports.productionData(undefined, { summaryOnly: true });
  assert.equal(cardReads,1);
  assert.equal(fallback.feed.tournaments[`${mysql.SOURCE}:9`].matches[`${mysql.SOURCE}:7`].innings[0].runs,162);
  fail=false;
  rules.matches[`${mysql.SOURCE}:7`].show=false;
  assert.equal(Object.keys((await module.exports.productionData()).feed.tournaments).length,0);
  fail=true; await assert.rejects(module.exports.productionData(),/DB unavailable/);
});
