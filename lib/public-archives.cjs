'use strict';

// The archive is an internal scoring backup, not a public API contract. Keep
// this allowlist explicit, including JSON-encoded nested objects.
const { entries } = require('./match-archives.cjs');
const { allowsClip } = require('./admin-visibility.cjs');
const fields = {
  matches: 'id match_uid tournament_id tournament_uid tournamentId team_a_id team_b_id title status match_number match_no match_date scheduled_at created_at completed_at ended_at total_overs toss_winner_id toss_decision result youtube_url live_url highlight_url venue',
  innings: 'id match_id number batting_team_id bowling_team_id completed overs target total_overs',
  balls: 'id innings_id seq over_index ball_index striker_id non_striker_id bowler_id kind runs legal created_at clip_status clip_url video_url',
  players: 'id name team_id role batting_style batting_hand bowling_style bowling_type photo_url',
  teams: 'id name short_name logo_url theme_color',
  tournaments: 'id name short_name venue location format type season start_date end_date logo_url',
  match_lineups: 'id match_id team_id player_id position is_captain is_keeper',
  state: 'runs wickets legal_balls target striker_id non_striker_id bowler_id completed',
  event: 'bat_runs completed_runs boundary wide_runs noball_runs bye_runs legbye_runs penalty_runs dismissal out_batter_id fielder_id dead_ball details_pending note',
  media: 'url status',
  manifest: 'match_uid match_id tournament_id revision chunk_count ball_record_count innings_record_count matched_match_row_count'
};
function object(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new Error('Malformed archive scoring object'); }
  }
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid archive scoring object');
  return value;
}
function pick(value, kind) {
  const row = object(value), result = {};
  for (const key of fields[kind].split(' ')) {
    const item = row[key];
    if (item === null || ['string', 'boolean'].includes(typeof item)
      || (typeof item === 'number' && Number.isFinite(item))) result[key] = item;
  }
  return result;
}
function projectRow(row, kind) {
  const result = pick(row, kind);
  const nested = kind === 'balls' ? { event: 'event', event_json: 'event', state_before: 'state', state_after: 'state', clip: 'media', video: 'media' }
    : kind === 'innings' ? { state: 'state', initial_state: 'state' }
      : kind === 'players' ? { photo: 'media' }
        : kind === 'matches' ? { highlight: 'media' } : { logo: 'media' };
  for (const [key, schema] of Object.entries(nested)) {
    if (row[key] != null) result[key] = pick(row[key], schema);
  }
  return result;
}
function publishedArchives(payloads, visibility) {
  return payloads.flatMap(payload => {
    const tables = payload.tables || {}, manifest = payload.archive_manifest || {};
    // A backup may include other matches. Only publish the manifest's match.
    const matches = entries(tables.matches).filter(row => {
      const uid = row.match_uid || row.matchUid;
      if (manifest.match_id != null && String(row.id) !== String(manifest.match_id)) return false;
      if (uid && manifest.match_uid && String(uid) !== String(manifest.match_uid)) return false;
      const mapped = manifest.match_id != null || (uid && String(uid) === String(manifest.match_uid));
      const tournamentIDs = [row.tournament_id, row.tournament_uid, row.tournamentId]
        .filter(value => value != null && String(value).trim() !== '')
        .map(String);
      return mapped && allowsClip(String(row.id), tournamentIDs, visibility, payload.installation_id);
    });
    if (!matches.length) return [];
    const ids = (rows, key = 'id') => new Set(rows.map(row => String(row[key])));
    const matchIDs = ids(matches), tournamentIDs = ids(matches, 'tournament_id');
    const innings = entries(tables.innings).filter(row => matchIDs.has(String(row.match_id)));
    const inningIDs = ids(innings);
    const balls = entries(tables.balls).filter(row => inningIDs.has(String(row.innings_id)));
    const lineups = entries(tables.match_lineups).filter(row => matchIDs.has(String(row.match_id)));
    const teamIDs = new Set(matches.flatMap(row => [String(row.team_a_id), String(row.team_b_id)]));
    const playerIDs = ids(lineups, 'player_id');
    for (const ball of balls) {
      const event = object(ball.event ?? ball.event_json);
      for (const id of [ball.striker_id, ball.non_striker_id, ball.bowler_id, event.out_batter_id, event.fielder_id]) {
        if (id != null) playerIDs.add(String(id));
      }
    }
    const selected = { matches, innings, balls, match_lineups: lineups,
      teams: entries(tables.teams).filter(row => teamIDs.has(String(row.id))),
      tournaments: entries(tables.tournaments).filter(row => tournamentIDs.has(String(row.id))),
      players: entries(tables.players).filter(row => playerIDs.has(String(row.id))) };
    const publicManifest = pick(manifest, 'manifest');
    publicManifest.ball_record_count = balls.length;
    publicManifest.innings_record_count = innings.length;
    publicManifest.matched_match_row_count = matches.length;
    return [{ installation_id: String(payload.installation_id || ''),
      synced_at: typeof payload.synced_at === 'number' && Number.isFinite(payload.synced_at) ? payload.synced_at : undefined,
      archive_manifest: publicManifest,
      tables: Object.fromEntries(Object.entries(selected).map(([kind, rows]) => [kind, rows.map(row => projectRow(row, kind))])) }];
  });
}
function install(app, authenticated, deps = {}) {
  const archives = deps.archives || (() => require('./admin-visibility.cjs').archives());
  const visibility = deps.visibility || (async () => {
    const db = require('firebase-admin/database').getDatabaseWithUrl(
      'https://jbmrsports-cricket-live-default-rtdb.asia-southeast1.firebasedatabase.app');
    return (await db.ref('app_visibility').get()).val() || {};
  });
  app.get('/api/scoring-archives', authenticated, async (_req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      if (_req.simulatorPreview) {
        const data = await require('./simulator-preview.cjs').data();
        return res.json({ ok: true, archives: data.archives, archiveDiagnostics: data.archiveDiagnostics });
      }
      const [payloads, rules] = await Promise.all([archives(), visibility()]);
      const report = deps.diagnostics ? await deps.diagnostics() : require('./admin-visibility.cjs').archiveDiagnostics();
      res.json({ ok: true, archives: publishedArchives(payloads, rules), archiveDiagnostics: report });
    } catch { res.status(502).json({ ok: false, error: 'Match archives could not load' }); }
  });
}
module.exports = { publishedArchives, install };
