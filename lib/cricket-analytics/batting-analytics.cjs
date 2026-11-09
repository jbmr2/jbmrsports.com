'use strict';
const { ratio } = require('./cricket-utils.cjs');
function battingInnings(match, innings) {
  const stats = new Map();
  if (!innings.events.length) return [];
  const ensure = playerKey => {
    if (!stats.has(playerKey)) stats.set(playerKey, { playerKey, matchUid: match.uid, inningsId: innings.id, oppositionTeamKey: innings.bowlingTeamKey, runs: 0, ballsFaced: 0, fours: 0, sixes: 0, dotBalls: 0, out: false, retirement: null, powerplayRuns: 0, middleOversRuns: 0, deathOversRuns: 0 });
    return stats.get(playerKey);
  };
  // Non-strikers can finish not-out or be run out without ever facing a ball.
  for (const p of innings.initialBatters) ensure(p);
  for (const e of innings.events) {
    const row = ensure(e.batter); ensure(e.nonStriker);
    row.runs += e.batRuns; row.ballsFaced += Number(e.faced);
    row.fours += Number(e.boundary === 4); row.sixes += Number(e.boundary === 6);
    row.dotBalls += Number(e.faced && e.batRuns === 0);
    row[{ powerplay: 'powerplayRuns', middle: 'middleOversRuns', death: 'deathOversRuns' }[e.phase]] += e.batRuns;
    if (e.outBatter) {
      const out = ensure(e.outBatter);
      out.out ||= e.wicket;
      if (e.dismissal === 'retiredhurt') out.retirement = 'retired hurt';
      if (e.dismissal === 'retiredout') out.retirement = 'retired out';
    }
  }
  return [...stats.values()].map(row => ({ ...row, notOut: !row.out, strikeRate: ratio(row.runs, row.ballsFaced, 100) }));
}
function summarizeBatting(innings, matches = null) {
  const sum = field => innings.reduce((n, r) => n + r[field], 0);
  const runs = sum('runs'), balls = sum('ballsFaced'), outs = innings.filter(r => r.out).length;
  const best = [...innings].sort((a, b) => b.runs - a.runs || Number(b.notOut) - Number(a.notOut))[0];
  return {
    matches, matchesBatted: new Set(innings.map(r => r.matchUid)).size, innings: innings.length,
    runs, ballsFaced: balls, notOuts: innings.length - outs, dismissals: outs,
    average: ratio(runs, outs), strikeRate: ratio(runs, balls, 100),
    highestScore: best ? { runs: best.runs, notOut: best.notOut, matchUid: best.matchUid, inningsId: best.inningsId } : null,
    fours: sum('fours'), sixes: sum('sixes'), dotBalls: sum('dotBalls'),
    thirties: innings.filter(r => r.runs >= 30 && r.runs < 50).length,
    fifties: innings.filter(r => r.runs >= 50 && r.runs < 100).length,
    hundreds: innings.filter(r => r.runs >= 100).length,
    ducks: innings.filter(r => r.out && r.runs === 0).length,
    boundaryPercentage: ratio(sum('fours') * 4 + sum('sixes') * 6, runs, 100),
    powerplayRuns: sum('powerplayRuns'), middleOversRuns: sum('middleOversRuns'), deathOversRuns: sum('deathOversRuns')
  };
}
module.exports = { battingInnings, summarizeBatting };
