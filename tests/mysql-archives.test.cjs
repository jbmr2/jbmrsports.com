'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validate, read } = require('../lib/mysql-archives.cjs');
function fixture(status='completed') { return { installation_id:'a'.repeat(32),archive_manifest:{match_uid:'unique',match_id:90,ball_record_count:1,innings_record_count:1},tables:{
  matches:[{id:90,match_uid:'unique',status,tournament_id:6}],innings:[{id:1,match_id:90,number:4}],balls:[{id:1,innings_id:1,runs:4}]
} }; }
test('completed MySQL archive preserves fourth innings and derives missing tournament',()=>{
  const result=validate(JSON.stringify(fixture())); assert.equal(result.tables.innings[0].number,4); assert.equal(result.archive_manifest.tournament_id,6);
});
test('live or innings break snapshots are not published as immutable final history',()=>{
  for(const status of ['live','innings_break','upcoming'])assert.equal(validate(fixture(status)),null);
});
test('identity and record count mismatches fail explicitly',()=>{
  for(const change of [p=>p.archive_manifest.match_uid='other',p=>p.archive_manifest.ball_record_count=2,p=>p.tables.innings=[],p=>p.tables.balls.push({...p.tables.balls[0]})]){
    const p=fixture();change(p);assert.throws(()=>validate(p));
  }
});
test('reader isolates invalid archives with diagnostics and never calls a write',async()=>{
  const bad=fixture();bad.archive_manifest.match_id=91;const errors=[];
  const result=await read({pool:()=>({execute:async(sql,args)=>{
    assert.ok(sql.startsWith('SELECT'));assert.deepEqual(args,['migrated_archives']);
    return [[{path:'migrated_archives/good',body:JSON.stringify(fixture())},{path:'migrated_archives/live',body:JSON.stringify(fixture('live'))},{path:'migrated_archives/bad',body:JSON.stringify(bad)}]];
  }}),onInvalidArchive:e=>errors.push(e)});
  assert.equal(result.length,1);assert.equal(errors.length,1);
});
