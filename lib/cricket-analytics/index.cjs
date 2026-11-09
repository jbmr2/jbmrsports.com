'use strict';
const { normalizeArchives, compare, fail } = require('./cricket-utils.cjs');
const { battingInnings, summarizeBatting } = require('./batting-analytics.cjs');
const { bowlingInnings, summarizeBowling } = require('./bowling-analytics.cjs');
const { headToHead } = require('./head-to-head.cjs');
const { oppositionAnalytics } = require('./opposition-analytics.cjs');
function analyzeArchives(archives, options = {}) {
  const { matches, warnings } = normalizeArchives(archives, options);
  const players = new Map(), matchReports = [], reconciliation = [];
  for (const match of matches) {
    for (const p of match.players) {
      if (!players.has(p.playerKey)) players.set(p.playerKey, { ...p, battingInnings: [], bowlingInnings: [], confirmedMatches: new Set(), uncertainMatches: new Set(), teamHistory: [] });
      const row = players.get(p.playerKey);
      row.teamHistory.push({ matchUid: match.uid, teamKey: p.teamKey, teamId: p.teamId, teamName: p.teamName, playerName: p.playerName });
      // A roster row alone never proves selection in the XI.
      if (match.lineup.has(p.playerKey)) row.confirmedMatches.add(match.uid);
      else row.uncertainMatches.add(match.uid);
    }
    const bats = [], bowls = [];
    for (const innings of match.innings) {
      const batting = battingInnings(match, innings), bowling = bowlingInnings(match, innings);
      bats.push(...batting); bowls.push(...bowling);
      for (const row of batting) players.get(row.playerKey).battingInnings.push(row);
      for (const row of bowling) players.get(row.playerKey).bowlingInnings.push(row);
      for (const row of [...batting, ...bowling]) players.get(row.playerKey).confirmedMatches.add(match.uid);
      const sum = (rs, field) => rs.reduce((n, r) => n + r[field], 0);
      const extras = innings.events.reduce((n, e) => n + e.wide + e.noBall + e.bye + e.legBye, 0);
      const nonBowlerWickets = innings.events.filter(e => e.wicket && !e.bowlerWicket).length;
      const actual = { runs: sum(batting, 'runs') + extras, wickets: batting.filter(r => r.out).length, legalBalls: sum(bowling, 'legalBalls') };
      for (const field of ['runs', 'wickets', 'legalBalls']) if (actual[field] !== innings.reconciliation[field]) fail('AGGREGATION_RECONCILIATION_FAILED', match.uid, field);
      if (sum(bowling, 'wickets') + nonBowlerWickets !== actual.wickets) fail('WICKET_RECONCILIATION_FAILED', match.uid, innings.id);
      if (sum(bowling, 'runsConceded') + innings.events.reduce((n, e) => n + e.bye + e.legBye, 0) !== actual.runs) fail('CONCEDED_RECONCILIATION_FAILED', match.uid, innings.id);
      reconciliation.push({ matchUid: match.uid, matchId: match.id, inningsId: innings.id, status: 'PASS', ballRecords: innings.events.length, batterRuns: sum(batting, 'runs'), extras, calculated: actual, archived: { runs: innings.final.runs, wickets: innings.final.wickets, legalBalls: innings.final.legal_balls }, bowlerWickets: sum(bowling, 'wickets'), nonBowlerWickets });
    }
    matchReports.push({ matchUid: match.uid, matchId: match.id, tournamentId: match.tournamentId, result: match.result, format: match.format, players: match.players.map(p => ({ ...p, batting: summarizeBatting(bats.filter(r => r.playerKey === p.playerKey), match.lineup.has(p.playerKey) || [...bats, ...bowls].some(r => r.playerKey === p.playerKey) ? 1 : null), bowling: summarizeBowling(bowls.filter(r => r.playerKey === p.playerKey)), battingInnings: bats.filter(r => r.playerKey === p.playerKey), bowlingInnings: bowls.filter(r => r.playerKey === p.playerKey) })).sort((a, b) => compare(a.playerKey, b.playerKey)) });
  }
  const resultPlayers = [...players.values()].map(p => {
    const unknown = [...p.uncertainMatches].filter(m => !p.confirmedMatches.has(m));
    const { confirmedMatches, uncertainMatches: _uncertainMatches, ...rest } = p;
    // Team membership can change: expose match-scoped history, not a guessed current team.
    delete rest.teamKey; delete rest.teamId; delete rest.teamName;
    return { ...rest, matchesPlayed: unknown.length ? null : confirmedMatches.size, confirmedMatchesPlayed: confirmedMatches.size, uncertainMatchUids: unknown.sort(), batting: summarizeBatting(p.battingInnings, unknown.length ? null : confirmedMatches.size), bowling: summarizeBowling(p.bowlingInnings), opposition: oppositionAnalytics(p.battingInnings, p.bowlingInnings) };
  }).sort((a, b) => compare(a.playerKey, b.playerKey));
  return { schemaVersion: 1, coverage: { matches: matches.length, innings: reconciliation.length, ballRecords: reconciliation.reduce((n, r) => n + r.ballRecords, 0), players: players.size }, warnings, players: resultPlayers, matches: matchReports, headToHead: headToHead(matches), reconciliation };
}
// No database writes, endpoint registration or Firebase credentials in this module.
async function analyzeFirestore(db, options = {}) {
  const { readMatchArchives } = require('../match-archives.cjs');
  return analyzeArchives(await readMatchArchives(db), options);
}
module.exports = { analyzeArchives, analyzeFirestore };
