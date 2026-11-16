'use strict';

// The scoring database is owned by the scorer. This connection only reads it.
const TABLES = Object.freeze([
  'tournaments', 'teams', 'players', 'matches', 'innings', 'balls',
  'match_lineups', 'ball_corrections', 'innings_adjustments'
]);
let pool;
const SOURCE = '3b2b21f1a1374f6892bb66b1a4372640';
let cached, pending;

function database() {
  if (pool) return pool;
  if (!process.env.JBMR_SCORING_DB_PASSWORD) throw new Error('Scoring database is not configured');
  pool = require('mysql2/promise').createPool({
    host: '127.0.0.1', port: 3306,
    user: 'u462067053_jbmrscore', database: 'u462067053_jbmrscoring',
    password: process.env.JBMR_SCORING_DB_PASSWORD,
    connectionLimit: 2, connectTimeout: 5000, supportBigNumbers: true,
    bigNumberStrings: true, dateStrings: true, multipleStatements: false
  });
  return pool;
}

async function readTable(table, db = database()) {
  if (!TABLES.includes(table)) throw new Error('Unsupported scoring table');
  const [rows] = await db.query(`SELECT * FROM \`${table}\``);
  return rows;
}

async function snapshot() {
  if (cached && Date.now() - cached.at < 5000) return cached.value;
  if (pending) return pending;
  pending = (async () => {
    const names = ['tournaments', 'teams', 'players', 'matches', 'innings', 'match_lineups'];
    const results = await Promise.all(names.map(name => readTable(name)));
    const tables = Object.fromEntries(names.map((name, index) => [name, results[index]]));
    // Read deliveries only for active matches. Re-reading every historical
    // delivery on each live refresh would overload a shared hosting plan.
    const [balls] = await database().query("SELECT b.* FROM balls b JOIN innings i ON i.id = b.innings_id JOIN matches m ON m.id = i.match_id WHERE LOWER(m.status) IN ('live', 'in_progress', 'inprogress', 'innings_break', 'innings break')");
    tables.balls = balls;
    tables.innings = tables.innings.map(row => ({ ...row, state: row.state ?? row.state_json }));
    const value = { installation_id: SOURCE, tables };
    cached = { at: Date.now(), value };
    return value;
  })().finally(() => { pending = undefined; });
  return pending;
}

function scopedVisibility(rules) {
  const pick = scope => Object.fromEntries(Object.entries(rules?.[scope] || {})
    .filter(([id]) => id.startsWith(`${SOURCE}:`)));
  return { matches: pick('matches'), tournaments: pick('tournaments') };
}

async function liveRevision() {
  const [rows] = await database().query("SELECT i.id, i.state, i.completed, m.status, m.updated_at FROM innings i JOIN matches m ON m.id=i.match_id WHERE LOWER(m.status) IN ('live','in_progress','inprogress','innings_break','innings break') ORDER BY i.id");
  return require('node:crypto').createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
function invalidate() { cached = undefined; }
module.exports = { TABLES, SOURCE, readTable, snapshot, scopedVisibility, liveRevision, invalidate };
