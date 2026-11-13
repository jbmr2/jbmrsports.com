'use strict';

const { analyzeArchives } = require('./cricket-analytics/index.cjs');
const { summarizeBatting } = require('./cricket-analytics/batting-analytics.cjs');
const { summarizeBowling } = require('./cricket-analytics/bowling-analytics.cjs');

const { phone, scopedPlayerKey, resolveMappedPlayerKeys } = require('./player-ownership.cjs');
const { entries: rows } = require('./match-archives.cjs');
function normalizedMatchDate(match) {
  const candidates = [match.match_date, match.matchDate, match.date, match.start_date, match.startDate, match.scheduled_at, match.start_time];
  for (const value of candidates) {
    let millis = NaN;
    if (typeof value === 'number' && Number.isFinite(value)) millis = value > 1e12 ? value : value * 1000;
    else if (typeof value === 'string' && value.trim()) millis = Date.parse(value);
    else if (value && typeof value === 'object') {
      const seconds = Number(value.seconds ?? value._seconds);
      if (Number.isFinite(seconds)) millis = seconds * 1000;
    }
    if (Number.isFinite(millis)) {
      const date = new Date(millis);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  return null;
}
function safePositiveInt(value, fallback, max) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}
function buildPlayerAnalytics(options) {
  if (!phone(options.verifiedPhone)) return { status: 'login_phone_missing', linked: false, players: [], nextCursor: null };
  return buildScoringAnalytics(options);
}
// Pure scoring calculation, also used by the local simulator's explicitly
// selected player. Production ownership is enforced by buildPlayerAnalytics.
function buildScoringAnalytics({ archives, playerKeys, cursor = '', limit = 20, analyticsOptions = {} }) {
  const ownedKeys = new Set(playerKeys || []);
  if (!ownedKeys.size) return { status: 'player_not_linked', linked: false, players: [], nextCursor: null };

  // Archive player rows contribute scoring facts and labels only. Ownership was
  // resolved against the separately managed RTDB player mappings above.
  const relevant = archives.filter(archive => rows(archive.tables?.players).some(player =>
    ownedKeys.has(scopedPlayerKey(archive.installation_id, player.id))));
  const calculated = analyzeArchives(relevant, analyticsOptions);
  const privatePlayers = calculated.players.filter(player => ownedKeys.has(player.playerKey));
  const matchByUid = new Map(calculated.matches.map(match => [match.matchUid, match]));
  const playerNames = new Map(calculated.players.map(player => [player.playerKey, player.playerName]));
  const teamNames = new Map(calculated.matches.flatMap(match => match.players.map(player => [player.teamKey, player.teamName])));
  const sourceMatches = new Map();
  for (const archive of relevant) {
    for (const match of rows(archive.tables?.matches)) {
      sourceMatches.set(String(match.match_uid), match);
    }
  }
  const h2h = calculated.headToHead.filter(row => ownedKeys.has(row.batterKey) || ownedKeys.has(row.bowlerKey));
  const pageSize = safePositiveInt(limit, 20, 50);
  const start = reqCursor(cursor);
  const matches = privatePlayers.flatMap(player => {
    const matchIDs = new Set([
      ...player.battingInnings.map(row => row.matchUid),
      ...player.bowlingInnings.map(row => row.matchUid),
      ...player.teamHistory.filter(row => !player.uncertainMatchUids.includes(row.matchUid)).map(row => row.matchUid)
    ]);
    return [...matchIDs].map(uid => {
      const match = matchByUid.get(uid);
      const detail = match?.players.find(row => row.playerKey === player.playerKey);
      const sourceMatch = sourceMatches.get(uid);
      const teamNameFor = id => match?.players.find(row => String(row.teamId) === String(id))?.teamName || null;
      return detail ? {
        matchUid: uid, matchId: match.matchId, tournamentId: match.tournamentId,
        matchDate: sourceMatch ? normalizedMatchDate(sourceMatch) : null,
        teamAName: sourceMatch ? teamNameFor(sourceMatch.team_a_id) : null,
        teamBName: sourceMatch ? teamNameFor(sourceMatch.team_b_id) : null,
        result: match.result, batting: detail.batting, bowling: detail.bowling,
        battingInnings: detail.battingInnings, bowlingInnings: detail.bowlingInnings
      } : null;
    }).filter(Boolean);
  }).sort((a, b) => {
    const da = a.matchDate ? Date.parse(a.matchDate) : NaN, db = b.matchDate ? Date.parse(b.matchDate) : NaN;
    if (Number.isFinite(da) && Number.isFinite(db) && da !== db) return db - da;
    if (Number.isFinite(da) !== Number.isFinite(db)) return Number.isFinite(da) ? -1 : 1;
    return a.matchId.localeCompare(b.matchId);
  });
  const page = matches.slice(start, start + pageSize);
  const next = start + pageSize < matches.length ? String(start + pageSize) : null;
  const h2hStart = reqCursor(cursor);
  const h2hPage = h2h.slice(h2hStart, h2hStart + pageSize);
  const tournamentStats = privatePlayers.map(player => {
    const byTournament = new Map();
    for (const uid of new Set([...player.battingInnings.map(i => i.matchUid), ...player.bowlingInnings.map(i => i.matchUid)])) {
      const match = matchByUid.get(uid);
      if (!match) continue;
      if (!byTournament.has(match.tournamentId)) byTournament.set(match.tournamentId, { tournamentId: match.tournamentId, bat: [], bowl: [] });
      const group = byTournament.get(match.tournamentId);
      const matchPlayer = match.players.find(p => p.playerKey === player.playerKey);
      if (matchPlayer) { group.bat.push(...matchPlayer.battingInnings); group.bowl.push(...matchPlayer.bowlingInnings); }
    }
    return { playerKey: player.playerKey, tournaments: [...byTournament.values()].map(group => ({
      tournamentId: group.tournamentId,
      batting: summarizeBatting(group.bat),
      bowling: summarizeBowling(group.bowl)
    })).sort((a, b) => a.tournamentId.localeCompare(b.tournamentId)) };
  });

  return {
    status: 'ready', linked: true,
    warnings: calculated.warnings,
    players: privatePlayers.map(player => ({
      playerId: player.playerId, playerName: player.playerName,
      installationId: player.installationId,
      matchesPlayed: player.matchesPlayed,
      confirmedMatchesPlayed: player.confirmedMatchesPlayed,
      uncertainMatchUids: player.uncertainMatchUids,
      batting: player.batting, bowling: player.bowling,
      tournaments: tournamentStats.find(row => row.playerKey === player.playerKey)?.tournaments || [],
      opposition: player.opposition.map(row => ({ ...row, teamName: teamNames.get(row.oppositionTeamKey) || null })), teamHistory: player.teamHistory
    })),
    headToHead: h2hPage.map(row => ({ ...row, batterName: playerNames.get(row.batterKey) || null, bowlerName: playerNames.get(row.bowlerKey) || null })),
    matches: page,
    pagination: { limit: pageSize, nextCursor: next, headToHeadNextCursor: h2hStart + pageSize < h2h.length ? String(h2hStart + pageSize) : null }
  };
}
function reqCursor(value) {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw Object.assign(new Error('Invalid pagination cursor'), { code: 'INVALID_CURSOR' });
  return n;
}

function install(app, authenticated, deps = {}) {
  const getAuth = deps.getAuth || (() => require('firebase-admin/auth').getAuth());
  const getArchives = deps.getArchives || (() => require('./shorts.cjs').catalogs());
  const getPlayerMappings = deps.getPlayerMappings || (async () => ({}));
  const analyticsOptions = { allowUnknownPhases: true, ...deps.analyticsOptions };
  const rateLimit = deps.rateLimit || ((_req, _res, next) => next());
  const handler = view => async (req, res) => {
    try {
      // Resolve the phone from the verified Firebase UID on the server.
      // No client-supplied player ID participates in ownership selection.
      let result;
      if (req.simulatorPreview) {
        result = await require('./simulator-preview.cjs').analytics(req);
      } else if (deps.analyticsForRequest) {
        result = await deps.analyticsForRequest(req);
      } else {
        const user = await getAuth().getUser(req.user.uid);
        const payloads = (await getArchives()).filter(payload => payload?.tables && payload?.archive_manifest);
        const mappings = await getPlayerMappings();
        const playerKeys = resolveMappedPlayerKeys({
          archives: payloads, verifiedPhone: user.phoneNumber,
          playerDirectory: mappings.playerDirectory, playerDownloadLinks: mappings.playerDownloadLinks
        });
        result = buildPlayerAnalytics({
          archives: payloads,
          verifiedPhone: user.phoneNumber,
          playerKeys,
          cursor: req.query.cursor,
          limit: req.query.limit,
          analyticsOptions
        });
      }
      if (view === 'overview') {
        result.players = result.players.map(({ playerId, playerName, installationId, matchesPlayed, confirmedMatchesPlayed, uncertainMatchUids, batting, bowling }) => ({
          playerId, playerName, installationId, matchesPlayed, confirmedMatchesPlayed, uncertainMatchUids,
          matches: matchesPlayed,
          runs: batting.runs, wickets: bowling.wickets,
          average: batting.average, strikeRate: batting.strikeRate, economy: bowling.economy,
          sixes: batting.sixes, fours: batting.fours
        }));
        delete result.headToHead; delete result.matches;
      } else if (view === 'batting') {
        result.players = result.players.map(({ playerId, playerName, installationId, batting, tournaments }) => ({ playerId, playerName, installationId, batting, tournaments: tournaments.map(row => ({ tournamentId: row.tournamentId, batting: row.batting })) }));
        delete result.headToHead;
      } else if (view === 'bowling') {
        result.players = result.players.map(({ playerId, playerName, installationId, bowling, tournaments }) => ({ playerId, playerName, installationId, bowling, tournaments: tournaments.map(row => ({ tournamentId: row.tournamentId, bowling: row.bowling })) }));
        delete result.headToHead;
      } else if (view === 'head-to-head') {
        result.players = result.players.map(({ playerId, playerName, installationId }) => ({ playerId, playerName, installationId }));
        delete result.matches;
      } else if (view === 'opposition') {
        result.players = result.players.map(({ playerId, playerName, installationId, opposition }) => ({ playerId, playerName, installationId, opposition }));
        delete result.headToHead; delete result.matches;
      }
      res.set('Cache-Control', 'private, no-store').json({ ok: true, ...result });
    } catch (error) {
      // Avoid returning internal identifiers, database paths, or phone data.
      console.error('[My Performance API]', error.code || 'UNAVAILABLE', error.message);
      res.status(error.code ? 422 : 503).set('Cache-Control', 'private, no-store')
        .json({ ok: false, error: error.code ? 'Performance data is incomplete' : 'Performance data is temporarily unavailable', code: error.code || 'DATA_UNAVAILABLE' });
    }
  };
  for (const view of ['overview', 'batting', 'bowling', 'head-to-head', 'opposition']) {
    app.get(`/api/my-performance/analytics/${view}`, authenticated, rateLimit, handler(view));
  }
}

module.exports = { install, buildPlayerAnalytics, buildScoringAnalytics, resolveMappedPlayerKeys, normalizedMatchDate, scopedPlayerKey, phone };
