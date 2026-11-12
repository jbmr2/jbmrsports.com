export const API_BASE = 'https://crickdbmodule-api-144271912366.asia-south1.run.app'
export const FIREBASE_RTDB =
  'https://jbmrsports-cricket-live-default-rtdb.asia-southeast1.firebasedatabase.app'
export const FIREBASE_OTT_URL = `${FIREBASE_RTDB}/ott.json`
export const MEDIA_BASE = 'https://storage.googleapis.com/crickbuck'

export type ApiTeam = {
  id?: string
  name: string
  shortName?: string
  logoUrl?: string
}

export type FirebaseBall = {
  id?: string
  innings?: number
  over?: number
  ball?: number
  runs?: number
  isWicket?: boolean
  note?: string
  videoUrl?: string
  videoPath?: string
}

export type ApiMatch = {
  matchId: string
  matchSeq?: number
  stage?: string
  venue?: string
  scheduledAt?: string
  startedAt?: string
  endedAt?: string
  status: string
  thumbnailUrl?: string
  liveUrl?: string
  highlightUrl?: string
  team1: ApiTeam
  team2: ApiTeam
  result?: { summaryText?: string; winnerShortName?: string }
  innings?: Array<{
    inningsNumber?: number
    teamName?: string
    teamShortName?: string
    runs?: number
    wickets?: number
    overs?: number
  }>
  balls?: Record<string, FirebaseBall>
  tournamentName?: string
  tournamentId?: string
}

export type ApiTournament = {
  tournamentId: string
  name: string
  logoUrl?: string
  location?: string
  startDate?: string
  endDate?: string
  type?: string
  format?: string
  matches: ApiMatch[]
}

export function absoluteUrl(path?: string | null): string | undefined {
  if (!path) return undefined
  let raw = path.trim()
  if (!raw) return undefined
  if (raw.startsWith('//')) raw = `https:${raw}`
  if (/^https?:\/\//i.test(raw)) return raw
  const relative = raw.startsWith('/') ? raw.slice(1) : raw
  if (relative.startsWith('uploads/')) {
    return `${MEDIA_BASE}/${relative.slice('uploads/'.length)}`
  }
  return `${MEDIA_BASE}/${relative}`
}

/** Poster from a real YouTube / Cloudflare Stream URL — no local dummy art. */
export function thumbnailFromMediaUrl(url?: string | null): string | undefined {
  const abs = absoluteUrl(url)
  if (!abs) return undefined
  try {
    const parsed = new URL(abs)
    const host = parsed.hostname.toLowerCase()
    if (host.includes('youtu')) {
      const id = abs.match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([\w-]{11})/)?.[1]
      return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : undefined
    }
    if (host.includes('cloudflarestream.com') || host.includes('videodelivery.net')) {
      const uid = parsed.pathname.split('/').filter(Boolean)[0]
      if (uid && uid.length > 8) return `${parsed.origin}/${uid}/thumbnails/thumbnail.jpg`
    }
  } catch {
    return undefined
  }
  return undefined
}

export function teamCode(team: ApiTeam) {
  return team.shortName || team.name.slice(0, 3).toUpperCase()
}

export function logoOf(team: ApiTeam) {
  return absoluteUrl(team.logoUrl)
}

export function statusOf(match: ApiMatch): 'live' | 'upcoming' | 'completed' {
  const s = String(match.status || '').toLowerCase()
  if (s === 'live' || s === 'in progress') return 'live'
  if (s === 'completed' || s === 'finished') return 'completed'
  return 'upcoming'
}

export function matchHasScoringData(data: {
  matchInfo?: { status?: string; startedAt?: string }
  innings?: Array<{ runs?: number; wickets?: number; overs?: number }>
  ballByBall?: unknown[]
  scoreboard?: { innings1?: { batting?: unknown[] }; innings2?: { batting?: unknown[] } }
  battingStats?: unknown[]
}): boolean {
  const status = String(data.matchInfo?.status || '').toLowerCase()
  if (['live', 'in progress', 'completed', 'finished'].includes(status)) return true
  if (data.matchInfo?.startedAt) return true
  if ((data.ballByBall || []).length > 0) return true
  if ((data.battingStats || []).length > 0) return true
  if ((data.scoreboard?.innings1?.batting || []).length > 0) return true
  if ((data.scoreboard?.innings2?.batting || []).length > 0) return true
  for (const inn of data.innings || []) {
    if ((inn.runs ?? 0) > 0 || (inn.wickets ?? 0) > 0 || (inn.overs ?? 0) > 0) return true
  }
  return false
}

export function scoreFor(match: ApiMatch, team: ApiTeam): string {
  if (statusOf(match) === 'upcoming') return ''
  const inn = match.innings?.find(
    (i) =>
      (i.teamShortName && i.teamShortName.toLowerCase() === (team.shortName || '').toLowerCase()) ||
      (i.teamName && i.teamName.toLowerCase() === team.name.toLowerCase()),
  )
  if (!inn || inn.runs == null) return ''
  const overs = inn.overs == null ? '' : ` (${Number.isInteger(inn.overs) ? inn.overs : inn.overs.toFixed(1)})`
  return `${inn.runs}/${inn.wickets ?? 0}${overs}`
}

/** Cricket display overs — matches iOS `CricketOvers` (0.1…0.5, then 1.0 not 0.6). */
export function minOverInInnings(balls: Array<{ overNumber?: number; innings?: number; inningsNumber?: number }>, innings: number): number {
  const innBalls = balls.filter((b) => Number(b.innings ?? b.inningsNumber ?? 1) === innings)
  if (!innBalls.length) return 0
  return Math.min(...innBalls.map((b) => Number(b.overNumber ?? 0)))
}

export function oversBefore(overNumber: number, minOverInInnings: number): number {
  if (minOverInInnings <= 0) return Math.max(0, overNumber)
  return Math.max(0, overNumber - minOverInInnings)
}

export function ballLabel(overNumber: number, ballNumber: number, minOver: number): string {
  const before = oversBefore(overNumber, minOver)
  const ball = ballNumber <= 0 ? 1 : ballNumber
  if (ball >= 6) return `${before + 1}.0`
  return `${before}.${ball}`
}

export function overDisplayNumber(overNumber: number, minOver: number): number {
  return oversBefore(overNumber, minOver) + 1
}

export function formatWhen(iso?: string) {
  if (!iso) return 'TBD'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'TBD'
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  const isTomorrow = d.toDateString() === tomorrow.toDateString()
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return `Today, ${time}`
  if (isTomorrow) return `Tomorrow, ${time}`
  return d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function formatDateRange(start?: string, end?: string) {
  const s = start ? new Date(start) : null
  const e = end ? new Date(end) : null
  const fmt = (d: Date, withYear = true) =>
    d.toLocaleDateString('en-IN', withYear ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' })
  if (s && e) return `${fmt(s, false)} – ${fmt(e, true)}`
  if (s) return fmt(s)
  return 'Season 2026'
}

export function todayLabel() {
  return `Today ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`
}

type FirebaseFeed = {
  tournaments?: Record<
    string,
    {
      tournamentId?: string
      name?: string
      logoUrl?: string
      location?: string
      startDate?: string
      endDate?: string
      type?: string
      format?: string
      showOnOtt?: boolean
      matches?: Record<string, ApiMatch & { matchId?: string; balls?: Record<string, FirebaseBall> }>
    }
  >
  highlights?: Record<
    string,
    {
      id?: string
      type?: string
      url?: string
      title?: string
      description?: string
      thumbnailUrl?: string
      tournamentId?: string
      tournamentName?: string
      sortOrder?: number
      fromAdmin?: boolean
    }
  >
}

export async function fetchFirebaseFeed(): Promise<FirebaseFeed> {
  const res = await fetch(FIREBASE_OTT_URL)
  if (!res.ok) throw new Error(`Firebase ${res.status}`)
  const ott = await res.json()
  if (ott?.tournaments && Object.keys(ott.tournaments).length > 0) return ott

  // The scorer/admin publisher currently writes the live catalog under
  // tournament_feed/{installation}/tournaments. Keep the OTT reader compatible
  // with that canonical feed instead of showing an empty catalog when /ott is stale.
  const feedRes = await fetch(`${FIREBASE_RTDB}/tournament_feed.json`)
  if (!feedRes.ok) throw new Error(`Firebase tournament feed ${feedRes.status}`)
  const feed = await feedRes.json() as Record<string, any>
  const tournaments: Record<string, any> = {}
  for (const installation of Object.values(feed)) {
    for (const [key, tournament] of Object.entries((installation as any)?.tournaments || {})) {
      const t = tournament as any
      const tournamentId = String(t.tournament_id ?? t.tournamentId ?? key)
      const tournamentKey = String(t.tournament_uid ?? t.tournamentUid ?? key)
      const target = tournaments[tournamentKey] ||= {
        tournamentId,
        name: t.name || 'Tournament',
        logoUrl: t.logo_url || t.logoUrl,
        location: t.venue || t.location,
        type: t.type,
        format: t.format,
        showOnOtt: t.show_on_ott !== false,
        matches: {},
      }
      for (const [matchKey, match] of Object.entries(t.matches || {})) {
        const m = match as any
        const matchId = String(m.match_uid ?? m.matchUid ?? m.match_id ?? matchKey)
        target.matches[matchId] ||= {
          ...m,
          matchId,
          tournamentId,
          tournamentName: target.name,
          scheduledAt: m.scheduled_at || m.scheduledAt,
          status: m.status || 'scheduled',
          highlightUrl: m.highlight_url || m.highlightUrl,
          liveUrl: m.youtube_url || m.live_url || m.liveUrl,
          team1: m.team1 || m.team_a || { name: 'TBD' },
          team2: m.team2 || m.team_b || { name: 'TBD' },
        }
      }
    }
  }
  return { tournaments }
}

export function mapFirebaseTournaments(feed: FirebaseFeed): ApiTournament[] {
  return Object.values(feed.tournaments || {})
    .filter((t) => t.showOnOtt !== false)
    .filter((t) => (t.tournamentId || '') !== 'demo-jbmr')
    .map((t) => ({
      tournamentId: t.tournamentId || 'unknown',
      name: t.name || 'Tournament',
      logoUrl: t.logoUrl,
      location: t.location,
      startDate: t.startDate,
      endDate: t.endDate,
      type: t.type,
      format: t.format,
      matches: Object.values(t.matches || {}).map((m) => ({
        ...m,
        matchId: m.matchId || 'unknown',
        status: m.status || 'scheduled',
        team1: m.team1 || { name: 'TBD' },
        team2: m.team2 || { name: 'TBD' },
        balls: m.balls,
      })),
    }))
}

export type ApiHighlight = {
  id: string
  type: string
  url: string
  title?: string
  thumbnailUrl?: string
  tournamentName?: string
  sortOrder?: number
}

export function mapFirebaseHighlights(feed: FirebaseFeed): ApiHighlight[] {
  return Object.values(feed.highlights || {})
    .filter((h) => h.fromAdmin === true)
    .filter((h) => (h.tournamentId || '') !== 'demo-jbmr')
    .filter((h) => {
      const url = h.url || ''
      return url.length > 0 && !url.includes('dQw4w9WgXcQ')
    })
    .map((h) => ({
      id: h.id || crypto.randomUUID(),
      type: h.type || 'match_highlight',
      url: h.url || '',
      title: h.title,
      thumbnailUrl: h.thumbnailUrl || thumbnailFromMediaUrl(h.url),
      tournamentName: h.tournamentName,
      sortOrder: h.sortOrder,
    }))
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
}

export function findMatchInFeed(
  matchId: string,
  feed: FirebaseFeed,
): { tournament: NonNullable<FirebaseFeed['tournaments']>[string]; match: ApiMatch } | null {
  for (const t of Object.values(feed.tournaments || {})) {
    if (t.showOnOtt === false) continue
    for (const m of Object.values(t.matches || {})) {
      if ((m.matchId || '') === matchId) {
        return {
          tournament: t,
          match: {
            ...m,
            matchId: m.matchId || matchId,
            status: m.status || 'scheduled',
            team1: m.team1 || { name: 'TBD' },
            team2: m.team2 || { name: 'TBD' },
            balls: m.balls,
          },
        }
      }
    }
  }
  return null
}

export function mergeBallVideos(data: Record<string, unknown>, balls?: Record<string, FirebaseBall>) {
  if (!balls || !Object.keys(balls).length) return data
  const byId = balls
  const bySpot = new Map<string, FirebaseBall>()
  for (const b of Object.values(balls)) {
    if (b.innings == null || b.over == null || b.ball == null) continue
    const key = `${b.innings}-${b.over}-${b.ball}`
    const hasVideo = Boolean(b.videoUrl)
    if (!bySpot.has(key) || hasVideo) bySpot.set(key, b)
  }
  const bbb = data.ballByBall as Array<Record<string, unknown>> | undefined
  if (!bbb?.length) return data
  const merged = bbb.map((event) => {
    const id = String(event.id || '')
    const fromId = id ? byId[id] : undefined
    const fromSpot = bySpot.get(`${event.innings ?? 0}-${event.overNumber ?? 0}-${event.ballNumber ?? 0}`)
    const videoUrl = [fromId?.videoUrl, fromSpot?.videoUrl, event.videoUrl as string | undefined].find(
      (u) => u && String(u).length > 0,
    )
    return videoUrl ? { ...event, videoUrl } : event
  })
  return { ...data, ballByBall: merged }
}

export function toCompleteMatchFromFeed(
  tournament: NonNullable<FirebaseFeed['tournaments']>[string],
  match: ApiMatch,
) {
  const team1Name = match.team1?.name || 'Team A'
  const completed = ['completed', 'finished'].includes((match.status || '').toLowerCase())
  const ballByBall = Object.entries(match.balls || {})
    .sort(([, a], [, b]) => {
      const ka = (a.innings ?? 0) * 10000 + (a.over ?? 0) * 10 + (a.ball ?? 0)
      const kb = (b.innings ?? 0) * 10000 + (b.over ?? 0) * 10 + (b.ball ?? 0)
      return ka - kb
    })
    .map(([key, b]) => ({
      id: b.id || key,
      innings: b.innings,
      overNumber: b.over,
      ballNumber: b.ball,
      batRuns: b.runs ?? 0,
      wicket: b.isWicket ?? false,
      videoUrl: b.videoUrl,
      striker: { name: team1Name },
      bowler: { name: 'Bowler' },
      shotName: b.note,
    }))

  return {
    matchInfo: {
      id: match.matchId,
      matchSeq: match.matchSeq,
      tournament: {
        id: tournament.tournamentId,
        name: tournament.name,
        logoUrl: tournament.logoUrl,
        location: tournament.location,
        type: tournament.type,
      },
      team1: { ...match.team1, logoUrl: match.team1?.logoUrl },
      team2: { ...match.team2, logoUrl: match.team2?.logoUrl },
      venue: match.venue,
      status: match.status || 'scheduled',
      scheduledAt: match.scheduledAt,
      startedAt: match.startedAt,
      endedAt: match.endedAt,
      result: match.result,
    },
    innings: (match.innings || []).map((inn, i) => ({
      number: inn.inningsNumber ?? i + 1,
      runs: inn.runs,
      wickets: inn.wickets,
      overs: inn.overs,
      battingTeamName: inn.teamName,
      battingTeamShortName: inn.teamShortName,
      isCompleted: completed,
    })),
    battingStats: [],
    bowlingStats: [],
    scoreboard: null,
    fallOfWickets: null,
    ballByBall,
  }
}

export async function fetchTournaments(_activeOnly = true): Promise<ApiTournament[]> {
  try {
    const feed = await fetchFirebaseFeed()
    const list = mapFirebaseTournaments(feed)
    if (list.length) return list
  } catch {
    /* try API */
  }
  try {
    const url = `${API_BASE}/api/tournaments/list-public?activeOnly=false`
    const res = await fetch(url)
    if (!res.ok) return []
    const data = await res.json()
    return (data.tournaments || []) as ApiTournament[]
  } catch {
    return []
  }
}

export async function fetchHighlights(): Promise<ApiHighlight[]> {
  try {
    const feed = await fetchFirebaseFeed()
    const list = mapFirebaseHighlights(feed)
    if (list.length) return list
  } catch {
    /* no CrickDB fallback — highlights are admin-published on Firebase only */
  }
  return []
}

/** Merge Firebase matchDetails with feed/API fallback — keep richer matchInfo from primary. */
export function mergeMatchPayload(
  primary: Record<string, unknown>,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  const primaryMi = { ...((primary.matchInfo as Record<string, unknown>) || {}) }
  const fallbackMi = { ...((fallback.matchInfo as Record<string, unknown>) || {}) }
  const matchInfo = { ...fallbackMi, ...primaryMi }

  const pickArray = (a: unknown, b: unknown) => {
    const arrA = Array.isArray(a) ? a : []
    const arrB = Array.isArray(b) ? b : []
    return arrA.length ? arrA : arrB
  }

  return {
    ...fallback,
    ...primary,
    matchInfo,
    innings: pickArray(primary.innings, fallback.innings),
    ballByBall: pickArray(primary.ballByBall, fallback.ballByBall),
    battingStats: pickArray(primary.battingStats, fallback.battingStats),
    bowlingStats: pickArray(primary.bowlingStats, fallback.bowlingStats),
    scoreboard: primary.scoreboard ?? fallback.scoreboard,
    fallOfWickets: primary.fallOfWickets ?? fallback.fallOfWickets,
  }
}

export async function fetchCompleteMatch(matchId: string) {
  let feed: FirebaseFeed = {}
  try {
    feed = await fetchFirebaseFeed()
  } catch {
    feed = {}
  }

  const pair = findMatchInFeed(matchId, feed)

  const attachFeedMeta = (raw: Record<string, unknown>) => {
    let merged = { ...raw }
    if (pair) {
      merged = mergeBallVideos(merged, pair.match.balls) as Record<string, unknown>
      const mi = { ...((merged.matchInfo as Record<string, unknown>) || {}) }
      const m = pair.match
      if (m.liveUrl) mi.liveUrl = m.liveUrl
      if (m.highlightUrl) mi.highlightUrl = m.highlightUrl
      if (m.thumbnailUrl) mi.thumbnailUrl = m.thumbnailUrl
      if (!mi.venue && m.venue) mi.venue = m.venue
      if (!mi.status && m.status) mi.status = m.status
      if (!mi.result && m.result) mi.result = m.result
      merged.matchInfo = mi
    }
    return merged
  }

  try {
    const res = await fetch(`${FIREBASE_RTDB}/ott/matchDetails/${encodeURIComponent(matchId)}.json`)
    if (res.ok) {
      const data = await res.json()
      if (data && typeof data === 'object') {
        let merged = attachFeedMeta(data as Record<string, unknown>)
        if (!matchHasScoringData(merged)) {
          try {
            const apiRes = await fetch(
              `${API_BASE}/api/matches/complete-public?matchId=${encodeURIComponent(matchId)}`,
            )
            if (apiRes.ok) {
              merged = attachFeedMeta((await apiRes.json()) as Record<string, unknown>)
            }
          } catch {
            /* keep firebase partial */
          }
        }
        if (!matchHasScoringData(merged) && pair) {
          const fromFeed = attachFeedMeta(
            toCompleteMatchFromFeed(pair.tournament, pair.match) as Record<string, unknown>,
          )
          merged = attachFeedMeta(mergeMatchPayload(merged, fromFeed))
        }
        return merged
      }
    }
  } catch {
    /* fallback */
  }

  if (pair) return attachFeedMeta(toCompleteMatchFromFeed(pair.tournament, pair.match) as Record<string, unknown>)

  try {
    const res = await fetch(`${API_BASE}/api/matches/complete-public?matchId=${encodeURIComponent(matchId)}`)
    if (res.ok) return attachFeedMeta((await res.json()) as Record<string, unknown>)
  } catch {
    /* fall through */
  }

  throw new Error('Match not found — Admin se tournament ON + Sync scorecards karo')
}

export function hasSquadData(data: Record<string, unknown>): boolean {
  const bat = (data.battingStats as unknown[]) || []
  const bowl = (data.bowlingStats as unknown[]) || []
  const sb = data.scoreboard as { innings1?: { batting?: unknown[] }; innings2?: { batting?: unknown[] } } | null
  return (
    bat.length > 0 ||
    bowl.length > 0 ||
    (sb?.innings1?.batting?.length ?? 0) > 0 ||
    (sb?.innings2?.batting?.length ?? 0) > 0
  )
}

export type ShortClip = {
  id: string
  title: string
  tag: string
  videoUrl: string
}

export function shortClipsFromFeed(feed: FirebaseFeed): ShortClip[] {
  const clips: ShortClip[] = []
  for (const t of Object.values(feed.tournaments || {})) {
    if (t.showOnOtt === false) continue
    const tName = t.name || 'Tournament'
    for (const m of Object.values(t.matches || {})) {
      const home = m.team1?.shortName || m.team1?.name || 'T1'
      const away = m.team2?.shortName || m.team2?.name || 'T2'
      const tag = `${home} vs ${away} · ${tName}`
      const balls = Object.values(m.balls || {}).sort((a, b) => {
        const ka = (a.innings ?? 0) * 10000 + (a.over ?? 0) * 10 + (a.ball ?? 0)
        const kb = (b.innings ?? 0) * 10000 + (b.over ?? 0) * 10 + (b.ball ?? 0)
        return ka - kb
      })
      for (const b of balls) {
        const url = absoluteUrl(b.videoUrl)
        if (!url) continue
        const over = `${b.over ?? 0}.${b.ball ?? 1}`
        const title = b.note || (b.isWicket ? `Wicket · Over ${over}` : `Over ${over} · ${b.runs ?? 0} run`)
        clips.push({
          id: `${m.matchId}-${b.id || over}-${clips.length}`,
          title,
          tag,
          videoUrl: url,
        })
      }
    }
  }
  return clips
}

export async function fetchShortClips(): Promise<ShortClip[]> {
  const feed = await fetchFirebaseFeed()
  return shortClipsFromFeed(feed)
}

export function tournamentLogo(t: ApiTournament) {
  return absoluteUrl(t.logoUrl)
}

export function flattenMatches(tournaments: ApiTournament[]): ApiMatch[] {
  return tournaments.flatMap((t) =>
    t.matches.map((m) => ({
      ...m,
      tournamentName: t.name,
      tournamentId: t.tournamentId,
    })),
  )
}

export function featuredCarousel(matches: ApiMatch[], limit = 8) {
  const live = matches.filter((m) => statusOf(m) === 'live')
  const upcoming = matches.filter((m) => statusOf(m) === 'upcoming')
  const completed = matches.filter((m) => statusOf(m) === 'completed')
  return [...live, ...upcoming.slice(0, 4), ...completed.slice(0, 3)].slice(0, limit)
}
