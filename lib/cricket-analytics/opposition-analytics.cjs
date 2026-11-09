'use strict';
const { summarizeBatting } = require('./batting-analytics.cjs');
const { summarizeBowling } = require('./bowling-analytics.cjs');
function oppositionAnalytics(batting, bowling) {
  const keys = [...new Set([...batting, ...bowling].map(r => r.oppositionTeamKey))].sort();
  return keys.map(oppositionTeamKey => {
    const bat = summarizeBatting(batting.filter(r => r.oppositionTeamKey === oppositionTeamKey));
    const bowl = summarizeBowling(bowling.filter(r => r.oppositionTeamKey === oppositionTeamKey));
    return { oppositionTeamKey, runs: bat.runs, wickets: bowl.wickets, battingAverage: bat.average, strikeRate: bat.strikeRate, bowlingEconomy: bowl.economy, highestScore: bat.highestScore, bestBowling: bowl.bestBowling, batting: bat, bowling: bowl };
  });
}
module.exports = { oppositionAnalytics };
