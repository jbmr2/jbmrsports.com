'use strict';

// A verified Firebase custom claim enables a renewable, read-only simulator
// session. No phone/PIN/OTP or download ownership is granted by this module.
const { entries } = require('./match-archives.cjs');
const { publishedArchives } = require('./public-archives.cjs');
const { scopedPlayerKey, buildScoringAnalytics } = require('./my-performance-api.cjs');
const DBURL = 'https://jbmrsports-cricket-live-default-rtdb.asia-southeast1.firebasedatabase.app';

function allowedSession(decoded, now = Date.now()) {
  const config = require('./simulator-preview-access.json');
  if (config.enabled !== true) return false;
  if (decoded?.uid === 'simulator-preview' && decoded.simulator_preview === true
      && typeof config.grantVersion === 'string' && decoded.simulator_grant_version === config.grantVersion) return true;
  return decoded?.uid === 'simulator-preview' && decoded.simulator_preview === true
    && Number.isSafeInteger(decoded.preview_expires_at)
    && decoded.preview_expires_at * 1000 > now;
}
function allowedRequest(req) {
  return req.method === 'GET' && (/^\/api\/(public\/|simulator\/|my-performance(?:\/|$))/.test(req.path)
    || ['/api/scoring-archives', '/api/visibility', '/api/manual-video-ad'].includes(req.path)
    || /^\/api\/scoring-matches\/[a-f0-9]{32}:[1-9][0-9]{0,19}$/.test(req.path)
    || /^\/api\/shorts\/rtdb-ball-\d+-\d+(?:\/comments)?$/.test(req.path));
}
// The key is supplied only to local simulator builds. It remains read-only on
// the server, and the ordinary user login/session path is unchanged.
function simulatorBearer(token, config = require('./simulator-preview-access.json')) {
  const { createHash, timingSafeEqual } = require('node:crypto');
  if (config.enabled !== true || !/^simv1_[a-f0-9]{64}$/.test(String(token || ''))
      || !/^[a-f0-9]{64}$/.test(String(config.mysqlReadOnlyTokenSha256 || ''))) return null;
  const digest = createHash('sha256').update(token.slice(6)).digest();
  if (!timingSafeEqual(digest, Buffer.from(config.mysqlReadOnlyTokenSha256, 'hex'))) return null;
  return { uid: 'simulator-preview', simulator_preview: true, simulator_grant_version: config.grantVersion };
}
let cache, loading;
let inventoryCache, inventoryLoading;
const INVENTORY_CACHE_MS = 5 * 60 * 1000;
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
    const [scorers, feed, archives, legacy, mysql, visibility] = await Promise.all([
      db.ref('scorers_public').get(), db.ref('tournament_feed').get(),
      require('./admin-visibility.cjs').archivesForLiveCatalog().catch(error => {
        console.warn('JBMR simulator archive refresh unavailable; serving live scorer data', error.message);
        return [];
      }),
      publicLegacy(),
      require('./mysql-scoring.cjs').snapshot().catch(error => { console.warn('MySQL scoring unavailable', error.code || error.message); return null; }),
      require('./mysql-visibility.cjs').read().then(value => ({ val: () => value }))
    ]);
    const raw = scorers.val() || {};
    const rules = { matches: {} };
    for (const [source, payload] of Object.entries(raw)) for (const m of entries(payload?.tables?.matches)) {
      rules.matches[`${source}:${m.id}`] = { show: true };
    }
    for (const payload of archives) for (const m of entries(payload.tables.matches)) {
      rules.matches[`${payload.installation_id}:${m.id}`] = { show: true };
    }
    const projected = require('./ott-feed-api.cjs').publicScorers(raw, rules);
    if (mysql) Object.assign(projected, require('./ott-feed-api.cjs').publicScorers({ [mysql.installation_id]: mysql }, require('./mysql-scoring.cjs').scopedVisibility(visibility.val())));
    const value = { scorers: projected,
      tournamentFeed: feed.val() || {}, archives: publishedArchives(archives, rules), legacy, rules,
      archiveDiagnostics: require('./admin-visibility.cjs').archiveDiagnostics(),
      fetchedAt: new Date().toISOString() };
    cache = { at: Date.now(), value }; return value;
  })().finally(() => { loading = null; });
  return loading;
}
function choosePlayer(players, requested, defaultID, recoverStale = false) {
  const selected = requested ? players.get(String(requested)) : players.get(defaultID) || players.values().next().value;
  if (requested && !selected && !recoverStale) throw Object.assign(new Error('Player unavailable'), { code: 'INVALID_PLAYER' });
  return selected || (recoverStale ? players.get(defaultID) || players.values().next().value : undefined);
}
let performanceCache, performanceLoading;
async function performanceData() {
  if (performanceCache && Date.now() - performanceCache.at < 5000) return performanceCache.value;
  if (performanceLoading) return performanceLoading;
  performanceLoading = (async () => {
    const scoring = require('./mysql-scoring.cjs');
    const [snapshot, archived] = await Promise.all([scoring.snapshot(), require('./mysql-archives.cjs').read()]);
    const byUID = new Map(archived.map(row => [String(row.archive_manifest.match_uid), row]));
    const inningsMatchIDs = new Set(entries(snapshot.tables.innings).map(row => String(row.match_id)));
    for (const match of entries(snapshot.tables.matches)) {
      if (!match.match_uid || !inningsMatchIDs.has(String(match.id))) continue;
      const uid = String(match.match_uid);
      const isLive = /^(live|in_progress|inprogress|innings_break|innings break)$/i.test(String(match.status || '').trim());
      if (byUID.has(uid) && !isLive) continue;
      const detail = await scoring.readMatch(match.id);
      if (detail) byUID.set(uid, detail);
    }
    const archives = [...byUID.values()];
    const rules = { matches: {} };
    for (const payload of archives) for (const match of entries(payload.tables.matches)) {
      rules.matches[`${payload.installation_id}:${match.id}`] = { show: true };
    }
    const value = { archives, rules };
    performanceCache = { at: Date.now(), value };
    return value;
  })().finally(() => { performanceLoading = undefined; });
  return performanceLoading;
}
async function selection(req, { recoverStale = false } = {}) {
  const loaded = await performanceData();
  const players = new Map();
  for (const payload of loaded.archives) for (const p of entries(payload.tables.players)) {
    const id = scopedPlayerKey(payload.installation_id, p.id);
    players.set(id, { id, name: p.name });
  }
  const first = loaded.archives[0];
  const firstBatter = first && entries(first.tables.balls)[0]?.striker_id;
  const defaultID = first && scopedPlayerKey(first.installation_id, firstBatter);
  const requested = req.query.player || req.headers['x-jbmr-simulator-player'];
  const selected = choosePlayer(players, requested, defaultID, recoverStale);
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
async function inventory() {
  if (inventoryCache && Date.now() - inventoryCache.at < INVENTORY_CACHE_MS) return inventoryCache.value;
  if (inventoryLoading) return inventoryLoading;
  inventoryLoading = (async () => {
    const db = require('firebase-admin/database').getDatabaseWithUrl(DBURL);
    const firestore = require('firebase-admin/firestore').getFirestore('criccricket');
    const sections = [];
    const paths = ['tournaments', 'r2_links', 'scorers_public', 'tournament_feed', 'app_visibility'];
    const values = await Promise.all(paths.map(path => db.ref(path).get().catch(error => {
      console.warn('JBMR simulator inventory RTDB section unavailable', path, error.message);
      return null;
    })));
    paths.forEach((path, index) => {
      const value = values[index]?.val();
      sections.push({ id: `rtdb/${path}`, source: 'Current Firebase', name: `RTDB / ${path}`,
        count: value == null ? 0 : Object.keys(value).length,
        detail: value == null ? 'Count unavailable; this is not a confirmed empty section' : 'Top-level entries' });
    });
    let collections = [];
    try { collections = await firestore.listCollections(); }
    catch (error) { console.warn('JBMR simulator inventory Firestore collections unavailable', error.message); }
    for (const c of collections) {
      try {
        sections.push({ id: `firestore/${c.id}`, source: 'Current Firebase', name: c.id,
          count: (await c.count().get()).data().count, detail: 'Record count only' });
      } catch (error) {
        console.warn('JBMR simulator inventory Firestore count unavailable', c.id, error.message);
        sections.push({ id: `firestore/${c.id}`, source: 'Current Firebase', name: c.id,
          count: 0, detail: 'Count unavailable; this is not a confirmed empty collection' });
      }
    }
    const legacy = (await data()).legacy;
    for (const [name, rows] of Object.entries(legacy.catalog || {})) sections.push({ id: `legacy/${name}`,
      source: 'Legacy Firebase', name, count: Object.keys(rows || {}).length, detail: 'Public legacy catalog entries' });
    return { sections, fetchedAt: new Date().toISOString() };
  })().then(value => {
    inventoryCache = { at: Date.now(), value };
    return value;
  }).finally(() => { inventoryLoading = null; });
  return inventoryLoading;
}
function install(app, authenticated) {
  app.post('/api/simulator/session', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const { createHash, timingSafeEqual } = require('node:crypto');
      const config = require('./simulator-preview-access.json');
      const key = String(req.headers['x-jbmr-simulator-bootstrap'] || '');
      if (!/^[a-f0-9]{64}$/.test(key) || config.enabled !== true
          || !timingSafeEqual(createHash('sha256').update(key).digest(), Buffer.from(config.tokenSha256, 'hex'))) {
        return res.status(403).json({ error: 'Simulator bootstrap unavailable.' });
      }
      const token = await require('firebase-admin/auth').getAuth().createCustomToken('simulator-preview', {
        simulator_preview: true, simulator_grant_version: config.grantVersion
      });
      res.json({ token, continuous: true });
    } catch { res.status(503).json({ error: 'Simulator session could not start.' }); }
  });
  const previewOnly = (req, res, next) => req.simulatorPreview ? next()
    : res.status(403).json({ ok: false, error: 'Restricted simulator session required.' });
  app.get('/api/simulator/players', authenticated, previewOnly, async (req, res) => {
    try {
      // Discovery can recover an old simulator-only selection after a scorer
      // reset. Analytics itself remains strict until the client accepts the
      // selected replacement returned here.
      const { players, selected } = await selection(req, { recoverStale: true });
      res.set('Cache-Control', 'private, no-store').json({ players, selected: selected?.id });
    } catch { res.status(503).json({ error: 'Players could not load.' }); }
  });
  app.get('/api/simulator/inventory', authenticated, previewOnly, async (_req, res) => {
    try { res.set('Cache-Control', 'private, no-store').json(await inventory()); }
    catch { res.status(503).json({ error: 'Inventory could not load.' }); }
  });
}
function invalidateLiveData() { cache = undefined; performanceCache = undefined; }
module.exports = { allowedSession, allowedRequest, simulatorBearer, data, selection, choosePlayer, analytics, performance, inventory, install, invalidateLiveData };
