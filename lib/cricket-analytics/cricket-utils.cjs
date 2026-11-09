'use strict';

class AnalyticsError extends Error {
  constructor(code, path, message) {
    super(`${code} at ${path}: ${message}`);
    this.name = 'AnalyticsError'; this.code = code; this.path = path;
  }
}
const fail = (code, path, message) => { throw new AnalyticsError(code, path, message); };
const id = (v, path) => {
  if ((typeof v !== 'string' && typeof v !== 'number') || String(v).trim() === '' || (typeof v === 'number' && !Number.isSafeInteger(v))) fail('MISSING_ID', path, 'Expected an explicit ID');
  return String(v);
};
const integer = (v, path) => {
  if (!Number.isSafeInteger(v) || v < 0) fail('INVALID_NUMBER', path, 'Expected a nonnegative integer');
  return v;
};
const flag = (v, path) => {
  if (![true, false, 0, 1].includes(v)) fail('MISSING_FLAG', path, 'Expected boolean or 0/1');
  return Boolean(v);
};
const rows = (v, path) => {
  if (!v || typeof v !== 'object') fail('MISSING_TABLE', path, 'Expected table');
  return Array.isArray(v) ? v : Object.entries(v).map(([k, r]) => ({ ...r, id: r.id ?? k }));
};
const key = (...parts) => JSON.stringify(parts.map(String));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const ratio = (n, d, multiplier = 1) => d === 0 ? null : Number((n * multiplier / d).toFixed(6));
const overs = (balls, size = 6) => `${Math.floor(balls / size)}.${balls % size}`;
const stable = v => JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const credited = new Set(['bowled', 'caught', 'lbw', 'stumped', 'hitwicket']);
const uncredited = new Set(['runout', 'retiredout', 'obstructingthefield', 'timedout', 'hitballtwice', 'handledball']);
function dismissal(value, path) {
  if (typeof value !== 'string') fail('MISSING_DISMISSAL', path, 'Explicit empty string required for a non-wicket');
  let d = value.toLowerCase().replace(/[\s_-]/g, '');
  if (['caughtbehind', 'caughtandbowled', 'c&b'].includes(d)) d = 'caught';
  if (d === 'obstructingfield') d = 'obstructingthefield';
  if (d && d !== 'retiredhurt' && !credited.has(d) && !uncredited.has(d)) fail('UNSUPPORTED_DISMISSAL', path, value);
  return { type: d, wicket: credited.has(d) || uncredited.has(d), bowlerWicket: credited.has(d) };
}
function formatFor(match, options) {
  const supplied = options.formatForMatch ? options.formatForMatch(match) : options.format;
  const maxOvers = supplied?.maxOvers ?? match.total_overs;
  if (!Number.isSafeInteger(maxOvers) || maxOvers <= 0) fail('UNSUPPORTED_FORMAT', match.match_uid, 'Explicit positive over limit required');
  const size = supplied?.ballsPerOver ?? 6;
  if (!Number.isSafeInteger(size) || size <= 0) fail('UNSUPPORTED_FORMAT', match.match_uid, 'Invalid ballsPerOver');
  const pp = supplied?.powerplayOvers ?? (maxOvers === 20 ? 6 : maxOvers === 50 ? 10 : undefined);
  const death = supplied?.deathOvers ?? (maxOvers === 20 ? 5 : maxOvers === 50 ? 10 : undefined);
  if (![pp, death].every(x => Number.isSafeInteger(x) && x >= 0) || pp + death > maxOvers) fail('UNSUPPORTED_PHASES', match.match_uid, 'Provide powerplayOvers/deathOvers for this format');
  return { maxOvers, ballsPerOver: size, powerplayOvers: pp, deathOvers: death };
}
function index(table, path) {
  const out = new Map();
  for (const row of rows(table, path)) {
    const k = id(row.id, `${path}.id`);
    if (out.has(k)) fail('DUPLICATE_ID', path, k);
    out.set(k, row);
  }
  return out;
}
function normalizeArchives(archives, options = {}) {
  if (!Array.isArray(archives)) fail('INVALID_ARCHIVES', 'archives', 'Expected an array');
  const matches = [], seen = new Map(), identities = new Map(), warnings = [];
  for (const archive of [...archives].sort((a, b) => compare(stable(a), stable(b)))) {
    const scope = id(archive.installation_id, 'installation_id');
    const t = archive.tables;
    if (!t) fail('MISSING_TABLES', scope, 'No tables');
    if (t.ball_corrections && rows(t.ball_corrections, 'ball_corrections').length) fail('UNAPPLIED_CORRECTIONS', scope, 'Correction semantics must be resolved before analytics');
    const ms = rows(t.matches, 'matches');
    if (ms.length !== 1) fail('AMBIGUOUS_ARCHIVE', scope, 'Expected exactly one match per completed archive');
    const m = ms[0], mid = id(m.id, 'match.id'), uid = id(m.match_uid, 'match.match_uid');
    const signature = stable({ scope, tables: t });
    if (seen.has(uid)) {
      if (seen.get(uid) !== signature) fail('CONFLICTING_ARCHIVE', uid, 'Two different payloads for the same match');
      continue;
    }
    seen.set(uid, signature);
    if (!['completed', 'complete', 'finished', 'ended', 'result'].includes(String(m.status).toLowerCase())) fail('INCOMPLETE_MATCH', uid, 'Only completed matches are supported');
    const teamA = id(m.team_a_id, uid), teamB = id(m.team_b_id, uid);
    if (teamA === teamB) fail('INVALID_TEAMS', uid, 'Match teams must differ');
    const players = index(t.players, `${uid}.players`), teams = index(t.teams, `${uid}.teams`);
    for (const tid of [teamA, teamB]) if (!teams.has(tid)) fail('INVALID_TEAM', uid, tid);
    const f = formatFor(m, options);
    const match = { uid, id: mid, scope, tournamentId: id(m.tournament_id, uid), format: f, players: [], innings: [], lineup: new Set(), lineupAvailable: false, result: m.result ?? null };
    const player = (pid, path, expectedTeam) => {
      const pk = id(pid, path), p = players.get(pk);
      if (!p) fail('INVALID_PLAYER', path, pk);
      const tid = id(p.team_id, path);
      if (![teamA, teamB].includes(tid) || !teams.has(tid) || (expectedTeam && tid !== expectedTeam)) fail('PLAYER_TEAM_MISMATCH', path, pk);
      return key(scope, pk);
    };
    for (const [pid, p] of players) {
      const pk = player(pid, `${uid}.players`);
      if (typeof p.name !== 'string' || !p.name.trim()) fail('MISSING_PLAYER_NAME', uid, pid);
      const identity = { playerKey: pk, installationId: scope, playerId: pid, playerName: p.name };
      if (identities.has(pk) && identities.get(pk).playerName !== p.name) warnings.push({ code: 'PLAYER_NAME_CHANGED', matchUid: uid, playerKey: pk });
      // Choose names deterministically after match sorting, without merging different IDs.
      match.players.push({ ...identity, teamId: String(p.team_id), teamKey: key(scope, p.team_id), teamName: teams.get(String(p.team_id)).name });
      identities.set(pk, identity);
    }
    const lineup = t.match_lineups == null ? [] : rows(t.match_lineups, `${uid}.match_lineups`);
    for (const row of lineup) {
      if (id(row.match_id, uid) !== mid) fail('INVALID_LINEUP', uid, 'Wrong match');
      const pk = player(row.player_id, uid, id(row.team_id, uid));
      if (match.lineup.has(pk)) fail('DUPLICATE_LINEUP', uid, pk);
      match.lineup.add(pk);
    }
    // A nonempty roster is not proof it is exhaustive; all listed participants must be valid.
    match.lineupAvailable = lineup.length > 0;
    if (!match.lineupAvailable) warnings.push({ code: 'LINEUP_UNAVAILABLE', matchUid: uid, message: 'Exact matches played is unknown for unobserved squad members' });
    const inningsMap = index(t.innings, `${uid}.innings`);
    const allBalls = rows(t.balls, `${uid}.balls`), ballIDs = new Set(), ballUIDs = new Set();
    for (const b of allBalls) {
      const bid = id(b.id, uid);
      if (ballIDs.has(bid)) fail('DUPLICATE_BALL', uid, bid);
      ballIDs.add(bid);
      if (b.ball_uid != null) { const bu = id(b.ball_uid, uid); if (ballUIDs.has(bu)) fail('DUPLICATE_BALL_UID', uid, bu); ballUIDs.add(bu); }
      if (!inningsMap.has(id(b.innings_id, uid))) fail('INVALID_INNINGS', uid, bid);
    }
    const numbers = new Set();
    for (const [iid, inn] of inningsMap) {
      const path = `${uid}/innings/${iid}`;
      if (id(inn.match_id, path) !== mid) fail('INVALID_MATCH_REFERENCE', path, 'Wrong match ID');
      if (!flag(inn.completed, path)) fail('INCOMPLETE_INNINGS', path, 'Innings not complete');
      const number = integer(inn.number, path);
      if (!number || numbers.has(number)) fail('DUPLICATE_INNINGS_NUMBER', path, String(number));
      numbers.add(number);
      const batTeam = id(inn.batting_team_id, path), bowlTeam = id(inn.bowling_team_id, path);
      if (batTeam === bowlTeam || ![teamA, teamB].includes(batTeam) || ![teamA, teamB].includes(bowlTeam)) fail('INVALID_INNINGS_TEAMS', path, 'Innings teams mismatch');
      const state = inn.initial_state;
      if (!state || ['runs', 'wickets', 'legal_balls'].some(k => state[k] !== 0)) fail('PARTIAL_INNINGS', path, 'Initial score must be explicitly zero');
      const initialBatters = [player(state.striker_id, path, batTeam), player(state.non_striker_id, path, batTeam)];
      if (initialBatters[0] === initialBatters[1]) fail('INVALID_BATTERS', path, 'Striker and non-striker are identical');
      const bs = allBalls.filter(b => String(b.innings_id) === iid).sort((a, b) => a.seq - b.seq);
      const ni = { id: iid, number, matchUid: uid, battingTeamKey: key(scope, batTeam), bowlingTeamKey: key(scope, bowlTeam), initialBatters, events: [], final: inn.state, format: f };
      let runs = 0, wickets = 0, legal = 0;
      const dismissed = new Set();
      for (let n = 0; n < bs.length; n++) {
        const b = bs[n], bp = `${path}/ball/${b.id}`;
        if (integer(b.seq, bp) !== n + 1) fail('SEQUENCE_GAP_OR_DUPLICATE', bp, 'Sequence must start at 1 and be contiguous');
        const e = b.event;
        if (!e || typeof e !== 'object') fail('MISSING_EVENT', bp, 'Missing event');
        if (flag(e.details_pending, bp)) fail('INCOMPLETE_EVENT', bp, 'Wicket details pending');
        const br = integer(e.bat_runs, bp), wide = integer(e.wide_runs, bp), nb = integer(e.noball_runs, bp), bye = integer(e.bye_runs, bp), lb = integer(e.legbye_runs, bp), penalty = integer(e.penalty_runs, bp);
        if (penalty) fail('UNSUPPORTED_PENALTY', bp, 'Penalty attribution requires an explicit scoring rule');
        if ((wide && (nb || br || bye || lb)) || (bye && lb) || (br && (bye || lb))) fail('INCONSISTENT_EXTRAS', bp, 'Mutually exclusive runs');
        if (e.short_runs != null && integer(e.short_runs, bp) > 0) fail('UNSUPPORTED_SHORT_RUNS', bp, 'Net-run semantics must be confirmed');
        const d = dismissal(e.dismissal, bp), dead = flag(e.dead_ball, bp);
        const retirement = ['retiredhurt', 'retiredout', 'timedout'].includes(d.type);
        const legalDelivery = flag(b.legal, bp);
        if (legalDelivery !== !(wide || nb || dead || retirement)) fail('INCONSISTENT_LEGAL_DELIVERY', bp, 'Legal flag disagrees with extras/event');
        if (dead && (br + wide + nb + bye + lb || d.wicket)) fail('UNSUPPORTED_DEAD_BALL', bp, 'Scoring dead ball requires explicit semantics');
        if (retirement && br + wide + nb + bye + lb) fail('UNSUPPORTED_RETIREMENT', bp, 'Retirement is a non-delivery event');
        if (b.kind === 'wicket' && !d.wicket) fail('MISSING_DISMISSAL', bp, 'Wicket record lacks a supported dismissal');
        if (d.bowlerWicket && ((nb || b.state_before?.free_hit) || (wide && !['stumped', 'hitwicket'].includes(d.type)))) fail('ILLEGAL_BOWLER_WICKET', bp, 'Dismissal incompatible with delivery');
        const batter = player(b.striker_id, bp, batTeam), nonStriker = player(b.non_striker_id, bp, batTeam), bowler = player(b.bowler_id, bp, bowlTeam);
        if (batter === nonStriker || dismissed.has(batter) || dismissed.has(nonStriker)) fail('INVALID_ACTIVE_BATTER', bp, 'Dismissed or identical active batter');
        let outBatter = null;
        if (d.type) {
          outBatter = player(e.out_batter_id, bp, batTeam);
          if (!retirement && ![batter, nonStriker].includes(outBatter)) fail('INVALID_OUT_BATTER', bp, 'Out batter is not at the crease');
          if (d.bowlerWicket && d.type !== 'timedout' && outBatter !== batter) fail('INVALID_OUT_BATTER', bp, 'Bowler wicket must dismiss striker');
          if (d.wicket) { if (dismissed.has(outBatter)) fail('DUPLICATE_DISMISSAL', bp, outBatter); dismissed.add(outBatter); }
        } else if (e.out_batter_id != null && e.out_batter_id !== '') fail('MISSING_DISMISSAL', bp, 'Out batter without dismissal type');
        const fielders = [];
        for (const field of ['fielder_id', 'assisting_fielder_id']) if (e[field] != null && e[field] !== '') fielders.push(player(e[field], bp, bowlTeam));
        const teamRuns = br + wide + nb + bye + lb;
        if (integer(b.runs, bp) !== teamRuns) fail('RUN_TOTAL_MISMATCH', bp, 'Ball total differs from event components');
        const before = b.state_before, after = b.state_after;
        for (const [k, expected] of [['runs', runs], ['wickets', wickets], ['legal_balls', legal]]) if (!before || before[k] !== expected) fail('STATE_DISCONTINUITY', bp, k);
        const over = Math.floor(legal / f.ballsPerOver);
        if (over >= f.maxOvers && !retirement) fail('OVER_LIMIT_EXCEEDED', bp, 'Delivery beyond configured innings limit');
        const faced = !wide && !dead && !retirement;
        const isDelivery = !dead && !retirement;
        let boundary = 0;
        if ([4, 6].includes(br) && e.boundary === undefined) {
          const completedRuns = integer(e.completed_runs, bp);
          if (completedRuns === 0) boundary = br;
          else if (completedRuns !== br) fail('AMBIGUOUS_BOUNDARY', bp, 'Mixed running/overthrow runs require explicit boundary attribution');
        }
        if (e.boundary !== undefined) {
          if (![0, 4, 6].includes(e.boundary) || (e.boundary && br !== e.boundary)) fail('INVALID_BOUNDARY', bp, 'Expected 0, 4 or 6 matching bat runs');
          boundary = e.boundary;
        }
        ni.events.push({ seq: b.seq, batter, nonStriker, bowler, outBatter, fielders, dismissal: d.type, wicket: d.wicket, bowlerWicket: d.bowlerWicket, batRuns: br, teamRuns, conceded: br + wide + nb, wide, noBall: nb, bye, legBye: lb, faced, isDelivery, legal: legalDelivery, boundary, over, phase: over < f.powerplayOvers ? 'powerplay' : over >= f.maxOvers - f.deathOvers ? 'death' : 'middle' });
        runs += teamRuns; wickets += Number(d.wicket); legal += Number(legalDelivery);
        for (const [k, expected] of [['runs', runs], ['wickets', wickets], ['legal_balls', legal]]) if (!after || after[k] !== expected) fail('STATE_TOTAL_MISMATCH', bp, k);
      }
      for (const [k, expected] of [['runs', runs], ['wickets', wickets], ['legal_balls', legal]]) if (!inn.state || inn.state[k] !== expected) fail('INNINGS_RECONCILIATION_FAILED', path, k);
      ni.reconciliation = { runs, wickets, legalBalls: legal, ballRecords: bs.length, status: 'PASS' };
      match.innings.push(ni);
    }
    if (!match.innings.length) fail('MISSING_INNINGS', uid, 'No innings');
    match.innings.sort((a, b) => a.number - b.number);
    matches.push(match);
  }
  matches.sort((a, b) => compare(a.uid, b.uid));
  return { matches, warnings: warnings.sort((a, b) => compare(stable(a), stable(b))) };
}
module.exports = { AnalyticsError, fail, id, rows, key, compare, ratio, overs, normalizeArchives };
