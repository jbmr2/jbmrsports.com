'use strict';
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { projectRow } = require('./public-archives.cjs');

function createReader({ read = () => require('./mysql-scoring.cjs').scoreHeads(),
  visibility = () => require('./mysql-visibility.cjs').read(),
  resolve = (data, rules) => require('./mysql-match-identity.cjs').visibility(data, rules),
  now = Date.now } = {}) {
  let rulesCache, pending;
  return async function readHeads() {
    if (pending) return pending;
    pending = (async () => {
      const start = performance.now();
      const data = await read();
      const dbReadMs = performance.now() - start;
      // Publication changes propagate within one second; failed reads do not
      // renew this cache or cause private matches to become public.
      if (!rulesCache || now() - rulesCache.at >= 1000) {
        rulesCache = { rules: await visibility(), at: now() };
      }
      const rules = await resolve(data, rulesCache.rules);
      const { allowsClip } = require('./admin-visibility.cjs');
      const matches = data.tables.matches.filter(row =>
        allowsClip(String(row.id), String(row.tournament_id), rules, data.installation_id));
      const ids = new Set(matches.map(row => String(row.id)));
      const innings = data.tables.innings.filter(row => ids.has(String(row.match_id)));
      const tables = Object.fromEntries(Object.entries({ matches, innings }).map(([name, rows]) =>
        [name, Object.fromEntries(rows.map(row => [String(row.id), projectRow(row, name)]))]));
      const scorers = { [data.installation_id]: { installation_id: data.installation_id, tables } };
      return { scorers, revision: createHash('sha256').update(JSON.stringify(scorers)).digest('hex'),
        observedAt: now(), dbReadMs, readMs: performance.now() - start };
    })().finally(() => { pending = undefined; });
    return pending;
  };
}

// Score heads are authoritative even if an older history request finishes later.
// Only patch an established baseline: a new viewer must get teams/players too.
function mergeHeads(scorers, heads) {
  const result = {};
  for (const [source, payload] of Object.entries(scorers || {})) {
    const head = heads?.[source];
    if (!head) continue;
    const tables = { ...payload.tables, matches: head.tables.matches, innings: head.tables.innings };
    const matches = new Set(Object.keys(tables.matches));
    const innings = new Set(Object.keys(tables.innings));
    for (const [name, key, allowed] of [['balls', 'innings_id', innings], ['match_lineups', 'match_id', matches]]) {
      tables[name] = Object.fromEntries(Object.values(tables[name] || {}).filter(row => allowed.has(String(row[key])))
        .map(row => [String(row.id), row]));
    }
    const teamIDs = new Set(Object.values(tables.matches).flatMap(row => [String(row.team_a_id), String(row.team_b_id)]));
    const tournamentIDs = new Set(Object.values(tables.matches).map(row => String(row.tournament_id)));
    const playerIDs = new Set(Object.values(tables.match_lineups).map(row => String(row.player_id)));
    for (const row of [...Object.values(tables.balls), ...Object.values(tables.innings)]) {
      const nested = row.event || row.state || {};
      for (const id of [row.striker_id, row.non_striker_id, row.bowler_id,
        nested.striker_id, nested.non_striker_id, nested.bowler_id, nested.out_batter_id, nested.fielder_id]) {
        if (id != null) playerIDs.add(String(id));
      }
    }
    for (const [name, allowed] of [['teams', teamIDs], ['tournaments', tournamentIDs], ['players', playerIDs]]) {
      tables[name] = Object.fromEntries(Object.values(tables[name] || {}).filter(row => allowed.has(String(row.id)))
        .map(row => [String(row.id), row]));
    }
    result[source] = { ...payload, tables };
  }
  return result;
}
module.exports = { createReader, mergeHeads };
