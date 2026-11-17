'use strict';
const { randomUUID } = require('node:crypto');
function normalized(scorers) {
  const result = {};
  for (const [source, payload] of Object.entries(scorers || {})) {
    result[source] = { installation_id: source, tables: {} };
    for (const [table, rows] of Object.entries(payload.tables || {})) {
      result[source].tables[table] = Object.fromEntries(Object.values(rows || {}).map(row => [String(row.id), row]));
    }
  }
  return result;
}
function createStream() {
  let previous, version = 0;
  const epoch = randomUUID();
  const update = scorers => {
    const next = normalized(scorers);
    if (!previous) {
      previous = next;
      return { type: 'score_state', epoch, version: ++version, scorers: next };
    }
    const changes = [], removedSources = Object.keys(previous).filter(source => !next[source]);
    for (const [source, payload] of Object.entries(next)) {
      for (const table of new Set([...Object.keys(payload.tables), ...Object.keys(previous[source]?.tables || {})])) {
        const oldRows = previous[source]?.tables[table] || {}, rows = payload.tables[table] || {};
        const upsert = Object.values(rows).filter(row => JSON.stringify(oldRows[String(row.id)]) !== JSON.stringify(row));
        const remove = Object.keys(oldRows).filter(id => !Object.hasOwn(rows, id));
        if (upsert.length || remove.length) changes.push({ source, table, upsert, remove });
      }
    }
    if (!changes.length && !removedSources.length) return null;
    previous = next;
    return { type: 'score_delta', epoch, baseVersion: version, version: ++version, changes, removedSources };
  };
  update.state = () => previous ? { type: 'score_state', epoch, version, scorers: previous } : null;
  return update;
}
module.exports = { createStream };
