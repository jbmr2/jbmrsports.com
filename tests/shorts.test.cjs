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
assert.equal(ownsBall({...tables,players:[{id:1,mobile_number:'9876543210',download_phone:''}]},'7','101','9876543210'),false);
assert.equal(ownsBall({...tables,players:[{id:1,mobile_number:'9876543210',download_phone:'9876543212'}]},'7','101','9876543212'),true);
const rules={tournaments:{9:{show:true}}};
const batting=performancePackages([{tables}],'9876543210',rules).filter(p=>p.category==='innings');assert.equal(batting.length,1);assert.equal(batting[0].runs,6);assert.equal(batting[0].totalClips,4);assert.equal(batting[0].clips.length,2);
const bowling=performancePackages([{tables}],'9876543211',rules);assert.equal(bowling[0].wickets,1);assert.equal(bowling[0].clips.length,1);
assert.equal(performancePackages([{tables}],'9876543210',{tournaments:{9:{show:false}}}).length,0);
assert.equal(performancePackages([{tables},{tables}],'9876543210',rules).length,2);
console.log('Passed: verified phone ownership, cross-match denial, missing-phone denial, batting coverage, wicket attribution, visibility and deduplication');

const {applyPlayerDirectory}=require('../lib/shorts.cjs');
const roster={players:[{id:62,player_uid:'p_correct'}]};
applyPlayerDirectory(roster,[{player_id:62,public_player_uid:'p_wrong',mobile:'919876543210'}]);
assert.equal(roster.players[0].download_phone,undefined);
applyPlayerDirectory(roster,[{player_id:62,public_player_uid:'p_correct',mobile:'919876543210'}]);
assert.equal(roster.players[0].download_phone,'9876543210');
applyPlayerDirectory(roster,[{player_id:62,public_player_uid:'p_correct',mobile:'919876543210'}],{'62':{phone:''}});
assert.equal(roster.players[0].download_phone,'');
console.log('Directory UID matching and override revocation passed');

const boundary=performancePackages([{tables}],'9876543210',rules).find(p=>p.category==='fours');
assert.equal(boundary.totalClips,1);assert.equal(boundary.clips.length,1);assert.equal(boundary.role,'batting');
const bigTables={...tables,balls:[...tables.balls,{id:105,innings_id:10,striker_id:1,bowler_id:2,seq:5,event:{bat_runs:6},clip:{status:'ready',url:'https://example.com/6.mp4'}},{id:106,innings_id:10,striker_id:1,bowler_id:2,seq:6,event:{bat_runs:4}}]};
const special=performancePackages([{tables:bigTables}],'9876543210',rules);
assert.equal(special.find(p=>p.category==='fours').totalClips,2);
assert.equal(special.find(p=>p.category==='fours').clips.length,1);
assert.equal(special.find(p=>p.category==='sixes').clips[0].ballID,'105');
assert.equal(special.filter(p=>p.role==='bowling').length,0);
assert.equal(performancePackages([{tables:bigTables}],'9876543211',rules)[0].category,'wickets');
console.log('Separate innings, fours, sixes and credited-wicket packages passed');

const {selectClip}=require('../lib/shorts.cjs');
const oldMirror={...tables,players:[{id:1,name:'Batter'},{id:2,name:'Bowler'}]};
const selected=selectClip([{tables:oldMirror},{tables}],'rtdb-ball-7-101',rules,'9876543210');
assert.equal(selected.tables,tables);
assert.equal(ownsBall(selected.tables,'7','101','9876543210'),true);
assert.equal(selectClip([{tables:oldMirror},{tables}],'rtdb-ball-7-101',rules).tables,oldMirror);
const stranger=selectClip([{tables:oldMirror},{tables}],'rtdb-ball-7-101',rules,'9876543212');
assert.equal(ownsBall(stranger.tables,'7','101','9876543212'),false);
assert.equal(selectClip([{tables}],'rtdb-ball-8-101',rules,'9876543210'),null);
assert.equal(selectClip([{tables}],'rtdb-ball-7-101',{tournaments:{9:{show:false}}},'9876543210'),null);
console.log('Mirrored clip selection preserves verified ownership and denies other users/hidden matches');
