'use strict';

// A verified Firebase custom claim enables a short-lived, read-only simulator
// session. No phone/PIN/OTP or download ownership is granted by this module.
const { entries, readMatchArchives } = require('./match-archives.cjs');
const { publishedArchives } = require('./public-archives.cjs');
const { scopedPlayerKey, buildScoringAnalytics } = require('./my-performance-api.cjs');
const DBURL = 'https://jbmrsports-cricket-live-default-rtdb.asia-southeast1.firebasedatabase.app';

function allowedSession(decoded, now = Date.now()) {
  return decoded?.uid === 'simulator-preview' && decoded.simulator_preview === true
    && Number.isSafeInteger(decoded.preview_expires_at)
    && decoded.preview_expires_at * 1000 > now;
}
function allowedRequest(req) {
  return req.method === 'GET' && (/^\/api\/(public\/|simulator\/|my-performance(?:\/|$))/.test(req.path)
    || ['/api/scoring-archives', '/api/visibility', '/api/manual-video-ad'].includes(req.path)
    || /^\/api\/shorts\/rtdb-ball-\d+-\d+(?:\/comments)?$/.test(req.path));
}
let cache, loading;
async function publicLegacy() {
  const base = 'https://cloud-storage-eaca9-default-rtdb.europe-west1.firebasedatabase.app';
  try {
    const [catalogResponse, tournamentResponse] = await Promise.all([
      fetch(`${base}/catalog.json`, { signal: AbortSignal.timeout(8000) }),
      fetch(`${base}/ott/tournaments.json`, { signal: AbortSignal.timeout(8000) })
    ]);
    if (!catalogResponse.ok || !tournamentResponse.ok) return {};
    const raw = await catalogResponse.json();
    return { catalog: { tournaments: raw?.tournaments || {}, matches: raw?.matches || {}, live: raw?.live || {} },
      tournaments: await tournamentResponse.json() || {} };
  } catch { return {}; }
}
async function data() {
  if (cache && Date.now() - cache.at < 10000) return cache.value;
  if (loading) return loading;
  loading = (async () => {
    const db = require('firebase-admin/database').getDatabaseWithUrl(DBURL);
    const firestore = require('firebase-admin/firestore').getFirestore('criccricket');
    const invalid = [];
    const [scorers, feed, archives, legacy] = await Promise.all([
      db.ref('scorers_public').get(), db.ref('tournament_feed').get(),
      readMatchArchives(firestore, { onInvalidArchive: ({ matchUID }) => invalid.push(String(matchUID)) }),
      publicLegacy()
    ]);
    const raw = scorers.val() || {};
    const rules = { matches: {} };
    for (const [source, payload] of Object.entries(raw)) for (const m of entries(payload?.tables?.matches)) {
      rules.matches[`${source}:${m.id}`] = { show: true };
    }
    for (const payload of archives) for (const m of entries(payload.tables.matches)) {
      rules.matches[`${payload.installation_id}:${m.id}`] = { show: true };
    }
    const value = { scorers: require('./ott-feed-api.cjs').publicScorers(raw, rules),
      tournamentFeed: feed.val() || {}, archives: publishedArchives(archives, rules), legacy, rules,
      archiveDiagnostics: { invalidArchives: invalid.length, invalidMatchUIDs: invalid },
      fetchedAt: new Date().toISOString() };
    cache = { at: Date.now(), value }; return value;
  })().finally(() => { loading = null; });
  return loading;
}
async function selection(req) {
  const loaded = await data();
  const players = new Map();
  for (const payload of loaded.archives) for (const p of entries(payload.tables.players)) {
    const id = scopedPlayerKey(payload.installation_id, p.id);
    players.set(id, { id, name: p.name });
  }
  const first = loaded.archives[0];
  const firstBatter = first && entries(first.tables.balls)[0]?.striker_id;
  const defaultID = first && scopedPlayerKey(first.installation_id, firstBatter);
  const requested = req.query.player || req.headers['x-jbmr-simulator-player'];
  const selected = requested ? players.get(String(requested)) : players.get(defaultID) || players.values().next().value;
  if (requested && !selected) throw Object.assign(new Error('Player unavailable'), { code: 'INVALID_PLAYER' });
  return { loaded, players: [...players.values()], selected };
}
async function analytics(req) {
  const { loaded, selected } = await selection(req);
  return buildScoringAnalytics({ archives: loaded.archives, playerKeys: selected ? [selected.id] : [],
    cursor: req.query.cursor, limit: req.query.limit, analyticsOptions: { allowUnknownPhases: true } });
}
async function performance(req) {
  const { loaded, selected } = await selection(req);
  const marker = '0000000000';
  const payloads = loaded.archives.map(p => ({ ...p, tables: { ...p.tables,
    players: entries(p.tables.players).map(player => ({ ...player,
      performance_phone: scopedPlayerKey(p.installation_id, player.id) === selected?.id ? marker : '' })) } }));
  const packages = require('./shorts.cjs').performancePackages(payloads, marker, loaded.rules);
  const ready = packages.reduce((n, p) => n + p.clips.length, 0);
  return { linked: !!selected, packages, diagnostic: { status: ready ? 'clips_ready' : 'clips_pending',
    matchCount: loaded.archives.length, packageCount: packages.length, readyClipCount: ready,
    pendingClipCount: packages.reduce((n, p) => n + p.totalClips, 0) - ready } };
}
function install(app, authenticated) {
  app.post('/api/simulator/session', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const { createHash, timingSafeEqual } = require('node:crypto');
      const config = require('./simulator-preview-access.json');
      const key = String(req.headers['x-jbmr-simulator-bootstrap'] || '');
      if (!/^[a-f0-9]{64}$/.test(key) || config.expiresAt <= Math.floor(Date.now() / 1000)
          || !timingSafeEqual(createHash('sha256').update(key).digest(), Buffer.from(config.tokenSha256, 'hex'))) {
        return res.status(403).json({ error: 'Simulator bootstrap unavailable.' });
      }
      const token = await require('firebase-admin/auth').getAuth().createCustomToken('simulator-preview', {
        simulator_preview: true, preview_expires_at: config.expiresAt
      });
      res.json({ token, expiresAt: config.expiresAt });
    } catch { res.status(503).json({ error: 'Simulator session could not start.' }); }
  });
  const previewOnly = (req, res, next) => req.simulatorPreview ? next()
    : res.status(403).json({ ok: false, error: 'Restricted simulator session required.' });
  app.get('/api/simulator/players', authenticated, previewOnly, async (req, res) => {
    try {
      const { players, selected } = await selection(req);
      res.set('Cache-Control', 'private, no-store').json({ players, selected: selected?.id });
    } catch { res.status(503).json({ error: 'Players could not load.' }); }
  });
  app.get('/api/simulator/inventory', authenticated, previewOnly, async (_req, res) => {
    try {
      const db = require('firebase-admin/database').getDatabaseWithUrl(DBURL);
      const firestore = require('firebase-admin/firestore').getFirestore('criccricket');
      const sections = [];
      for (const path of ['tournaments', 'r2_links', 'scorers_public', 'tournament_feed', 'app_visibility']) {
        const value = (await db.ref(path).get()).val();
        sections.push({ id: `rtdb/${path}`, source: 'Current Firebase', name: `RTDB / ${path}`,
          count: Object.keys(value || {}).length, detail: 'Top-level entries' });
      }
      for (const c of await firestore.listCollections()) {
        sections.push({ id: `firestore/${c.id}`, source: 'Current Firebase', name: c.id,
          count: (await c.count().get()).data().count, detail: 'Record count only' });
      }
      const legacy = (await data()).legacy;
      for (const [name, rows] of Object.entries(legacy.catalog || {})) sections.push({ id: `legacy/${name}`,
        source: 'Legacy Firebase', name, count: Object.keys(rows || {}).length, detail: 'Public legacy catalog entries' });
      res.set('Cache-Control', 'private, no-store').json({ sections, fetchedAt: new Date().toISOString() });
    } catch { res.status(503).json({ error: 'Inventory could not load.' }); }
  });
}
module.exports = { allowedSession, allowedRequest, data, selection, analytics, performance, install };
