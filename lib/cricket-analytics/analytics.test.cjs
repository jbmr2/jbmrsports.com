'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeArchives, analyzeFirestore } = require('./index.cjs');
const { summarizeBatting } = require('./batting-analytics.cjs');
const { summarizeBowling } = require('./bowling-analytics.cjs');
const { AnalyticsError } = require('./cricket-utils.cjs');

// Synthetic fixture only: no personal data, Firebase access or production mutations.
// The builder records a sequence and its score states; expected stats below are hand calculated.
function fixture(specs = [], uid = 'test-match') {
  let score = { runs: 0, wickets: 0, legal_balls: 0 };
  const balls = specs.map((s, n) => {
    const event = { bat_runs: 0, completed_runs: 0, wide_runs: 0, noball_runs: 0, bye_runs: 0, legbye_runs: 0, penalty_runs: 0, dead_ball: false, details_pending: false, dismissal: '', out_batter_id: null, ...s.event };
    const legal = !(event.wide_runs || event.noball_runs || event.dead_ball || ['retired hurt', 'retired out', 'timed out'].includes(event.dismissal));
    const runs = event.bat_runs + event.wide_runs + event.noball_runs + event.bye_runs + event.legbye_runs + event.penalty_runs;
    const before = { ...score };
    score = { runs: score.runs + runs, wickets: score.wickets + Number(Boolean(event.dismissal) && event.dismissal !== 'retired hurt'), legal_balls: score.legal_balls + Number(legal) };
    return { id: n + 1, innings_id: 1, seq: n + 1, striker_id: s.striker ?? 1, non_striker_id: s.nonStriker ?? 2, bowler_id: s.bowler ?? 4, legal, runs, event, state_before: before, state_after: { ...score } };
  });
  return { installation_id: 'test-scorer', tables: {
    matches: [{ id: 1, match_uid: uid, status: 'COMPLETED', team_a_id: 'A', team_b_id: 'B', tournament_id: 'T', total_overs: 20 }],
    teams: [{ id: 'A', name: 'Alpha' }, { id: 'B', name: 'Beta' }],
    players: [1, 2, 3, 4, 5, 6].map(id => ({ id, name: `Player ${id}`, team_id: id <= 3 ? 'A' : 'B' })),
    match_lineups: [1, 2, 3, 4, 5, 6].map(player_id => ({ match_id: 1, player_id, team_id: player_id <= 3 ? 'A' : 'B' })),
    innings: [{ id: 1, number: 1, match_id: 1, batting_team_id: 'A', bowling_team_id: 'B', completed: true, initial_state: { runs: 0, wickets: 0, legal_balls: 0, striker_id: 1, non_striker_id: 2 }, state: score }], balls
  } };
}
const p = (out, pid) => out.players.find(p => p.playerId === String(pid));
function rejects(archive, code, options) {
  assert.throws(() => analyzeArchives([archive], options), err => err instanceof AnalyticsError && err.code === code);
}

test('manual: wides, no-balls, byes, leg-byes, boundaries, non-striker runout and bowled', () => {
  const a = fixture([
    { event: { bat_runs: 4 } },
    { event: { wide_runs: 2 } },
    { event: { bat_runs: 6, noball_runs: 1 } },
    { event: { bye_runs: 2 } },
    { event: { legbye_runs: 1 } },
    { event: { dismissal: 'runout', out_batter_id: 2 } },
    { nonStriker: 3, event: { dismissal: 'bowled', out_batter_id: 1 } }
  ]);
  const out = analyzeArchives([a]), bat = p(out, 1).batting, bowl = p(out, 4).bowling;
  assert.equal(bat.runs, 10); assert.equal(bat.ballsFaced, 6); assert.equal(bat.average, 10);
  assert.equal(bat.strikeRate, 166.666667); assert.equal(bat.fours, 1); assert.equal(bat.sixes, 1);
  assert.equal(bat.dotBalls, 4); assert.equal(bat.boundaryPercentage, 100);
  assert.equal(p(out, 2).batting.ducks, 1); assert.equal(p(out, 2).batting.ballsFaced, 0);
  assert.equal(p(out, 3).batting.notOuts, 1);
  assert.equal(bowl.legalBalls, 5); assert.equal(bowl.overs, '0.5'); assert.equal(bowl.runsConceded, 13);
  assert.equal(bowl.wickets, 1); assert.equal(bowl.economy, 15.6); assert.equal(bowl.average, 13);
  assert.equal(bowl.strikeRate, 5); assert.equal(bowl.wides, 2); assert.equal(bowl.noBalls, 1);
  assert.equal(bowl.dotBalls, 2); assert.equal(bowl.maidens, 0);
  assert.equal(out.headToHead[0].dismissals, 1); assert.equal(out.headToHead[0].runs, 10);
  assert.equal(out.headToHead[0].ballsFaced, 6);
  assert.equal(p(out, 1).opposition[0].runs, 10);
  assert.equal(p(out, 4).opposition[0].wickets, 1);
  assert.deepEqual(out.reconciliation[0].calculated, { runs: 16, wickets: 2, legalBalls: 5 });
});

test('zero denominators return null, not infinity or a fabricated zero', () => {
  const out = analyzeArchives([fixture([{ event: { wide_runs: 1 } }])]);
  assert.equal(p(out, 1).batting.average, null);
  assert.equal(p(out, 1).batting.strikeRate, null);
  assert.equal(p(out, 1).batting.boundaryPercentage, null);
  assert.equal(p(out, 4).bowling.economy, null);
  assert.equal(p(out, 4).bowling.average, null);
  assert.equal(p(out, 3).batting.highestScore, null);
});

test('complete maiden excludes byes from conceded; partial and shared overs are not maidens', () => {
  const a = fixture(Array.from({ length: 7 }, (_, n) => ({ event: n === 0 ? { bye_runs: 2 } : {} })));
  assert.equal(p(analyzeArchives([a]), 4).bowling.maidens, 1);
  a.tables.balls[3].bowler_id = 5;
  const out = analyzeArchives([a]);
  assert.equal(p(out, 4).bowling.maidens, 0); assert.equal(p(out, 5).bowling.maidens, 0);
});

test('wide/no-ball costs prevent a maiden', () => {
  const out = analyzeArchives([fixture([{ event: { wide_runs: 1 } }, ...Array(6).fill({})])]);
  assert.equal(p(out, 4).bowling.maidens, 0);
});

test('retired hurt is not out; retired out counts as dismissal but not bowler wicket', () => {
  const hurt = analyzeArchives([fixture([{ event: { bat_runs: 2 } }, { event: { dismissal: 'retired hurt', out_batter_id: 1 } }, { striker: 3 }])]);
  assert.equal(p(hurt, 1).batting.notOuts, 1); assert.equal(p(hurt, 1).batting.ballsFaced, 1);
  assert.equal(p(hurt, 4).bowling.wickets, 0);
  const out = analyzeArchives([fixture([{ event: { dismissal: 'retired out', out_batter_id: 1 } }])]);
  assert.equal(p(out, 1).batting.ducks, 1); assert.equal(p(out, 4).bowling.wickets, 0);
  assert.equal(out.headToHead.length, 0);
});

test('retired-hurt batter may return without a second innings or double not-out', () => {
  const out = analyzeArchives([fixture([{ event: { dismissal: 'retired hurt', out_batter_id: 1 } }, { striker: 3, event: { bat_runs: 1 } }, { striker: 1, event: { bat_runs: 4 } }])]);
  assert.equal(p(out, 1).batting.innings, 1); assert.equal(p(out, 1).batting.runs, 4);
});

test('dismissal classification handles all supported bowler and non-bowler wicket types', () => {
  for (const type of ['bowled', 'caught', 'lbw', 'stumped', 'hit wicket', 'caught behind', 'caught and bowled']) {
    assert.equal(p(analyzeArchives([fixture([{ event: { dismissal: type, out_batter_id: 1 } }])]), 4).bowling.wickets, 1);
  }
  for (const type of ['runout', 'obstructing the field', 'hit ball twice', 'handled ball', 'timed out']) {
    const out = analyzeArchives([fixture([{ event: { dismissal: type, out_batter_id: 1 } }])]);
    assert.equal(p(out, 4).bowling.wickets, 0); assert.equal(p(out, 1).batting.dismissals, 1);
  }
});

test('stumping from a wide credits wicket without ball faced or legal delivery', () => {
  const out = analyzeArchives([fixture([{ event: { wide_runs: 1, dismissal: 'stumped', out_batter_id: 1 } }])]);
  assert.equal(p(out, 4).bowling.wickets, 1); assert.equal(p(out, 1).batting.ballsFaced, 0);
});

test('no-ball and free-hit cannot credit a caught wicket', () => {
  rejects(fixture([{ event: { noball_runs: 1, dismissal: 'caught', out_batter_id: 1 } }]), 'ILLEGAL_BOWLER_WICKET');
  const a = fixture([{ event: { dismissal: 'caught', out_batter_id: 1 } }]); a.tables.balls[0].state_before.free_hit = true;
  rejects(a, 'ILLEGAL_BOWLER_WICKET');
});

test('custom phases use legal balls, including illegal deliveries at phase edges', () => {
  const a = fixture([...Array(6).fill({ event: { bat_runs: 1 } }), { event: { noball_runs: 1, bat_runs: 4 } }, ...Array(6).fill({ event: { bat_runs: 1 } }), { event: { bat_runs: 6 } }]);
  const out = analyzeArchives([a], { format: { maxOvers: 3, ballsPerOver: 6, powerplayOvers: 1, deathOvers: 1 } });
  assert.equal(p(out, 1).batting.powerplayRuns, 6); assert.equal(p(out, 1).batting.middleOversRuns, 10); assert.equal(p(out, 1).batting.deathOversRuns, 6);
});

test('milestones and ducks are exclusive; highest score prefers not-out on tie', () => {
  const rows = [0, 30, 49, 50, 99, 100, 150, 150].map((runs, i) => ({ runs, ballsFaced: 10, fours: 0, sixes: 0, dotBalls: 0, powerplayRuns: runs, middleOversRuns: 0, deathOversRuns: 0, out: i < 7, notOut: i === 7, matchUid: String(i), inningsId: '1' }));
  const s = summarizeBatting(rows);
  assert.equal(s.thirties, 2); assert.equal(s.fifties, 2); assert.equal(s.hundreds, 3); assert.equal(s.ducks, 1);
  assert.equal(s.highestScore.notOut, true); assert.equal(s.notOuts, 1);
});

test('best bowling wickets first, then fewer runs; exclusive hauls and 5+', () => {
  const rows = [2, 3, 4, 5, 6, 6].map((wickets, i) => ({ wickets, runsConceded: 20 - i, legalBalls: 12, ballsPerOver: 6, dotBalls: 0, maidens: 0, wides: 0, noBalls: 0, wideDeliveries: 0, noBallDeliveries: 0, matchUid: String(i), inningsId: '1' }));
  const s = summarizeBowling(rows);
  assert.equal(s.bestBowling.wickets, 6); assert.equal(s.bestBowling.runsConceded, 15);
  assert.equal(s.twoWicketHauls, 1); assert.equal(s.threeWicketHauls, 1); assert.equal(s.fourWicketHauls, 1); assert.equal(s.fivePlusWicketHauls, 3);
});

test('opposition and head-to-head aggregate two matches without merging player IDs', () => {
  const out = analyzeArchives([fixture([{ event: { bat_runs: 4 } }], 'm1'), fixture([{ event: { bat_runs: 6 } }], 'm2')]);
  assert.equal(p(out, 1).batting.runs, 10); assert.equal(p(out, 1).batting.matches, 2);
  assert.equal(out.headToHead[0].matches, 2); assert.equal(out.headToHead[0].strikeRate, 500);
  assert.equal(p(out, 1).opposition[0].highestScore.runs, 6);
});

test('pure deterministic idempotence: repeat archive ignored; input order and table order irrelevant', () => {
  const a = fixture([{ event: { bat_runs: 1 } }], 'm1'), b = fixture([{ event: { bat_runs: 2 } }], 'm2');
  const snapshot = JSON.stringify(a), one = analyzeArchives([a, b]);
  assert.deepEqual(one, analyzeArchives([b, a, a])); assert.equal(JSON.stringify(a), snapshot);
  const reversed = structuredClone(a); reversed.tables.players.reverse(); reversed.tables.balls.reverse();
  assert.deepEqual(analyzeArchives([a]), analyzeArchives([reversed]));
});

test('same numeric player ID in a different scorer namespace stays separate', () => {
  const a = fixture([{}], 'm1'), b = fixture([{}], 'm2'); b.installation_id = 'other-scorer';
  assert.equal(analyzeArchives([a, b]).coverage.players, 12);
});

test('unknown participation is explicit and team changes preserve history', () => {
  const a = fixture([{}]); a.tables.match_lineups = [];
  const out = analyzeArchives([a]);
  assert.equal(p(out, 3).matchesPlayed, null); assert.equal(p(out, 1).matchesPlayed, 1);
  assert.equal(out.warnings[0].code, 'LINEUP_UNAVAILABLE');
  const b = fixture([{}], 'second');
  b.tables.matches[0].team_a_id = 'C'; b.tables.teams[0].id = 'C'; b.tables.teams[0].name = 'New team';
  b.tables.players.filter(p => p.team_id === 'A').forEach(p => { p.team_id = 'C'; });
  b.tables.match_lineups.filter(p => p.team_id === 'A').forEach(p => { p.team_id = 'C'; });
  b.tables.innings[0].batting_team_id = 'C';
  assert.equal(new Set(p(analyzeArchives([a, b]), 1).teamHistory.map(t => t.teamId)).size, 2);
});

test('validation rejects missing fields, sequences, invalid references and unsupported events', () => {
  const cases = [
    ['INVALID_NUMBER', a => delete a.tables.balls[0].event.bat_runs],
    ['MISSING_EVENT', a => delete a.tables.balls[0].event],
    ['INVALID_PLAYER', a => a.tables.balls[0].bowler_id = 99],
    ['MISSING_ID', a => delete a.tables.balls[0].non_striker_id],
    ['SEQUENCE_GAP_OR_DUPLICATE', a => a.tables.balls[0].seq = 2],
    ['INCOMPLETE_EVENT', a => a.tables.balls[0].event.details_pending = true],
    ['UNSUPPORTED_DISMISSAL', a => a.tables.balls[0].event.dismissal = 'mystery'],
    ['INCONSISTENT_LEGAL_DELIVERY', a => a.tables.balls[0].legal = false],
    ['INNINGS_RECONCILIATION_FAILED', a => a.tables.innings[0].state.runs = 10],
    ['PARTIAL_INNINGS', a => a.tables.innings[0].initial_state.runs = 10],
    ['UNSUPPORTED_PENALTY', a => a.tables.balls[0].event.penalty_runs = 5],
    ['UNAPPLIED_CORRECTIONS', a => a.tables.ball_corrections = [{ id: 1 }]],
    ['INCOMPLETE_MATCH', a => a.tables.matches[0].status = 'LIVE']
  ];
  for (const [code, mutate] of cases) { const a = fixture([{}]); mutate(a); rejects(a, code); }
});

test('duplicate/conflicting records fail explicitly', () => {
  const a = fixture([{}]); a.tables.balls.push(structuredClone(a.tables.balls[0])); rejects(a, 'DUPLICATE_BALL');
  const b = fixture([{}]), c = structuredClone(b); c.tables.matches[0].result = 'different';
  assert.throws(() => analyzeArchives([b, c]), /CONFLICTING_ARCHIVE/);
});

test('unknown format requires explicit phases; mixed over sizes do not produce false economy', () => {
  const a = fixture([{}]); a.tables.matches[0].total_overs = 10; rejects(a, 'UNSUPPORTED_PHASES');
  assert.equal(analyzeArchives([a], { format: { powerplayOvers: 3, deathOvers: 2 } }).coverage.matches, 1);
  const b = fixture([{}], 'other');
  const out = analyzeArchives([a, b], { formatForMatch: m => ({ maxOvers: 10, powerplayOvers: 3, deathOvers: 2, ballsPerOver: m.match_uid === 'other' ? 8 : 6 }) });
  assert.equal(p(out, 4).bowling.economy, null); assert.equal(p(out, 4).bowling.overs, null);
});

test('reader service uses manifest chunks through existing reader, without write methods', async () => {
  const a = fixture([{ event: { bat_runs: 4 } }]);
  a.installation_id = '80c7442eb2ca4aeabfb6779128d91b8a';
  const json = JSON.stringify(a), cut = Math.floor(json.length / 2);
  const chunk = (id, json) => ({ id, get: field => field === 'json' ? json : undefined });
  const doc = { id: 'test-match', data: () => ({ match_uid: 'test-match', match_id: 1, status: 'completed', revision: 'r1', chunk_count: 2, installation_id: a.installation_id }), ref: { collection: name => { assert.equal(name, 'revisions'); return { doc: revision => { assert.equal(revision, 'r1'); return { collection: name => { assert.equal(name, 'chunks'); return { get: async () => ({ docs: [chunk('000001', json.slice(cut)), chunk('000000', json.slice(0, cut))] }) }; } }; } }; } } };
  const db = { collection: name => { assert.equal(name, 'match_archives'); return { get: async () => ({ docs: [doc] }) }; } };
  const result = await analyzeFirestore(db);
  assert.equal(result.coverage.ballRecords, 1); assert.equal(result.players.find(p => p.playerId === '1').batting.runs, 4);
});

test('running four is not a boundary; ambiguous overthrows and missing attribution fail', () => {
  const out = analyzeArchives([fixture([{ event: { bat_runs: 4, completed_runs: 4 } }])]);
  assert.equal(p(out, 1).batting.runs, 4); assert.equal(p(out, 1).batting.fours, 0);
  rejects(fixture([{ event: { bat_runs: 4, completed_runs: 1 } }]), 'AMBIGUOUS_BOUNDARY');
  const a = fixture([{ event: { bat_runs: 4 } }]); delete a.tables.balls[0].event.completed_runs;
  rejects(a, 'INVALID_NUMBER');
  a.tables.balls[0].event.boundary = 4;
  assert.equal(p(analyzeArchives([a]), 1).batting.fours, 1);
});

test('zero-delivery innings does not fabricate innings batted', () => {
  const out = analyzeArchives([fixture([])]);
  assert.equal(p(out, 1).batting.innings, 0); assert.equal(p(out, 1).batting.notOuts, 0);
});

test('name changes do not make archive order affect results', () => {
  const a = fixture([{}], 'm1'), b = fixture([{}], 'm2'); b.tables.players[0].name = 'Renamed Player';
  assert.deepEqual(analyzeArchives([a, b]), analyzeArchives([b, a]));
});
