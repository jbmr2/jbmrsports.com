'use strict';
const { entries } = require('./match-archives.cjs');
let cached, loading;
async function identities() {
  if (cached && Date.now() - cached.at < 300000) return cached.rows;
  loading ||= require('./mysql-pin.cjs').database().execute(`SELECT
    JSON_UNQUOTE(JSON_EXTRACT(body,'$.installation_id')) AS source,
    JSON_UNQUOTE(JSON_EXTRACT(body,'$.archive_manifest.match_uid')) AS uid,
    JSON_UNQUOTE(JSON_EXTRACT(body,'$.archive_manifest.match_id')) AS id,
    JSON_EXTRACT(body,'$.tables.matches') AS matches_json
    FROM app_documents WHERE collection_path=?`, ['migrated_archives'])
    .then(([records]) => {
      const rows = records.flatMap(row => {
        const matches = typeof row.matches_json === 'string' ? JSON.parse(row.matches_json) : row.matches_json;
        const selected = entries(matches).filter(match => String(match.id) === String(row.id) && match.match_uid === row.uid);
        return selected.length === 1 ? [{ source: row.source, uid: row.uid, id: row.id, tournament: String(selected[0].tournament_id) }] : [];
      });
      cached = { at: Date.now(), rows }; return rows;
    })
    .finally(() => { loading = undefined; });
  return loading;
}

function resolve(payload, rules, migrated) {
  const source = payload.installation_id;
  const { allowsClip } = require('./admin-visibility.cjs');
  const result = { matches: {}, tournaments: { ...(rules?.tournaments || {}) } };
  for (const match of entries(payload.tables?.matches)) {
    const key = `${source}:${match.id}`, tid = `${source}:${match.tournament_id}`;
    const explicit = rules?.matches?.[key]?.show;
    const parent = rules?.tournaments?.[tid]?.show;
    if (typeof explicit === 'boolean' || typeof parent === 'boolean') {
      result.matches[key] = { show: parent !== false && (explicit ?? parent === true) };
      continue;
    }
    // Numeric IDs alone are never sufficient across installations. Only an
    // unambiguous migrated match UID with matching match/tournament IDs can
    // carry its existing publication rule to the MySQL transport namespace.
    const candidates = migrated.filter(row => row.uid && row.uid !== 'null'
      && row.uid === match.match_uid && String(row.id) === String(match.id)
      && String(row.tournament) === String(match.tournament_id)
      && /^[a-f0-9]{32}$/.test(row.source || ''));
    const sources = new Set(candidates.map(row => row.source));
    result.matches[key] = { show: sources.size === 1 && allowsClip(String(match.id), String(match.tournament_id), rules, candidates[0].source) };
  }
  return result;
}
async function visibility(payload, rules) { return resolve(payload, rules, await identities()); }
module.exports = { identities, resolve, visibility };
