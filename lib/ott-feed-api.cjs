'use strict';

const { entries } = require('./match-archives.cjs');
const { publishedArchives } = require('./public-archives.cjs');
const DBURL = 'https://jbmrsports-cricket-live-default-rtdb.asia-southeast1.firebasedatabase.app';

function publicScorers(raw, visibility) {
  const result = {};
  for (const [source, payload] of Object.entries(raw || {})) {
    if (!/^[a-f0-9]{32}$/i.test(source) || !payload?.tables) continue;
    const tables = {};
    for (const match of entries(payload.tables.matches)) {
      const projected = publishedArchives([{ ...payload, installation_id: source,
        archive_manifest: { match_id: String(match.id), match_uid: match.match_uid } }], visibility);
      for (const item of projected) for (const [name, rows] of Object.entries(item.tables)) {
        tables[name] ||= {};
        for (const row of rows) tables[name][String(row.id)] = row;
      }
    }
    result[source] = { installation_id: source, synced_at: payload.synced_at, tables };
  }
  return result;
}

function liveFeed(data) {
  const tournaments = {};
  for (const [source, installation] of Object.entries(data.tournamentFeed || {})) {
    const teams = data.scorers?.[source]?.tables?.teams || {};
    const sourceMatches = data.scorers?.[source]?.tables?.matches || {};
    for (const [key, tournament] of Object.entries(installation.tournaments || {})) {
      const tid = `${source}:${tournament.tournament_id ?? key}`;
      const matches = {};
      for (const [uid, row] of Object.entries(tournament.matches || {})) {
        const scorer = entries(sourceMatches).find(m => m.match_uid === uid || String(m.id) === String(row.match_id));
        const id = row.match_id ?? scorer?.id;
        const mid = id == null ? uid : `${source}:${id}`;
        const team = id => { const t = teams[String(id)] || {}; return { name: t.name || 'TBD', shortName: t.short_name, logoUrl: t.logo_url }; };
        matches[mid] = { matchId: mid, tournamentId: tid, matchSeq: row.match_number,
          title: row.title, venue: row.venue || tournament.venue, scheduledAt: row.scheduled_at,
          status: row.status, liveUrl: row.youtube_url, highlightUrl: row.highlight_url,
          team1: team(scorer?.team_a_id), team2: team(scorer?.team_b_id) };
      }
      tournaments[tid] = { tournamentId: tid, name: tournament.name, logoUrl: tournament.logo_url,
        location: tournament.venue, showOnOtt: true, matches };
    }
  }
  // Build cards only from already visibility-filtered MySQL scorer records.
  const mysqlSource = require('./mysql-scoring.cjs').SOURCE;
  const mysql = data.scorers?.[mysqlSource];
  if (mysql) {
    const teams = mysql.tables?.teams || {};
    const sourceTournaments = mysql.tables?.tournaments || {};
    for (const match of entries(mysql.tables?.matches)) {
      const tid = `${mysqlSource}:${match.tournament_id}`;
      const mid = `${mysqlSource}:${match.id}`;
      const tournament = sourceTournaments[String(match.tournament_id)] || {};
      const team = id => { const t = teams[String(id)] || {}; return { name: t.name || 'TBD', shortName: t.short_name, logoUrl: t.logo_url }; };
      tournaments[tid] ||= { tournamentId: tid, name: tournament.name || 'Tournament', location: tournament.venue, showOnOtt: true, matches: {} };
      tournaments[tid].matches[mid] = { matchId: mid, tournamentId: tid, matchSeq: match.match_number,
        title: match.title, stage: match.stage || match.title, venue: match.venue || tournament.venue, scheduledAt: match.scheduled_at,
        status: match.status, liveUrl: match.youtube_url, team1: team(match.team_a_id), team2: team(match.team_b_id) };
    }
  }
  const legacy = data.legacy || {};
  for (const row of entries(legacy.catalog?.tournaments)) {
    const tid = String(row.tournamentId || row.id);
    const ott = legacy.tournaments?.[tid] || {};
    tournaments[tid] = { tournamentId: tid, name: row.name, location: row.location,
      startDate: typeof row.startDate === 'string' ? row.startDate : null,
      showOnOtt: true, matches: ott.matches || {} };
  }
  return { meta: { source: 'OTT API', updatedAt: data.fetchedAt || new Date().toISOString() }, tournaments };
}

async function productionData(req) {
  if (req?.simulatorPreview) {
    const loaded = await require('./simulator-preview.cjs').data();
    return { scorers: loaded.scorers, feed: liveFeed(loaded) };
  }
  const { getDatabaseWithUrl } = require('firebase-admin/database');
  const db = getDatabaseWithUrl(DBURL);
  const [scorers, feed, visibility, mysql] = await Promise.all([
    db.ref('scorers_public').get(), db.ref('tournament_feed').get(), db.ref('app_visibility').get(),
    require('./mysql-scoring.cjs').snapshot().catch(error => { console.warn('MySQL scoring unavailable', error.code || error.message); return null; })
  ]);
  const rules = visibility.val() || {};
  const projected = publicScorers(scorers.val(), rules);
  if (mysql) Object.assign(projected, publicScorers({ [mysql.installation_id]: mysql }, require('./mysql-scoring.cjs').scopedVisibility(rules)));
  const data = { scorers: projected, tournamentFeed: feed.val() || {} };
  const result = liveFeed(data);
  const { allowsClip } = require('./admin-visibility.cjs');
  for (const tournament of Object.values(result.tournaments)) {
    const [source, tid] = tournament.tournamentId.split(':');
    tournament.matches = Object.fromEntries(Object.entries(tournament.matches).filter(([id]) =>
      allowsClip(id.includes(':') ? id.split(':')[1] : id, tid || source, rules, tid ? source : '')));
    if (!Object.keys(tournament.matches).length) delete result.tournaments[tournament.tournamentId];
  }
  return { scorers: data.scorers, feed: result };
}

function install(app, authenticated, deps = {}) {
  const load = deps.load || productionData;
  for (const [path, field] of [['/api/public/live-feed', 'feed'], ['/api/public/scorers', 'scorers']]) {
    app.get(path, authenticated, async (_req, res) => {
      res.set('Cache-Control', 'private, no-store');
      try { res.json((await load(_req))[field]); }
      catch { res.status(503).json({ ok: false, error: 'Match data is temporarily unavailable.' }); }
    });
  }
}
module.exports = { install, liveFeed, publicScorers };
