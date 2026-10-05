const assert = require('node:assert/strict');
const {ownsBall,phone,performancePackages}=require('../lib/shorts.cjs');
const tables={players:[{id:1,name:'Batter',mobile_number:'9876543210'},{id:2,name:'Bowler',phone:'+919876543211'}],matches:[{id:7,tournament_id:9,team_a_id:1,team_b_id:2}],teams:[{id:1,name:'A'},{id:2,name:'B'}],tournaments:[{id:9,name:'Test tournament'}],innings:[{id:10,match_id:7}],balls:[
{id:101,innings_id:10,striker_id:1,bowler_id:2,seq:1,event:{bat_runs:4},clip_status:'ready',clip:{url:'https://example.com/1.mp4'}},
{id:102,innings_id:10,striker_id:1,bowler_id:2,seq:2,event:{bat_runs:2}},
{id:103,innings_id:10,striker_id:1,bowler_id:2,seq:3,event:{dismissal:'bowled',bat_runs:0},kind:'wicket',clip:{status:'ready',url:'https://example.com/3.mp4'}},
{id:104,innings_id:10,striker_id:1,bowler_id:2,seq:4,event:{dismissal:'run_out',bat_runs:0},kind:'wicket'}]};
assert.equal(phone('+91 98765 43210'),'9876543210');assert.equal(phone('87656789876'),'');
assert.equal(ownsBall(tables,'7','101','+919876543210'),true);
assert.equal(ownsBall(tables,'7','101','+919876543211'),true);
assert.equal(ownsBall(tables,'7','101','+919876543212'),false);
assert.equal(ownsBall(tables,'8','101','+919876543210'),false);
assert.equal(ownsBall({...tables,players:[{id:1,name:'Batter'}]},'7','101','+919876543210'),false);
const rules={tournaments:{9:{show:true}}};
const batting=performancePackages([{tables}],'9876543210',rules);assert.equal(batting.length,1);assert.equal(batting[0].runs,6);assert.equal(batting[0].totalClips,4);assert.equal(batting[0].clips.length,2);
const bowling=performancePackages([{tables}],'9876543211',rules);assert.equal(bowling[0].wickets,1);assert.equal(bowling[0].clips.length,1);
assert.equal(performancePackages([{tables}],'9876543210',{tournaments:{9:{show:false}}}).length,0);
assert.equal(performancePackages([{tables},{tables}],'9876543210',rules).length,1);
console.log('Passed: verified phone ownership, cross-match denial, missing-phone denial, batting coverage, wicket attribution, visibility and deduplication');
