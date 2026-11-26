'use strict';

// The scoring database is owned by the scorer. This connection only reads it.
const TABLES = Object.freeze([
  'tournaments', 'teams', 'players', 'matches', 'innings', 'balls',
  'match_lineups', 'ball_corrections', 'innings_adjustments'
]);
let pool, scorePool, catalogPool;
const SOURCE = '3b2b21f1a1374f6892bb66b1a4372640';
let cached, pending;
let generation = 0;

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
  const [rows] = await db.query({ sql: `SELECT * FROM \`${table}\``, timeout: 5000 });
  return rows;
}
async function imageMetadata(db = database()) {
  const [rows] = await db.query({ sql: "SELECT entity, entity_id, sha256 FROM jbmr_images WHERE entity IN ('players','teams','tournaments')", timeout: 5000 });
  return rows;
}
function attachImages(tables, images) {
  const indexed = new Map(images.filter(row => /^[a-f0-9]{64}$/i.test(row.sha256 || '')).map(row => [`${row.entity}:${row.entity_id}`, row.sha256]));
  for (const entity of ['players', 'teams', 'tournaments']) {
    tables[entity] = (tables[entity] || []).map(row => {
      const hash = indexed.get(`${entity}:${row.id}`);
      if (!hash) return row;
      const field = entity === 'players' ? 'photo_url' : 'logo_url';
      return { ...row, [field]: `https://jbmrsports.com/api/scoring-images/${entity}/${row.id}/${hash}` };
    });
  }
  return tables;
}
async function readImage(entity, id, hash) {
  const [rows] = await database().execute({ sql: 'SELECT mime_type, image_bytes FROM jbmr_images WHERE entity=? AND entity_id=? AND sha256=?', values: [entity,id,hash], timeout: 5000 });
  return rows[0];
}

async function snapshot() {
  if (cached && Date.now() - cached.at < 5000) return cached.value;
  if (pending) {
    const readGeneration = generation;
    const value = await pending;
    if (readGeneration === generation && cached?.value === value) return value;
    return snapshot();
  }
  pending = (async () => {
    const readGeneration = generation;
    const names = ['tournaments', 'teams', 'players', 'matches', 'innings', 'match_lineups'];
    const results = await Promise.all(names.map(name => readTable(name)));
    const tables = Object.fromEntries(names.map((name, index) => [name, results[index]]));
    try { attachImages(tables, await imageMetadata()); }
    catch (error) { console.warn('Scoring image metadata unavailable', error.code || error.message); }
    // Read deliveries only for active matches. Re-reading every historical
    // delivery on each live refresh would overload a shared hosting plan.
    const [balls] = await database().query({ sql: "SELECT b.* FROM balls b JOIN innings i ON i.id = b.innings_id JOIN matches m ON m.id = i.match_id WHERE LOWER(m.status) IN ('live', 'in_progress', 'inprogress', 'innings_break', 'innings break')", timeout: 5000 });
    tables.balls = balls;
    tables.matches = tables.matches.map(row => {
      let rules = row.rules_json;
      if (typeof rules === 'string') {
        try { rules = JSON.parse(rules); } catch { rules = null; }
      }
      const format = rules?.scoring_format;
      return typeof format === 'string' ? { ...row, format } : row;
    });
    tables.innings = tables.innings.map(row => ({ ...row, state: row.state ?? row.state_json }));
    const value = { installation_id: SOURCE, tables };
    if (readGeneration === generation) cached = { at: Date.now(), value };
    return value;
  })().finally(() => { pending = undefined; });
  const value = await pending;
  return cached?.value === value ? value : snapshot();
}

async function readMatch(id) {
  const conn = await database().getConnection();
  const read = async (sql, values) => (await conn.query({ sql, values, timeout: 5000 }))[0];
  try {
    await conn.beginTransaction();
    const matches = await read('SELECT * FROM matches WHERE id = ?', [id]);
    if (!matches.length) { await conn.commit(); return null; }
    const match = matches[0];
    let rules = match.rules_json;
    if (typeof rules === 'string') { try { rules = JSON.parse(rules); } catch { rules = null; } }
    if (typeof rules?.scoring_format === 'string') match.format = rules.scoring_format;
    const innings = await read('SELECT * FROM innings WHERE match_id = ? ORDER BY number', [id]);
    const balls = await read('SELECT b.* FROM balls b JOIN innings i ON i.id=b.innings_id WHERE i.match_id=? ORDER BY b.innings_id,b.seq', [id]);
    const match_lineups = await read('SELECT * FROM match_lineups WHERE match_id=?', [id]);
    const ids = new Set(match_lineups.map(row => String(row.player_id)));
    for (const ball of balls) {
      let event = ball.event ?? ball.event_json;
      if (typeof event === 'string') { try { event = JSON.parse(event); } catch { event = null; } }
      for (const value of [ball.striker_id, ball.non_striker_id, ball.bowler_id, event?.out_batter_id, event?.fielder_id]) {
        if (value != null) ids.add(String(value));
      }
    }
    const players = ids.size ? await read('SELECT * FROM players WHERE id IN (?)', [[...ids]]) : [];
    const teams = await read('SELECT * FROM teams WHERE id IN (?,?)', [match.team_a_id,match.team_b_id]);
    const tournaments = await read('SELECT * FROM tournaments WHERE id=?', [match.tournament_id]);
    let images = [];
    try { images = await imageMetadata(conn); }
    catch (error) { console.warn('Match image metadata unavailable', error.code || error.message); }
    const withImages = attachImages({ players, teams, tournaments }, images);
    await conn.commit();
    return { installation_id: SOURCE, archive_manifest: { match_id: String(id), match_uid: match.match_uid },
      tables: { matches, innings: innings.map(row => ({ ...row, state: row.state ?? row.state_json })), balls, ...withImages, match_lineups } };
  } catch(error) { await conn.rollback(); throw error; }
  finally { conn.release(); }
}

function scopedVisibility(rules) {
  const pick = scope => Object.fromEntries(Object.entries(rules?.[scope] || {})
    .filter(([id]) => id.startsWith(`${SOURCE}:`)));
  return { matches: pick('matches'), tournaments: pick('tournaments') };
}

async function liveRevision() {
  const [rows] = await database().query({ sql: "SELECT i.id, i.state, i.completed, m.status, m.updated_at FROM innings i JOIN matches m ON m.id=i.match_id WHERE LOWER(m.status) IN ('live','in_progress','inprogress','innings_break','innings break') ORDER BY i.id", timeout: 5000 });
  return require('node:crypto').createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
// Keep score reads off the two connections used by catalog/history downloads.
// The scorer's direct MySQL commits are visible here without changing its code.
async function scoreHeads(db, { catalog = false } = {}) {
  if (!db) {
    if (!process.env.JBMR_SCORING_DB_PASSWORD) throw Error('Scoring database is not configured');
    const createPool = () => require('mysql2/promise').createPool({
      host: '127.0.0.1', port: 3306,
      user: 'u462067053_jbmrscore', database: 'u462067053_jbmrscoring',
      password: process.env.JBMR_SCORING_DB_PASSWORD,
      connectionLimit: 1, connectTimeout: 3000, supportBigNumbers: true,
      bigNumberStrings: true, dateStrings: true, multipleStatements: false
    });
    // HTTP catalog metadata should not hold the connection used for score updates.
    db = catalog ? (catalogPool ||= createPool()) : (scorePool ||= createPool());
  }
  const conn = await db.getConnection();
  try {
    // Both tables come from one committed view, including Test innings 3/4,
    // revised targets, corrections, undo and a live -> completed transition.
    await conn.beginTransaction();
    const [matches] = await conn.query({ sql: 'SELECT * FROM matches ORDER BY id', timeout: 3000 });
    const [innings] = await conn.query({ sql: 'SELECT * FROM innings ORDER BY id', timeout: 3000 });
    const metadata = {};
    if (catalog) {
      metadata.teams = await readTable('teams', conn);
      metadata.tournaments = await readTable('tournaments', conn);
      try {
        attachImages(metadata, await imageMetadata(conn));
        delete metadata.players;
      } catch (error) { console.warn('Catalog image metadata unavailable', error.code || error.message); }
    }
    await conn.commit();
    return { installation_id: SOURCE, tables: {
      matches: matches.map(row => {
        let rules = row.rules_json;
        if (typeof rules === 'string') { try { rules = JSON.parse(rules); } catch { rules = null; } }
        return typeof rules?.scoring_format === 'string' ? { ...row, format: rules.scoring_format } : row;
      }),
      innings: innings.map(row => ({ ...row, state: row.state ?? row.state_json })), ...metadata
    } };
  } catch (error) { await conn.rollback().catch(() => {}); throw error; }
  finally { conn.release(); }
}
function invalidate() {
  generation += 1;
  cached = undefined;
}
module.exports = { TABLES, SOURCE, readTable, snapshot, scopedVisibility, liveRevision, invalidate, readMatch, scoreHeads, attachImages, readImage };
