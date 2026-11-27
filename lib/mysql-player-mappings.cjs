'use strict';

function decodeRoot(records, name) {
  const found = records.filter(row => row.root === name);
  if (found.length > 1) throw Error(`Duplicate MySQL ${name} mapping`);
  if (!found.length) return {};
  const value = typeof found[0].body === 'string' ? JSON.parse(found[0].body) : found[0].body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`Invalid MySQL ${name} mapping`);
  return value;
}

function directoryRows(value) {
  if (Array.isArray(value)) return value.filter(row => row && typeof row === 'object');
  return Object.entries(value || {}).flatMap(([key, row]) => row && typeof row === 'object'
    ? [{ ...row, player_id: row.player_id ?? row.playerId ?? row.scorer_player_id ?? row.id ?? key }]
    : []);
}

async function read({
  scoring = require('./mysql-scoring.cjs'),
  appPool = () => require('./mysql-pin.cjs').database()
} = {}) {
  const [[records], current] = await Promise.all([
    appPool().execute('SELECT root, body FROM app_json_roots WHERE root IN (?, ?)',
      ['player_directory', 'player_download_links']),
    scoring.playerDirectory()
  ]);
  const playerDirectory = decodeRoot(records, 'player_directory');
  const playerDownloadLinks = decodeRoot(records, 'player_download_links');
  const source = scoring.SOURCE;
  const merged = new Map(directoryRows(playerDirectory[source]).map(row => {
    const id = row.player_id ?? row.playerId ?? row.scorer_player_id ?? row.id;
    return [String(id), row];
  }));
  // Current MySQL player data is authoritative for its scorer installation.
  // It replaces stale copies while preserving mappings for other installations.
  for (const row of current) {
    const id = row.player_id ?? row.playerId ?? row.scorer_player_id ?? row.id;
    if (id != null) merged.set(String(id), row);
  }
  playerDirectory[source] = [...merged.values()];
  return { playerDirectory, playerDownloadLinks };
}

module.exports = { read, decodeRoot, directoryRows };
