const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveMappedPlayerKeys } = require('../lib/my-performance-api.cjs');
const { applyPlayerDirectory, ownsBall, performancePackages, selectClip } = require('../lib/shorts.cjs');
function archive(source = 'scorer-a') {
  return { installation_id: source, tables: {
    matches: [{ id: 1, tournament_id: 9 }], innings: [{ id: 1, match_id: 1 }],
    balls: [{ id: 1, innings_id: 1, striker_id: 11, bowler_id: 12, seq: 1, event: { bat_runs: 4 }, clip_status: 'ready', clip: { url: 'https://example.invalid/a.mp4' } }],
    players: [{ id: 11, player_uid: 'player-a', phone: '0000000001', performance_phone: '0000000001', download_phone: '0000000001' }]
  } };
}
const rules = { tournaments: { 9: { show: true } } };
test('analytics, clips and downloads reject stale archive phones and phone-shaped IDs', () => {
  const a = archive(); applyPlayerDirectory(a.tables, {}, {});
  assert.equal(resolveMappedPlayerKeys({ archives: [a], verifiedPhone: '0000000001' }).size, 0);
  assert.equal(ownsBall(a.tables, '1', '1', '0000000001'), false);
  assert.equal(performancePackages([a], '0000000001', rules).length, 0);
  const b = archive(); b.tables.players[0].id = '0000000001'; b.tables.balls[0].striker_id = '0000000001';
  applyPlayerDirectory(b.tables, {}, {});
  assert.equal(ownsBall(b.tables, '1', '1', '0000000001'), false);
});
test('directory UID and explicit reassignment/revocation give consistent ownership', () => {
  const directory = [{ player_id: 11, public_player_uid: 'player-a', phone: '0000000001' }];
  for (const [links, expected] of [[{}, '0000000001'], [{11:{phone:'0000000002'}}, '0000000002'], [{11:{phone:''}}, null], [{11:{phone:'invalid'}}, null]]) {
    const a = archive(); applyPlayerDirectory(a.tables, directory, links);
    for (const number of ['0000000001', '0000000002']) {
      const keys = resolveMappedPlayerKeys({ archives: [a], verifiedPhone: number, playerDirectory: {'scorer-a':directory}, playerDownloadLinks: {'scorer-a':links} });
      assert.equal(keys.size > 0, number === expected);
      assert.equal(ownsBall(a.tables,'1','1',number), number === expected);
      assert.equal(performancePackages([a],number,rules).length > 0, number === expected);
    }
  }
  const a = archive(); directory[0].public_player_uid = 'wrong'; applyPlayerDirectory(a.tables, directory, {});
  assert.equal(ownsBall(a.tables,'1','1','0000000001'),false);
});
test('conflicting directory phone mappings are denied rather than granting two owners', () => {
  const a = archive();
  const directory = [{player_id:11,public_player_uid:'player-a',phone:'0000000001'}, {player_id:11,public_player_uid:'player-a',phone:'0000000002'}];
  applyPlayerDirectory(a.tables,directory,{});
  for (const number of ['0000000001','0000000002']) {
    assert.equal(ownsBall(a.tables,'1','1',number),false);
    assert.equal(resolveMappedPlayerKeys({archives:[a],verifiedPhone:number,playerDirectory:{'scorer-a':directory}}).size,0);
  }
});
test('same numeric match IDs in different scorers cannot collapse performance packages or select the wrong clip', () => {
  const a = archive(), b = archive('scorer-b');
  const directory = [{player_id:11,public_player_uid:'player-a',phone:'0000000001'}];
  for (const x of [a,b]) applyPlayerDirectory(x.tables,directory,{});
  const packages = performancePackages([a,b], '0000000001',rules);
  assert.equal(packages.length,4); assert.equal(new Set(packages.map(p=>p.id)).size,4);
  assert.equal(selectClip([a,b],'rtdb-ball-1-1',rules,'0000000001'),null);
  assert.equal(selectClip([a,{...b,tables:{...b.tables,balls:[]}}],'rtdb-ball-1-1',rules),null);
  assert.ok(selectClip([a,structuredClone(a)],'rtdb-ball-1-1',rules));
});
