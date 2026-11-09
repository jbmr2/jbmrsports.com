'use strict';
const { key, compare, ratio } = require('./cricket-utils.cjs');
function headToHead(matches) {
  const pairs = new Map();
  for (const match of matches) for (const innings of match.innings) for (const e of innings.events) {
    if (!e.isDelivery) continue;
    const k = key(e.batter, e.bowler);
    if (!pairs.has(k)) pairs.set(k, { batterKey: e.batter, bowlerKey: e.bowler, runs: 0, ballsFaced: 0, fours: 0, sixes: 0, dotBalls: 0, dismissals: 0, matches: new Set() });
    const row = pairs.get(k);
    row.runs += e.batRuns; row.ballsFaced += Number(e.faced);
    row.fours += Number(e.boundary === 4); row.sixes += Number(e.boundary === 6);
    row.dotBalls += Number(e.faced && e.batRuns === 0);
    row.dismissals += Number(e.bowlerWicket && e.outBatter === e.batter);
    row.matches.add(match.uid);
  }
  return [...pairs.values()].map(r => ({ ...r, matches: r.matches.size, strikeRate: ratio(r.runs, r.ballsFaced, 100) })).sort((a, b) => compare(key(a.batterKey, a.bowlerKey), key(b.batterKey, b.bowlerKey)));
}
module.exports = { headToHead };
