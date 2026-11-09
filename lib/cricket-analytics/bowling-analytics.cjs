'use strict';
const { ratio, overs } = require('./cricket-utils.cjs');
function bowlingInnings(match, innings) {
  const stats = new Map(), overGroups = new Map();
  for (const e of innings.events) {
    if (!e.isDelivery) continue;
    if (!stats.has(e.bowler)) stats.set(e.bowler, { playerKey: e.bowler, matchUid: match.uid, inningsId: innings.id, oppositionTeamKey: innings.battingTeamKey, legalBalls: 0, wickets: 0, runsConceded: 0, dotBalls: 0, maidens: 0, wides: 0, noBalls: 0, wideDeliveries: 0, noBallDeliveries: 0, ballsPerOver: innings.format.ballsPerOver });
    const row = stats.get(e.bowler);
    row.legalBalls += Number(e.legal); row.wickets += Number(e.bowlerWicket);
    row.runsConceded += e.conceded; row.dotBalls += Number(e.legal && e.teamRuns === 0);
    row.wides += e.wide; row.noBalls += e.noBall;
    row.wideDeliveries += Number(e.wide > 0); row.noBallDeliveries += Number(e.noBall > 0);
    if (!overGroups.has(e.over)) overGroups.set(e.over, []);
    overGroups.get(e.over).push(e);
  }
  for (const events of overGroups.values()) {
    if (new Set(events.map(e => e.bowler)).size === 1 && events.filter(e => e.legal).length === innings.format.ballsPerOver && events.every(e => e.conceded === 0)) stats.get(events[0].bowler).maidens++;
  }
  return [...stats.values()].map(row => ({ ...row, overs: overs(row.legalBalls, row.ballsPerOver), economy: ratio(row.runsConceded, row.legalBalls, row.ballsPerOver) }));
}
function summarizeBowling(innings) {
  const sum = field => innings.reduce((n, r) => n + r[field], 0);
  const balls = sum('legalBalls'), runs = sum('runsConceded'), wickets = sum('wickets');
  const sizes = [...new Set(innings.map(r => r.ballsPerOver))];
  // Mixed historical over sizes cannot be represented by a single overs string.
  const size = sizes.length === 1 ? sizes[0] : null;
  const best = [...innings].sort((a, b) => b.wickets - a.wickets || a.runsConceded - b.runsConceded)[0];
  return {
    matchesBowled: new Set(innings.map(r => r.matchUid)).size, inningsBowled: innings.length,
    legalBalls: balls, overs: size ? overs(balls, size) : innings.length ? null : '0.0', ballsPerOver: size,
    wickets, runsConceded: runs, economy: size ? ratio(runs, balls, size) : null,
    average: ratio(runs, wickets), strikeRate: ratio(balls, wickets),
    dotBalls: sum('dotBalls'), maidens: sum('maidens'), wides: sum('wides'), noBalls: sum('noBalls'),
    wideDeliveries: sum('wideDeliveries'), noBallDeliveries: sum('noBallDeliveries'),
    bestBowling: best ? { wickets: best.wickets, runsConceded: best.runsConceded, matchUid: best.matchUid, inningsId: best.inningsId } : null,
    twoWicketHauls: innings.filter(r => r.wickets === 2).length,
    threeWicketHauls: innings.filter(r => r.wickets === 3).length,
    fourWicketHauls: innings.filter(r => r.wickets === 4).length,
    fivePlusWicketHauls: innings.filter(r => r.wickets >= 5).length
  };
}
module.exports = { bowlingInnings, summarizeBowling };
