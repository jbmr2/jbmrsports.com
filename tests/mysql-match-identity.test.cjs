'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('../lib/mysql-match-identity.cjs');
const source='3b2b21f1a1374f6892bb66b1a4372640', old='1828191fb9a445a892ce12ae0dc737ee';
const payload={installation_id:source,tables:{matches:[{id:90,match_uid:'unique-match',tournament_id:6}]}};
const migration={source:old,uid:'unique-match',id:'90',tournament:'6'};
const rules={tournaments:{[`${old}:6`]:{show:true}}};
const visible=(r,m)=>resolve(payload,r,m).matches[`${source}:90`].show;
test('verified migrated UID preserves publication across transport namespaces',()=>assert.equal(visible(rules,[migration]),true));
test('numeric collisions, changed tournament and ambiguous source never grant access',()=>{
  for(const rows of [[],[{...migration,uid:'other'}],[{...migration,tournament:'7'}],[migration,{...migration,source:'a'.repeat(32)}]]) assert.equal(visible(rules,rows),false);
});
test('explicit hidden match and parent remain hidden, current admin rules take precedence',()=>{
  assert.equal(visible({...rules,matches:{[`${old}:90`]:{show:false}}},[migration]),false);
  assert.equal(visible({...rules,tournaments:{...rules.tournaments,[`${source}:6`]:{show:false}}},[migration]),false);
  assert.equal(visible({...rules,matches:{[`${source}:90`]:{show:false}}},[migration]),false);
});
