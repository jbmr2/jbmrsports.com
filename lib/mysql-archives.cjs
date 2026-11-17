'use strict';
const { entries, isValidInstallationID } = require('./match-archives.cjs');
const finalStatuses = new Set(['complete','completed','finished','ended','result']);

function validate(raw) {
  const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!payload?.tables || !isValidInstallationID(payload.installation_id)) throw Error('Invalid archive source');
  const manifest = payload.archive_manifest;
  if (!manifest?.match_uid || manifest.match_id == null) throw Error('Archive identity missing');
  const matches = entries(payload.tables.matches).filter(row => String(row.id) === String(manifest.match_id)
    && row.match_uid === manifest.match_uid);
  if (matches.length !== 1) throw Error('Archive match identity mismatch');
  const match = matches[0];
  // Imported documents include live snapshots. They are never final history.
  if (!finalStatuses.has(String(match.status || '').trim().toLowerCase())) return null;
  const innings = entries(payload.tables.innings).filter(row => String(row.match_id) === String(match.id));
  const ids = new Set(innings.map(row => String(row.id)));
  const balls = entries(payload.tables.balls).filter(row => ids.has(String(row.innings_id)));
  if (!innings.length) throw Error('Archive innings missing');
  if (manifest.ball_record_count != null && Number(manifest.ball_record_count) !== entries(payload.tables.balls).length) throw Error('Archive ball count mismatch');
  if (manifest.innings_record_count != null && Number(manifest.innings_record_count) !== entries(payload.tables.innings).length) throw Error('Archive innings count mismatch');
  const unique = rows => new Set(rows.map(row => String(row.id))).size === rows.length;
  if (!unique(innings) || !unique(balls)) throw Error('Duplicate archive scoring records');
  return { ...payload, tables: { ...payload.tables, matches, innings, balls }, archive_manifest: {
    ...manifest, tournament_id: match.tournament_id,
    ball_record_count: balls.length, innings_record_count: innings.length, matched_match_row_count: 1
  } };
}

async function read({ pool = () => require('./mysql-pin.cjs').database(), onInvalidArchive } = {}) {
  const [rows] = await pool().execute('SELECT path,body FROM app_documents WHERE collection_path=? ORDER BY path_hash', ['migrated_archives']);
  const result = [];
  for (const row of rows) {
    try { const payload = validate(row.body); if (payload) result.push(payload); }
    catch (error) {
      if (!onInvalidArchive) throw error;
      onInvalidArchive({ matchUID: row.path.split('/').at(-1), error });
    }
  }
  return result;
}
module.exports = { read, validate };
