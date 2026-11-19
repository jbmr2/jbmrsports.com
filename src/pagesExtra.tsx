import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  absoluteUrl,
  fetchCompleteMatch,
  fetchTournaments,
  flattenMatches,
  formatDateRange,
  formatWhen,
  ballLabel,
  minOverInInnings,
  overDisplayNumber,
  hasSquadData,
  logoOf,
  matchHasScoringData,
  scoreFor,
  statusOf,
  teamCode,
  tournamentLogo,
} from './api'
import type { ApiMatch, ApiTeam, ApiTournament } from './api'
import { Logo } from './components'
import { useUserStore } from './userStore'

function formatScheduleDay(date: Date) {
  const now = new Date()
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  const label = date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  if (date.toDateString() === now.toDateString()) return `Today, ${label}`
  if (date.toDateString() === tomorrow.toDateString()) return `Tomorrow, ${label}`
  return date.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
}

function formatScheduleDayShort(date: Date) {
  return date.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' })
}

function countdownToMatch(scheduledAt?: string): string | null {
  if (!scheduledAt) return null
  const target = new Date(scheduledAt)
  if (Number.isNaN(target.getTime())) return null
  const diff = target.getTime() - Date.now()
  if (diff <= 0) return null
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  if (h > 24) return null
  return `Match starts in ${h}h ${m}m`
}

function weekDaysAround(selected: Date) {
  const start = new Date(selected)
  start.setHours(0, 0, 0, 0)
  const day = start.getDay()
  const mondayOffset = day === 0 ? -6 : 1 - day
  start.setDate(start.getDate() + mondayOffset)
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
}

function liveOverMeta(match: ApiMatch): string {
  const innings = [...(match.innings || [])].sort(
    (a, b) => (a.inningsNumber ?? 0) - (b.inningsNumber ?? 0),
  )
  const last = innings.at(-1)
  if (!last?.overs) return ''
  const over = Number.isInteger(last.overs) ? `${last.overs}` : last.overs.toFixed(1)
  return `Over ${over}`
}

function scheduleTeamScore(match: ApiMatch, team: ApiTeam): string {
  if (statusOf(match) === 'upcoming') return 'Yet to bat'
  const score = scoreFor(match, team)
  return score || '—'
}

function scheduleSummary(match: ApiMatch): { text: string; accent?: boolean } {
  const st = statusOf(match)
  if (st === 'completed') {
    return { text: match.result?.summaryText || 'Match completed' }
  }
  if (st === 'upcoming') {
    const stage = match.stage?.trim()
    if (stage) return { text: stage }
    return { text: formatWhen(match.scheduledAt) }
  }
  const summary = match.result?.summaryText
  if (summary) return { text: summary, accent: true }
  return { text: 'Live now', accent: true }
}

function scheduleMetaRight(match: ApiMatch): string {
  const st = statusOf(match)
  if (st === 'live') return liveOverMeta(match) || 'In progress'
  if (st === 'completed') return 'Completed'
  return formatWhen(match.scheduledAt)
}

function ScheduleMatchCard({ match }: { match: ApiMatch }) {
  const st = statusOf(match)
  const summary = scheduleSummary(match)
  const countdown = st === 'upcoming' ? countdownToMatch(match.scheduledAt) : null

  return (
    <Link to={`/match/${match.matchId}`} className={`web-schedule-card ${st}`}>
      <div className="web-schedule-card-top">
        <span className={`web-schedule-badge ${st}`}>
          {st === 'live' ? 'LIVE' : st === 'completed' ? 'COMPLETED' : 'UPCOMING'}
        </span>
        <span className="web-schedule-meta-right">{scheduleMetaRight(match)}</span>
      </div>
      <div className="web-schedule-teams">
        <div className="web-schedule-team">
          <Logo className="flag" src={logoOf(match.team1)} fallback={teamCode(match.team1)} />
          <span className="name">{match.team1.name}</span>
          <span className="score">{scheduleTeamScore(match, match.team1)}</span>
        </div>
        <div className="web-schedule-team">
          <Logo className="flag" src={logoOf(match.team2)} fallback={teamCode(match.team2)} />
          <span className="name">{match.team2.name}</span>
          <span className="score">{scheduleTeamScore(match, match.team2)}</span>
        </div>
      </div>
      {countdown ? <p className="web-schedule-countdown">{countdown}</p> : null}
      <p className={`web-schedule-summary ${summary.accent ? 'accent' : ''} ${st === 'completed' ? 'won' : ''}`}>
        {summary.text}
      </p>
      {match.venue ? <p className="web-schedule-venue">{match.venue}</p> : null}
    </Link>
  )
}

export function SchedulePage() {
  const [tournaments, setTournaments] = useState<ApiTournament[]>([])
  const [dayOffset, setDayOffset] = useState(0)
  const [tournamentFilter, setTournamentFilter] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showCalendar, setShowCalendar] = useState(false)
  const [pickedDate, setPickedDate] = useState('')

  const SPORT_PILLS = ['Cricket', 'Football', 'Kabaddi', 'Tennis'] as const

  useEffect(() => {
    fetchTournaments(true)
      .then(setTournaments)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const selectedDate = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() + dayOffset)
    return d
  }, [dayOffset])

  const goToday = () => setDayOffset(0)

  const applyPickedDate = () => {
    if (!pickedDate) return
    const target = new Date(pickedDate)
    target.setHours(0, 0, 0, 0)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const diff = Math.round((target.getTime() - today.getTime()) / 86400000)
    setDayOffset(diff)
    setShowCalendar(false)
  }

  const matches = useMemo(() => {
    let all = flattenMatches(tournaments)
    if (tournamentFilter) {
      all = all.filter((m) => m.tournamentId === tournamentFilter)
    }
    const forDay = all.filter((m) => {
      if (statusOf(m) === 'live') return true
      if (!m.scheduledAt) return dayOffset === 0
      const d = new Date(m.scheduledAt)
      if (Number.isNaN(d.getTime())) return dayOffset === 0
      return d.toDateString() === selectedDate.toDateString()
    })
    if (dayOffset === 0 && forDay.length === 0 && !tournamentFilter) return all
    return forDay
  }, [tournaments, dayOffset, selectedDate, tournamentFilter])

  const weekDays = useMemo(() => weekDaysAround(selectedDate), [selectedDate])
  const today = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d
  }, [])

  const hasLive = matches.some((m) => statusOf(m) === 'live')

  const groups = useMemo(() => {
    const map = new Map<string, { matches: ApiMatch[]; format: string; id?: string }>()
    for (const m of matches) {
      const key = m.tournamentName || 'Tournament'
      if (!map.has(key)) {
        const tour = tournaments.find((t) => t.tournamentId === m.tournamentId)
        map.set(key, {
          matches: [],
          format: tour?.type || tour?.format || 'T20',
          id: m.tournamentId,
        })
      }
      map.get(key)!.matches.push(m)
    }
    return [...map.entries()]
      .map(([name, group]) => ({
        name,
        id: group.id,
        format: group.format,
        matches: group.matches.sort((a, b) => {
          const rank = (m: ApiMatch) =>
            statusOf(m) === 'live' ? 0 : statusOf(m) === 'upcoming' ? 1 : 2
          return rank(a) - rank(b)
        }),
      }))
      .sort((a, b) => {
        const al = a.matches.some((m) => statusOf(m) === 'live')
        const bl = b.matches.some((m) => statusOf(m) === 'live')
        if (al !== bl) return al ? -1 : 1
        return a.name.localeCompare(b.name)
      })
  }, [matches, tournaments])

  if (error) return <div className="web-error">{error}</div>
  if (loading) return <div className="web-schedule-loading">Loading schedule…</div>

  return (
    <div className="web-schedule">
      <div className="web-schedule-top-row">
        <div className="web-schedule-pills">
          {SPORT_PILLS.map((sport) => (
            <button
              key={sport}
              type="button"
              className={`web-schedule-pill ${sport === 'Cricket' ? 'active' : 'disabled'}`}
              disabled={sport !== 'Cricket'}
            >
              {sport}
            </button>
          ))}
        </div>
        <div className="web-schedule-date">
          <button type="button" className="web-schedule-date-btn" aria-label="Previous day" onClick={() => setDayOffset((d) => d - 1)}>
            ‹
          </button>
          <div className="web-schedule-date-label">
            <strong>{formatScheduleDay(selectedDate)}</strong>
            {hasLive ? <span className="web-schedule-live-tag">LIVE NOW</span> : null}
          </div>
          <button type="button" className="web-schedule-date-btn" aria-label="Next day" onClick={() => setDayOffset((d) => d + 1)}>
            ›
          </button>
        </div>
      </div>

      <div className="web-schedule-tournament-rail">
        <button
          type="button"
          className={`web-schedule-tour-chip ${!tournamentFilter ? 'active' : ''}`}
          onClick={() => setTournamentFilter(null)}
        >
          All Matches
        </button>
        {tournaments.map((t) => (
          <button
            key={t.tournamentId}
            type="button"
            className={`web-schedule-tour-chip ${tournamentFilter === t.tournamentId ? 'active' : ''}`}
            onClick={() => setTournamentFilter(t.tournamentId)}
          >
            {t.name}
          </button>
        ))}
      </div>

      <div className="web-schedule-week-strip">
        {weekDays.map((d) => {
          const isSelected = d.toDateString() === selectedDate.toDateString()
          const offset = Math.round((d.getTime() - today.getTime()) / 86400000)
          return (
            <button
              key={d.toISOString()}
              type="button"
              className={`web-schedule-day ${isSelected ? 'active' : ''}`}
              onClick={() => setDayOffset(offset)}
            >
              {formatScheduleDayShort(d)}
            </button>
          )
        })}
      </div>

      {groups.length === 0 ? (
        <div className="web-schedule-empty">No matches for this day</div>
      ) : (
        groups.map((g) => (
          <section className="web-schedule-group" key={g.name}>
            <div className="web-schedule-group-head">
              <span className="bar" aria-hidden />
              {g.id ? (
                <Link to={`/tournament/${g.id}`} className="tournament-link">
                  <h2>{g.name}</h2>
                </Link>
              ) : (
                <h2>{g.name}</h2>
              )}
              <span className="format-badge">{g.format}</span>
            </div>
            <div className="web-schedule-grid">
              {g.matches.map((m) => (
                <ScheduleMatchCard key={m.matchId} match={m} />
              ))}
            </div>
          </section>
        ))
      )}

      {dayOffset !== 0 ? (
        <button type="button" className="web-schedule-fab" onClick={goToday}>
          Today
        </button>
      ) : null}

      {showCalendar ? (
        <div className="reel-picker-overlay" role="dialog" aria-modal="true">
          <div className="reel-picker">
            <header>
              <h3>Jump to date</h3>
              <button type="button" onClick={() => setShowCalendar(false)} aria-label="Close">
                ✕
              </button>
            </header>
            <input
              type="date"
              className="search-input"
              value={pickedDate || selectedDate.toISOString().slice(0, 10)}
              onChange={(e) => setPickedDate(e.target.value)}
            />
            <button type="button" className="reel-btn primary" style={{ width: '100%' }} onClick={applyPickedDate}>
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function TournamentPage() {
  const { id } = useParams()
  const [tournament, setTournament] = useState<ApiTournament | null>(null)
  const [tab, setTab] = useState<'matches' | 'points' | 'stats' | 'teams'>('matches')
  const [filter, setFilter] = useState<'all' | 'live' | 'upcoming' | 'completed'>('all')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchTournaments(true)
      .then((list) => setTournament(list.find((t) => t.tournamentId === id) || null))
      .catch((e) => setError(e.message))
  }, [id])

  if (error) return <div className="error">{error}</div>
  if (!tournament) return <div className="loading">Loading tournament…</div>

  const matches = tournament.matches.filter((m) => (filter === 'all' ? true : statusOf(m) === filter))
  const teams = uniqueTeams(tournament.matches)
  const ongoing = tournament.matches.some((m) => statusOf(m) !== 'completed')

  return (
    <>
      <div className="banner">
        <Logo className="lg" src={tournamentLogo(tournament)} fallback={tournament.name} />
        <h1>{tournament.name}</h1>
        <div className="muted">{formatDateRange(tournament.startDate, tournament.endDate)}</div>
        <div className="muted">
          {teams.length} Teams · {tournament.matches.length} Matches · {tournament.type || tournament.format || 'T20'}
        </div>
        <span className="ongoing">● {ongoing ? 'ONGOING' : 'COMPLETED'}</span>
      </div>

      <div className="tabs">
        {(
          [
            ['matches', 'Matches'],
            ['points', 'Points Table'],
            ['stats', 'Stats'],
            ['teams', 'Teams'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'matches' ? (
        <>
          <div className="chips">
            {(['all', 'live', 'upcoming', 'completed'] as const).map((f) => (
              <button key={f} className={`chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
                {f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          <div className="web-schedule-grid">
            {matches.map((m) => (
              <ScheduleMatchCard
                key={m.matchId}
                match={{ ...m, tournamentName: tournament.name, tournamentId: tournament.tournamentId }}
              />
            ))}
          </div>
        </>
      ) : null}

      {tab === 'points' ? <PointsFromResults matches={tournament.matches} /> : null}

      {tab === 'stats' ? (
        <div className="grid stats2">
          <Stat label="Total Matches" value={String(tournament.matches.length)} accent />
          <Stat label="Live" value={String(tournament.matches.filter((m) => statusOf(m) === 'live').length)} />
          <Stat label="Upcoming" value={String(tournament.matches.filter((m) => statusOf(m) === 'upcoming').length)} />
          <Stat label="Completed" value={String(tournament.matches.filter((m) => statusOf(m) === 'completed').length)} accent />
        </div>
      ) : null}

      {tab === 'teams' ? (
        <div className="grid matches">
          {teams.map((t) => (
            <div key={t.name} className="card match-card" style={{ flexDirection: 'row', display: 'flex', alignItems: 'center', gap: 12 }}>
              <Logo src={t.logo} fallback={t.code} />
              <div>
                <div style={{ fontWeight: 800 }}>{t.name}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {t.code}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="stat-card">
      <div className="label">{label}</div>
      <div className={`value ${accent ? 'accent' : ''}`}>{value}</div>
    </div>
  )
}

function PointsFromResults({ matches }: { matches: ApiMatch[] }) {
  const rows = useMemo(() => {
    const map = new Map<string, { name: string; code: string; played: number; won: number }>()
    for (const m of matches.filter((x) => statusOf(x) === 'completed')) {
      for (const team of [m.team1, m.team2]) {
        const key = team.name
        const cur = map.get(key) || { name: team.name, code: teamCode(team), played: 0, won: 0 }
        cur.played += 1
        map.set(key, cur)
      }
      const summary = (m.result?.summaryText || '').toLowerCase()
      for (const [key, row] of map) {
        if (summary.includes(key.toLowerCase()) || summary.startsWith(row.code.toLowerCase())) {
          row.won += 1
          break
        }
      }
    }
    return [...map.values()]
      .map((r) => ({ ...r, lost: Math.max(0, r.played - r.won), points: r.won * 2 }))
      .sort((a, b) => b.points - a.points || b.won - a.won)
  }, [matches])

  if (!rows.length) return <div className="empty">Points table will appear after results</div>

  return (
    <div className="panel">
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>Team</th>
            <th>P</th>
            <th>W</th>
            <th>L</th>
            <th>Pts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.name}>
              <td>{i + 1}</td>
              <td>{r.name}</td>
              <td>{r.played}</td>
              <td>{r.won}</td>
              <td>{r.lost}</td>
              <td style={{ color: 'var(--accent)', fontWeight: 800 }}>{r.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function uniqueTeams(matches: ApiMatch[]) {
  const map = new Map<string, { name: string; code: string; logo?: string }>()
  for (const m of matches) {
    for (const t of [m.team1, m.team2]) {
      if (!map.has(t.name)) map.set(t.name, { name: t.name, code: teamCode(t), logo: t.logoUrl })
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function UpcomingMatchPreview({ info }: { info: Record<string, any> }) {
  const t1 = info.team1
  const t2 = info.team2
  const tossLine =
    info.tossWinner?.name && info.tossDecision
      ? `${info.tossWinner.shortName || info.tossWinner.name} won toss · chose to ${info.tossDecision}`
      : null

  return (
    <div className="web-match-upcoming">
      <div className="web-match-upcoming-teams">
        <div className="web-match-upcoming-team">
          <Logo src={logoOf(t1)} fallback={t1?.shortName || t1?.name || 'T1'} className="web-match-upcoming-logo" />
          <strong>{t1?.shortName || t1?.name || 'Team 1'}</strong>
          <span>{t1?.name}</span>
        </div>
        <div className="web-match-upcoming-vs">VS</div>
        <div className="web-match-upcoming-team">
          <Logo src={logoOf(t2)} fallback={t2?.shortName || t2?.name || 'T2'} className="web-match-upcoming-logo" />
          <strong>{t2?.shortName || t2?.name || 'Team 2'}</strong>
          <span>{t2?.name}</span>
        </div>
      </div>
      <div className="web-match-upcoming-meta">
        <p className="web-match-upcoming-when">{formatWhen(info.scheduledAt)}</p>
        {info.venue ? <p>{info.venue}</p> : null}
        {tossLine ? <p>{tossLine}</p> : null}
        {info.overs ? <p>{info.overs} overs · {info.tournament?.type || 'T20'}</p> : null}
      </div>
      <p className="web-match-upcoming-note">
        Scorecard, ball-by-ball, and squads will appear once the match goes live.
      </p>
    </div>
  )
}

function MatchBgLogo({ src }: { src?: string }) {
  if (!src) return null
  return (
    <img
      src={src}
      alt=""
      onError={(e) => {
        e.currentTarget.style.display = 'none'
      }}
    />
  )
}

function MatchHeroTeams({ info, compact }: { info: Record<string, any>; compact?: boolean }) {
  const t1 = info.team1
  const t2 = info.team2
  return (
    <div className={`web-match-hero-teams ${compact ? 'compact' : ''}`}>
      <div className="web-match-hero-team">
        <Logo
          src={logoOf(t1)}
          fallback={teamCode(t1)}
          className={compact ? 'web-match-hero-logo sm' : 'web-match-hero-logo'}
        />
        <strong>{t1?.shortName || t1?.name || 'Team 1'}</strong>
      </div>
      <span className="web-match-hero-vs">VS</span>
      <div className="web-match-hero-team">
        <Logo
          src={logoOf(t2)}
          fallback={teamCode(t2)}
          className={compact ? 'web-match-hero-logo sm' : 'web-match-hero-logo'}
        />
        <strong>{t2?.shortName || t2?.name || 'Team 2'}</strong>
      </div>
    </div>
  )
}

export function MatchPage() {
  const { id } = useParams()
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [tab, setTab] = useState<'scorecard' | 'bbb' | 'commentary' | 'squads' | 'stats' | 'points'>('scorecard')
  const [inningsTab, setInningsTab] = useState(1)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    fetchCompleteMatch(id)
      .then((payload) => {
        setData(payload as Record<string, unknown>)
        setError(null)
      })
      .catch((e) => setError(e.message))
  }, [id])

  const { addWatchHistory } = useUserStore()
  useEffect(() => {
    if (id && data) addWatchHistory(id)
  }, [id, data, addWatchHistory])

  if (error) return <div className="web-error">{error}</div>
  if (!data) return <div className="web-loading">Loading match…</div>

  const info = (data.matchInfo || {}) as Record<string, any>
  const balls = (data.ballByBall || []) as any[]
  const hasScoring = matchHasScoringData(data)
  const squadsReady = hasSquadData(data)
  const st = String(info.status || '').toLowerCase()
  const isLive = st.includes('live')
  const isUpcoming = !hasScoring && !['live', 'in progress', 'completed', 'finished'].includes(st)

  const streamUrl = isLive
    ? absoluteUrl(info.liveUrl)
    : absoluteUrl(info.highlightUrl)
  const hasPlayer = Boolean(streamUrl)

  const tossLine =
    info.tossWinner?.name && info.tossDecision
      ? `${info.tossWinner.shortName || info.tossWinner.name} won toss · ${info.tossDecision}`
      : null

  const inningsPanels = buildInningsPanels(data)
  const activeInnings = inningsPanels.find((p) => p.number === inningsTab) || inningsPanels[0]
  const inningsOptions = inningsNumbersInBalls(balls).length
    ? inningsNumbersInBalls(balls)
    : inningsPanels.map((p) => p.number).length
      ? inningsPanels.map((p) => p.number)
      : [1]
  const matchTitle = `${info.team1?.shortName || 'T1'} vs ${info.team2?.shortName || 'T2'}`
  const tourLine = `${info.tournament?.name || 'Tournament'}${info.matchSeq ? ` (Match ${info.matchSeq})` : ''}`
  const primaryScore = activeInnings?.summary
    ? `${activeInnings.summary.runs ?? 0}/${activeInnings.summary.wickets ?? 0}`
    : isUpcoming
      ? '—'
      : scoreFor(
          { status: info.status, team1: info.team1, team2: info.team2, innings: info.innings } as ApiMatch,
          info.team1,
        ) || '—'
  const primaryOvers = activeInnings?.summary?.overs ?? '—'
  const posterUrl =
    absoluteUrl(info.thumbnailUrl) ||
    absoluteUrl(info.tournament?.bannerUrl) ||
    absoluteUrl(info.highlightUrl)

  return (
    <div className="web-match-page">
      <section className="web-match-video-wrap">
        <div
          className="web-match-video-stage"
          style={
            {
              '--hero-c1': info.team1?.themeColor || '#0d2b6e',
              '--hero-c2': info.team2?.themeColor || '#3b1a00',
            } as CSSProperties
          }
        >
          <div className="web-match-hero-bg-layer" aria-hidden>
            {!hasPlayer && posterUrl ? (
              <img className="web-match-hero-bg" src={posterUrl} alt="" />
            ) : null}
            <div className="web-match-logo-watermark left">
              <MatchBgLogo src={logoOf(info.team1)} />
            </div>
            <div className="web-match-logo-watermark right">
              <MatchBgLogo src={logoOf(info.team2)} />
            </div>
          </div>
          {hasPlayer ? (
            <video
              className="web-match-player"
              src={streamUrl}
              controls
              playsInline
              poster={posterUrl}
            />
          ) : !posterUrl ? (
            <div className="web-match-video-fallback" />
          ) : null}
          <MatchHeroTeams info={info} compact={hasPlayer} />
          <div className="web-match-video-top">
            <div className="web-match-video-meta">
              {isLive ? <span className="web-match-live-pill">● LIVE</span> : null}
              {isLive ? <span className="web-match-viewers">👁 1.4M Watching</span> : null}
              {!isLive && info.status ? (
                <span className={`web-schedule-badge ${st.includes('complete') || st === 'finished' ? 'completed' : 'upcoming'}`}>
                  {String(info.status).toUpperCase()}
                </span>
              ) : null}
            </div>
            <div className="web-match-title-badge">
              {matchTitle} • {tourLine}
            </div>
          </div>
          {hasScoring && activeInnings ? (
            <div className="web-match-score-overlay">
              <div className="web-match-mini-score">
                <div className="web-match-mini-score-main">
                  <strong>{activeInnings.title.split('—')[0]?.trim() || 'INN'}</strong>
                  <span className="score-big">{primaryScore}</span>
                  <span className="overs">({primaryOvers} Overs)</span>
                </div>
                {info.result?.summaryText ? (
                  <p className="web-match-target">{info.result.summaryText}</p>
                ) : null}
              </div>
              {isLive ? <span className="web-match-4k">4K STREAM</span> : null}
            </div>
          ) : isUpcoming ? (
            <div className="web-match-upcoming-overlay">
              <p>{formatWhen(info.scheduledAt)}</p>
              {info.venue ? <p className="web-match-upcoming-venue">{info.venue}</p> : null}
            </div>
          ) : null}
          <div className="web-match-video-controls">
            <span>▶ Live UltraHD</span>
            <span className="web-match-quality">1080p 60fps</span>
          </div>
        </div>
      </section>

      <div className="web-match-body">
        <section className="web-match-main panel">
          <div className="web-match-tabs">
            {(
              [
                ['bbb', 'Ball by Ball'],
                ['scorecard', 'Scorecard'],
                ['commentary', 'Commentary'],
                ['stats', 'Stats'],
                ['squads', 'Squads'],
                ['points', 'Points Table'],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
                {label}
              </button>
            ))}
          </div>

          {isUpcoming && tab === 'scorecard' ? <UpcomingMatchPreview info={info} /> : null}

          {tab === 'scorecard' && hasScoring ? (
            <>
              <InningsTabBar innings={inningsOptions} active={inningsTab} onChange={setInningsTab} />
              {activeInnings ? (
                <FigmaScorecard panel={activeInnings} balls={balls} inningsNumber={inningsTab} />
              ) : (
                <StatsFallback data={data} />
              )}
            </>
          ) : null}

          {tab === 'bbb' && hasScoring ? (
            <>
              <InningsTabBar innings={inningsOptions} active={inningsTab} onChange={setInningsTab} />
              <BallByBall balls={balls} matchTitle={matchTitle} inningsNumber={inningsTab} />
            </>
          ) : null}
          {tab === 'commentary' && hasScoring ? (
            <>
              <InningsTabBar innings={inningsOptions} active={inningsTab} onChange={setInningsTab} />
              <Commentary balls={balls} inningsNumber={inningsTab} />
            </>
          ) : null}
          {tab === 'squads' ? (
            squadsReady ? (
              <SquadsLeftRight data={data} />
            ) : isUpcoming ? (
              <div className="web-match-empty">Playing XI will be available closer to match start.</div>
            ) : (
              <div className="web-match-empty">Playing XI abhi available nahi.</div>
            )
          ) : null}
          {tab === 'stats' && hasScoring ? <MatchStats data={data} info={info} balls={balls} /> : null}
          {tab === 'points' ? <MatchPointsTable info={info} /> : null}
          {isUpcoming && ['bbb', 'commentary', 'stats'].includes(tab) ? (
            <div className="web-match-empty web-match-empty-inline">
              Live stats for this tab will appear once the match starts.
            </div>
          ) : null}
        </section>

        <aside className="web-match-info panel">
          <h3>Match Info</h3>
          <dl>
            <div>
              <dt>Match</dt>
              <dd>{tourLine}</dd>
            </div>
            {info.venue ? (
              <div>
                <dt>Venue</dt>
                <dd>{info.venue}</dd>
              </div>
            ) : null}
            {tossLine ? (
              <div>
                <dt>Toss</dt>
                <dd>{tossLine}</dd>
              </div>
            ) : null}
            {info.scheduledAt ? (
              <div>
                <dt>Scheduled</dt>
                <dd>{formatWhen(info.scheduledAt)}</dd>
              </div>
            ) : null}
            {info.umpires ? (
              <div>
                <dt>Umpires</dt>
                <dd>{info.umpires}</dd>
              </div>
            ) : null}
            {info.matchReferee ? (
              <div>
                <dt>Match Referee</dt>
                <dd>{info.matchReferee}</dd>
              </div>
            ) : null}
          </dl>
        </aside>
      </div>
    </div>
  )
}

type InningsPanelData = {
  number: number
  title: string
  batting: any[]
  bowling: any[]
  summary?: { runs?: number; wickets?: number; overs?: number }
}

function buildInningsPanels(data: Record<string, unknown>): InningsPanelData[] {
  const board = data.scoreboard as Record<string, any> | null
  const inningsMeta = (data.innings || []) as any[]
  const panels: InningsPanelData[] = []

  const boards: [number, any][] = [
    [1, board?.innings1],
    [2, board?.innings2],
  ]

  for (const [num, block] of boards) {
    if (!block?.batting?.length && !block?.summary) continue
    const meta = inningsMeta.find((i) => (i.number ?? i.inningsNumber) === num) || inningsMeta[num - 1]
    const summary = block?.summary || meta
    const runs = summary?.runs ?? 0
    const wickets = summary?.wickets ?? 0
    const overs = summary?.overs ?? 0
    const team =
      meta?.battingTeamShortName ||
      meta?.battingTeamName ||
      meta?.teamShortName ||
      `Innings ${num}`
    panels.push({
      number: num,
      title: `${team} — ${runs}/${wickets} (${overs} Ov)`,
      batting: block?.batting || [],
      bowling: block?.bowling || [],
      summary,
    })
  }

  if (!panels.length && (data.battingStats as any[])?.length) {
    const meta = inningsMeta[0]
    panels.push({
      number: 1,
      title: meta?.battingTeamShortName || 'Innings 1',
      batting: data.battingStats as any[],
      bowling: (data.bowlingStats as any[]) || [],
      summary: meta,
    })
  }

  return panels
}

function InningsTabBar({
  innings,
  active,
  onChange,
}: {
  innings: number[]
  active: number
  onChange: (n: number) => void
}) {
  if (innings.length <= 1) return null
  return (
    <div className="web-innings-tabs">
      {innings.map((n) => (
        <button key={n} type="button" className={active === n ? 'active' : ''} onClick={() => onChange(n)}>
          INN {n}
        </button>
      ))}
    </div>
  )
}

function ballInningsNumber(b: any): number {
  return Number(b.innings ?? b.inningsNumber ?? 1)
}

function inningsNumbersInBalls(balls: any[]): number[] {
  const nums = new Set(balls.map(ballInningsNumber))
  return [...nums].sort((a, b) => a - b)
}

function ballsForInnings(balls: any[], innings: number): any[] {
  return balls.filter((b) => ballInningsNumber(b) === innings)
}

function runsOnBall(b: any): number {
  return (
    (b.batRuns ?? 0) +
    (b.extraRuns ?? 0) +
    (b.Byes ?? 0) +
    (b.LegByes ?? 0) +
    (b.overthrowRuns ?? 0)
  )
}

function groupBallsByOver(balls: any[]) {
  const map = new Map<number, any[]>()
  for (const b of balls) {
    const over = Number(b.overNumber ?? 0)
    if (!map.has(over)) map.set(over, [])
    map.get(over)!.push(b)
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([over, overBalls]) => ({
      over,
      balls: [...overBalls].sort((a, b) => {
        const ka = (a.overNumber ?? 0) * 10 + (a.ballNumber ?? 0)
        const kb = (b.overNumber ?? 0) * 10 + (b.ballNumber ?? 0)
        return kb - ka
      }),
      runs: overBalls.reduce((sum, ball) => sum + runsOnBall(ball), 0),
      wickets: overBalls.filter((ball) => ball.wicket).length,
    }))
}

function OverTabBar({
  overs,
  active,
  onChange,
  minOver,
}: {
  overs: number[]
  active: number
  onChange: (over: number) => void
  minOver: number
}) {
  const btnRefs = useRef<Map<number, HTMLButtonElement>>(new Map())

  useEffect(() => {
    const btn = btnRefs.current.get(active)
    btn?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [active])

  if (!overs.length) return null
  return (
    <div className="web-over-tabs-wrap">
      <span className="web-over-tabs-label">Over</span>
      <div className="web-over-tabs">
        {overs.map((over) => (
          <button
            key={over}
            type="button"
            ref={(el) => {
              if (el) btnRefs.current.set(over, el)
              else btnRefs.current.delete(over)
            }}
            className={active === over ? 'active' : ''}
            onClick={() => onChange(over)}
          >
            {overDisplayNumber(over, minOver)}
          </button>
        ))}
      </div>
    </div>
  )
}

function useOverSelection(innBalls: any[], inningsNumber: number) {
  const overs = useMemo(() => groupBallsByOver(innBalls), [innBalls])
  const overNumbers = useMemo(() => overs.map((o) => o.over).sort((a, b) => a - b), [overs])
  const latestOver = overNumbers.at(-1) ?? 1
  const [activeOver, setActiveOver] = useState(latestOver)

  useEffect(() => {
    setActiveOver(latestOver)
  }, [inningsNumber, latestOver])

  const activeOverData = overs.find((o) => o.over === activeOver) ?? overs[0]

  return { overNumbers, activeOver, setActiveOver, activeOverData }
}

function thisOverBalls(balls: any[], inningsNumber: number) {
  const innBalls = ballsForInnings(balls, inningsNumber)
  if (!innBalls.length) return []
  const last = innBalls[innBalls.length - 1]
  const over = last.overNumber
  return innBalls.filter((b) => b.overNumber === over)
}

function FigmaScorecard({
  panel,
  balls,
  inningsNumber,
}: {
  panel: InningsPanelData
  balls: any[]
  inningsNumber: number
}) {
  const overBalls = thisOverBalls(balls, inningsNumber)
  const teamName = panel.title.split('—')[0]?.trim() || 'Team'
  const runs = panel.summary?.runs ?? 0
  const wickets = panel.summary?.wickets ?? 0
  const overs = panel.summary?.overs ?? 0
  const oversNum = typeof overs === 'number' ? overs : parseFloat(String(overs)) || 0
  const crr = oversNum > 0 ? (runs / oversNum).toFixed(2) : '0.00'
  const projected = oversNum > 0 ? Math.round((runs / oversNum) * 20) : runs

  return (
    <div className="web-figma-scorecard">
      <div className="web-innings-select">INN {panel.number} — {panel.title} ▾</div>

      <div className="web-team-score-head">
        <div>
          <div className="web-team-score-title">
            <h3>{teamName}</h3>
            <span className="web-batting-pill">BATTING</span>
          </div>
          <div className="web-team-score-big">
            {runs}/{wickets} <span>({overs} Overs)</span>
          </div>
          <p className="web-team-score-meta">
            CRR: {crr} · Projected: {projected}
          </p>
        </div>
      </div>

      {overBalls.length ? (
        <div className="web-this-over">
          <strong>This Over</strong>
          <div className="web-this-over-balls">
            {overBalls.map((b) => {
              const label = b.wicket ? 'W' : b.wide ? 'wd' : String(b.batRuns ?? 0)
              const cls = b.wicket ? 'wicket' : b.batRuns === 4 || b.batRuns === 6 ? 'boundary' : ''
              return (
                <span key={b.id || `${b.overNumber}.${b.ballNumber}`} className={`ball-chip ${cls}`}>
                  {label}
                </span>
              )
            })}
          </div>
        </div>
      ) : null}

      <div className="web-scorecard-table-wrap">
        <table className="web-scorecard-table">
          <thead>
            <tr>
              <th>Batsman</th>
              <th>R</th>
              <th>B</th>
              <th>4s</th>
              <th>6s</th>
              <th>SR</th>
            </tr>
          </thead>
          <tbody>
            {panel.batting.map((r: any) => {
              const out = r.outType || r.dismissal
              const notOut = !out
              const runsB = r.runs ?? 0
              const ballsFaced = r.balls ?? 0
              const sr = r.strikeRate ?? (ballsFaced > 0 ? ((runsB / ballsFaced) * 100).toFixed(1) : '0.0')
              return (
                <tr key={r.playerId || r.playerName} className={notOut ? 'not-out' : ''}>
                  <td>
                    <div className="batter-name">
                      {r.playerName}
                      {notOut ? '*' : ''}
                    </div>
                    {out ? <div className="batter-dismissal">{String(out)}</div> : null}
                  </td>
                  <td>{runsB}</td>
                  <td>{ballsFaced}</td>
                  <td>{r.fours ?? 0}</td>
                  <td>{r.sixes ?? 0}</td>
                  <td>{sr}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="web-extras-line">
        Extras &amp; Total — {runs}/{wickets} ({overs} Overs)
      </p>

      {panel.bowling?.length ? (
        <>
          <h4 className="web-bowling-head">BOWLING</h4>
          <div className="web-scorecard-table-wrap">
            <table className="web-scorecard-table">
              <thead>
                <tr>
                  <th>Bowler</th>
                  <th>O</th>
                  <th>M</th>
                  <th>R</th>
                  <th>W</th>
                  <th>Econ</th>
                </tr>
              </thead>
              <tbody>
                {panel.bowling.map((r: any) => {
                  const o = parseFloat(String(r.overs ?? 0)) || 0
                  const rc = r.runsConceded ?? 0
                  const econ = o > 0 ? (rc / o).toFixed(2) : '0.00'
                  return (
                    <tr key={r.playerId || r.playerName}>
                      <td>{r.playerName}</td>
                      <td>{r.overs ?? 0}</td>
                      <td>{r.maidens ?? 0}</td>
                      <td>{rc}</td>
                      <td className="wickets">{r.wickets ?? 0}</td>
                      <td>{econ}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  )
}

function StatsFallback({ data }: { data: any }) {
  const homeId = data.matchInfo.team1?.id
  const awayId = data.matchInfo.team2?.id
  const homeBat = (data.battingStats || []).filter((r: any) => r.teamId === homeId || r.team?.id === homeId)
  const awayBat = (data.battingStats || []).filter((r: any) => r.teamId === awayId || r.team?.id === awayId)
  if (!homeBat.length && !awayBat.length) return <div className="empty">Scorecard syncing — Admin re-upload karo</div>
  return (
    <>
      <InningsTable title={data.matchInfo.team1?.shortName || 'Team 1'} batting={homeBat} />
      <InningsTable title={data.matchInfo.team2?.shortName || 'Team 2'} batting={awayBat} />
    </>
  )
}

function InningsTable({
  title,
  batting,
  summary,
  bowling,
}: {
  title: string
  batting: any[]
  summary?: any
  bowling?: any[]
}) {
  if (!batting.length && !bowling?.length) return null
  return (
    <div style={{ marginBottom: 18 }}>
      <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--accent)' }}>
        {title}
        {summary && batting.length ? ` · ${summary.runs}/${summary.wickets} (${summary.overs} Ov)` : ''}
      </h3>
      {batting.length ? (
        <table className="table">
        <thead>
          <tr>
            <th>Batter</th>
            <th>R</th>
            <th>B</th>
            <th>4s</th>
            <th>6s</th>
            <th>SR</th>
          </tr>
        </thead>
        <tbody>
          {batting.map((r: any) => {
            const runs = r.runs ?? 0
            const ballsFaced = r.balls ?? 0
            const sr = r.strikeRate ?? (ballsFaced > 0 ? ((runs / ballsFaced) * 100).toFixed(1) : '0.0')
            const out = r.outType || r.dismissal
            const dismissal = out ? String(out) : 'not out'
            return (
              <tr key={r.playerId || r.playerName}>
                <td>
                  <div>{r.playerName}</div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {dismissal}
                  </div>
                </td>
                <td>{runs}</td>
                <td>{ballsFaced}</td>
                <td>{r.fours ?? 0}</td>
                <td>{r.sixes ?? 0}</td>
                <td>{sr}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      ) : null}
      {bowling?.length ? (
        <table className="table" style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>Bowler</th>
              <th>O</th>
              <th>R</th>
              <th>W</th>
            </tr>
          </thead>
          <tbody>
            {bowling.map((r: any) => (
              <tr key={r.playerId || r.playerName}>
                <td>{r.playerName}</td>
                <td>{r.overs ?? 0}</td>
                <td>{r.runsConceded ?? 0}</td>
                <td>{r.wickets ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  )
}

function MatchStats({
  data,
  info,
  balls,
}: {
  data: Record<string, unknown>
  info: Record<string, any>
  balls: any[]
}) {
  const fours = balls.filter((b) => b.batRuns === 4).length
  const sixes = balls.filter((b) => b.batRuns === 6).length
  const wickets = balls.filter((b) => b.wicket).length
  const dots = balls.filter((b) => !b.wicket && (b.batRuns ?? 0) === 0).length
  const board = data.scoreboard as Record<string, any> | undefined
  const inn1 = board?.innings1?.summary
  const inn2 = board?.innings2?.summary

  return (
    <div className="grid stats2">
      <Stat label="4s" value={String(fours)} accent />
      <Stat label="6s" value={String(sixes)} accent />
      <Stat label="Wickets" value={String(wickets)} />
      <Stat label="Dot balls" value={String(dots)} />
      {inn1 ? (
        <Stat
          label={`${info.team1?.shortName || 'INN1'} score`}
          value={`${inn1.runs}/${inn1.wickets} (${inn1.overs})`}
        />
      ) : null}
      {inn2 ? (
        <Stat
          label={`${info.team2?.shortName || 'INN2'} score`}
          value={`${inn2.runs}/${inn2.wickets} (${inn2.overs})`}
        />
      ) : null}
      {info.tossWinner?.name ? <Stat label="Toss" value={`${info.tossWinner.shortName} · ${info.tossDecision || ''}`} /> : null}
      {info.venue ? <Stat label="Venue" value={info.venue} /> : null}
    </div>
  )
}

function MatchPointsTable({ info }: { info: Record<string, any> }) {
  const tid = info.tournament?.id || info.tournamentId
  const [matches, setMatches] = useState<ApiMatch[]>([])

  useEffect(() => {
    fetchTournaments(true)
      .then((t) => {
        const tour = t.find((x) => x.tournamentId === tid)
        setMatches(tour?.matches || [])
      })
      .catch(() => setMatches([]))
  }, [tid])

  if (!matches.length) {
    return (
      <div className="web-match-empty">
        Points table tournament page par available hai.{' '}
        {tid ? <Link to={`/tournament/${tid}`}>Tournament open karo</Link> : null}
      </div>
    )
  }

  return <PointsFromResults matches={matches} />
}

function BallByBall({
  balls,
  inningsNumber,
}: {
  balls: any[]
  matchTitle?: string
  inningsNumber: number
}) {
  const innBalls = useMemo(() => ballsForInnings(balls, inningsNumber), [balls, inningsNumber])
  const minOver = useMemo(() => minOverInInnings(balls, inningsNumber), [balls, inningsNumber])
  const { overNumbers, activeOver, setActiveOver, activeOverData } = useOverSelection(innBalls, inningsNumber)

  if (!innBalls.length) {
    return <div className="web-match-empty">Ball-by-ball not available for Innings {inningsNumber} yet</div>
  }

  if (!activeOverData) {
    return <div className="web-match-empty">Ball-by-ball not available for Innings {inningsNumber} yet</div>
  }

  const { over, balls: overBalls, runs, wickets } = activeOverData

  return (
    <div className="bbb">
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 12 }}>
        Innings {inningsNumber} · {innBalls.length} balls · {overNumbers.length} overs · Tap play to watch ball clips
      </p>
      <OverTabBar overs={overNumbers} active={activeOver} onChange={setActiveOver} minOver={minOver} />
      <section className="bbb-over-block is-active" key={`over-${inningsNumber}-${over}`}>
        <div className="bbb-over-head">
          <strong>Over {overDisplayNumber(over, minOver)}</strong>
          <span className="bbb-over-meta">
            {runs} run{runs === 1 ? '' : 's'}
            {wickets ? ` · ${wickets} wicket${wickets === 1 ? '' : 's'}` : ''}
          </span>
        </div>
        <div className="bbb-over-balls">
          {overBalls.map((b) => {
            const label = b.wicket ? 'W' : String(b.batRuns ?? 0)
            const cls = b.wicket ? 'wicket' : b.batRuns === 4 || b.batRuns === 6 ? 'four' : ''
            const video = absoluteUrl(b.videoUrl)
            const ballId = String(b.id || `${inningsNumber}-${ballLabel(b.overNumber ?? 0, b.ballNumber ?? 1, minOver)}`)
            const labelText = ballLabel(b.overNumber ?? 0, b.ballNumber ?? 1, minOver)
            return (
              <div className="bbb-item" key={b.id || ballId}>
                <div>
                  <div className={`ball ${cls}`}>{label}</div>
                  <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
                    {labelText}
                  </div>
                </div>
                <div className="bbb-main">
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{b.striker?.name || 'Batter'}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {b.bowler?.name || 'Bowler'} · {b.shotName || b.wicketType || `${b.batRuns ?? 0} run(s)`}
                  </div>
                </div>
                <div className="bbb-actions">
                  <button
                    type="button"
                    className="bbb-icon"
                    disabled={!video}
                    title="Play"
                    onClick={() => video && window.open(video, '_blank', 'noreferrer')}
                  >
                    ▶
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

function Commentary({ balls, inningsNumber }: { balls: any[]; inningsNumber: number }) {
  const innBalls = useMemo(() => ballsForInnings(balls, inningsNumber), [balls, inningsNumber])
  const minOver = useMemo(() => minOverInInnings(balls, inningsNumber), [balls, inningsNumber])
  const { overNumbers, activeOver, setActiveOver, activeOverData } = useOverSelection(innBalls, inningsNumber)

  if (!innBalls.length) {
    return <div className="web-match-empty">Commentary not available for Innings {inningsNumber} yet</div>
  }

  if (!activeOverData) {
    return <div className="web-match-empty">Commentary not available for Innings {inningsNumber} yet</div>
  }

  const { over, balls: overBalls, runs, wickets } = activeOverData

  return (
    <div className="bbb commentary">
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 12 }}>
        Innings {inningsNumber} · {innBalls.length} balls · {overNumbers.length} overs
      </p>
      <OverTabBar overs={overNumbers} active={activeOver} onChange={setActiveOver} minOver={minOver} />
      <section className="bbb-over-block is-active" key={`comm-over-${inningsNumber}-${over}`}>
        <div className="bbb-over-head">
          <strong>Over {overDisplayNumber(over, minOver)}</strong>
          <span className="bbb-over-meta">
            {runs} run{runs === 1 ? '' : 's'}
            {wickets ? ` · ${wickets} wicket${wickets === 1 ? '' : 's'}` : ''}
          </span>
        </div>
        <div className="bbb-over-balls">
          {overBalls.map((b) => (
            <div
              className="bbb-item commentary-item"
              key={`c-${b.id || `${inningsNumber}-${ballLabel(b.overNumber ?? 0, b.ballNumber ?? 1, minOver)}`}`}
            >
              <div className="muted" style={{ fontSize: 12, fontWeight: 700 }}>
                {ballLabel(b.overNumber ?? 0, b.ballNumber ?? 1, minOver)}
              </div>
              <div>
                <div style={{ fontWeight: 700 }}>
                  {b.wicket ? 'WICKET' : `${b.batRuns ?? 0}`} · {b.striker?.name}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {b.bowler?.name} to {b.striker?.name}
                  {b.wicketType ? ` — ${b.wicketType}` : b.shotName ? ` — ${b.shotName}` : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function SquadsLeftRight({ data }: { data: any }) {
  const home = uniquePlayers(data, data.matchInfo.team1?.id)
  const away = uniquePlayers(data, data.matchInfo.team2?.id)
  const rows = Math.max(home.length, away.length, 1)

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 12, alignItems: 'center', marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Logo src={logoOf(data.matchInfo.team1)} fallback={teamCode(data.matchInfo.team1)} />
          <strong>{data.matchInfo.team1?.shortName || data.matchInfo.team1?.name}</strong>
        </div>
        <span className="muted">VS</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end' }}>
          <strong>{data.matchInfo.team2?.shortName || data.matchInfo.team2?.name}</strong>
          <Logo src={logoOf(data.matchInfo.team2)} fallback={teamCode(data.matchInfo.team2)} />
        </div>
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div className="squad-row" key={i}>
          <PlayerCell player={home[i]} align="left" />
          <div style={{ background: 'var(--border)' }} />
          <PlayerCell player={away[i]} align="right" />
        </div>
      ))}
    </div>
  )
}

function uniquePlayers(data: any, teamId?: string) {
  const map = new Map<string, { name: string; role: string; imageUrl?: string; id?: string }>()
  const teamName = (side: 'team1' | 'team2') => data.matchInfo?.[side]?.name
  const matchesTeam = (row: any) => {
    if (!teamId) return true
    if (row.teamId === teamId || row.team?.id === teamId) return true
    const tn = row.teamName || row.team?.name
    if (tn && (tn === teamName('team1') || tn === teamName('team2'))) {
      return data.matchInfo?.team1?.id === teamId ? tn === teamName('team1') : tn === teamName('team2')
    }
    return false
  }
  for (const row of data.battingStats || []) {
    if (!matchesTeam(row)) continue
    const id = row.playerId || row.playerName
    if (!id || map.has(id)) continue
    map.set(id, {
      id,
      name: row.playerName || 'Player',
      role: row.playerRole || row.outType ? 'Batter' : 'Batter',
      imageUrl: row.player?.imageUrl,
    })
  }
  for (const row of data.bowlingStats || []) {
    if (!matchesTeam(row)) continue
    const id = row.playerId || row.player?.id || row.player?.name || row.playerName
    if (!id) continue
    const existing = map.get(id)
    map.set(id, {
      id,
      name: existing?.name || row.player?.name || row.playerName || 'Player',
      role: existing?.role || row.player?.role || 'Bowler',
      imageUrl:
        row.player?.imageUrl?.startsWith('http') ? row.player.imageUrl : existing?.imageUrl,
    })
  }
  const sb = data.scoreboard
  for (const block of [sb?.innings1, sb?.innings2]) {
    for (const row of block?.batting || []) {
      const id = row.playerId || row.playerName
      if (!id || map.has(id)) continue
      map.set(id, { id, name: row.playerName || 'Player', role: 'Batter' })
    }
    for (const row of block?.bowling || []) {
      const id = row.playerId || row.playerName
      if (!id || map.has(id)) continue
      map.set(id, { id, name: row.playerName || 'Player', role: 'Bowler' })
    }
  }
  return [...map.values()]
}

function PlayerCell({
  player,
  align,
}: {
  player?: { name: string; role: string; imageUrl?: string; id?: string }
  align: 'left' | 'right'
}) {
  if (!player) return <div />
  return (
    <div className={`player-cell ${align === 'right' ? 'right' : ''}`}>
      {align === 'left' ? <Logo className="sm" src={player.imageUrl} fallback={player.name} /> : null}
      <div>
        <div className="name">{player.name}</div>
        <div className="role">{player.role}</div>
      </div>
      {align === 'right' ? <Logo className="sm" src={player.imageUrl} fallback={player.name} /> : null}
    </div>
  )
}

export function TournamentsPage() {
  const [tournaments, setTournaments] = useState<ApiTournament[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchTournaments(true)
      .then(setTournaments)
      .catch((e) => setError(e.message))
  }, [])

  if (error) return <div className="error">{error}</div>

  return (
    <>
      <div className="section-head">
        <h2>Tournaments</h2>
      </div>
      <div className="grid tournaments">
        {tournaments.map((t, i) => (
          <Link key={t.tournamentId} to={`/tournament/${t.tournamentId}`} className="card t-card">
            <div className="strip" style={{ background: ['#00b4d8', '#10b981', '#f97316', '#ef4444'][i % 4] }} />
            <div className="body">
              <Logo src={tournamentLogo(t)} fallback={t.name} />
              <h3>{t.name}</h3>
              <p>
                {t.matches.length} matches · {t.location || 'India'}
              </p>
            </div>
          </Link>
        ))}
      </div>
    </>
  )
}
