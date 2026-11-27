const { execFile } = require('node:child_process');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { promisify } = require('node:util');
const { publishedBallVideo } = require('./public-archives.cjs');

const run = promisify(execFile);
const site = 'https://jbmrsports.com';
const clipIDPattern = /^rtdb-ball-\d{1,20}-\d{1,20}$/;
const maxVideoBytes = 25 * 1024 * 1024;
const escape = value => String(value).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const row = (table, id) => Object.entries(table ?? {}).find(([key, item]) =>
  item && String(item.id ?? key) === String(id))?.[1];

function describeClip({ tables, ball, matchID }) {
  const match = row(tables.matches, matchID);
  if (!match) return null;
  const names = [match.team_a_id, match.team_b_id].map(id => {
    const team = row(tables.teams, id);
    return team?.name || team?.short_name;
  });
  const matchName = names.every(Boolean) ? names.join(' vs ') : match.title || 'JBMR Sports';
  let event = ball.event ?? ball.event_json ?? {};
  if (typeof event === 'string') {
    try { event = JSON.parse(event) ?? {}; } catch { event = {}; }
  }
  const kind = String(ball.kind ?? '').toLowerCase();
  const batsmanRuns = Number(event.bat_runs);
  const runs = Number(ball.runs ?? event.bat_runs);
  const outcome = event.dismissal || kind === 'wicket' ? 'WICKET'
    : event.wide_runs > 0 || kind === 'wide' ? 'WIDE'
    : event.noball_runs > 0 || ['no_ball', 'noball'].includes(kind) ? 'NO BALL'
    : batsmanRuns === 4 ? 'FOUR' : batsmanRuns === 6 ? 'SIX'
    : runs === 0 ? 'DOT BALL' : Number.isFinite(runs) ? `${runs} ${runs === 1 ? 'run' : 'runs'}` : 'Ball highlight';
  let state = ball.state_after ?? ball.state_after_json;
  if (typeof state === 'string') {
    try { state = JSON.parse(state); } catch { state = null; }
  }
  const overIndex = Math.max(Number(ball.over_index) || 1, 1);
  const legalBalls = Number(state?.legal_balls);
  const countedBall = Math.max(1, Math.min(6, legalBalls - (overIndex - 1) * 6));
  const delivery = ball.over_index != null && ball.ball_index != null
    ? `Ball ${ball.over_index}.${ball.ball_index}`
    : Number.isFinite(legalBalls) ? `Ball ${overIndex - 1}.${countedBall}` : null;
  return { title: `${matchName} · ${outcome}`, description: delivery || 'Match highlight', ball };
}

function trustedVideoURL(ball, baseValue = process.env.R2_PUBLIC_BASE_URL) {
  try {
    const base = new URL(baseValue);
    const video = new URL(publishedBallVideo(ball) || ball.clip?.url || ball.clip_url || ball.video_url);
    const root = base.pathname.replace(/\/$/, '') + '/';
    if (base.protocol === 'https:' && !base.username && !base.password &&
        video.origin === base.origin && !video.username && !video.password &&
        video.pathname.startsWith(root) && !video.search && !video.hash &&
        /\.(mp4|mov|m4v)$/i.test(video.pathname)) return video;
  } catch { /* An unconfigured or unsupported source has no generated thumbnail. */ }
}

function previewSource(ball) {
  const publicURL = trustedVideoURL(ball);
  if (publicURL) return { url: publicURL, cacheKey: publicURL.href };
  const config = {
    account: process.env.R2_ACCOUNT_ID, bucket: process.env.R2_BUCKET,
    access: process.env.R2_ACCESS_KEY_ID, secret: process.env.R2_SECRET_ACCESS_KEY
  };
  if (!Object.values(config).every(Boolean)) return null;
  const stored = String(ball.clip_path ?? '').trim();
  let key = /^[a-z0-9_./-]+\.(mp4|mov|m4v)$/i.test(stored) &&
    stored.split('/').every(part => part && part !== '.' && part !== '..') ? stored : null;
  if (!key && ball.clip?.url) {
    try { key = require('./clip-object.cjs').clipObjectKey(ball.clip, config); } catch { return null; }
  }
  if (!key) return null;
  const signed = require('./r2-usage.cjs').signedObjectRequest(config, key);
  return { ...signed, cacheKey: `${config.account}/${config.bucket}/${key}` };
}

async function videoFrame(video, headers) {
  // Download a bounded object from the configured public bucket. FFmpeg reads
  // only local input and cannot follow network references in a media container.
  const response = await fetch(video, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxVideoBytes)
    throw Error('Video unavailable');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxVideoBytes) throw Error('Video exceeds preview limit');
    chunks.push(chunk);
  }
  const directory = await mkdtemp(join(tmpdir(), 'jbmr-short-preview-'));
  try {
    const input = join(directory, 'clip');
    await writeFile(input, Buffer.concat(chunks, bytes));
    const { stdout } = await run(require('@ffmpeg-installer/ffmpeg').path, [
      '-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe',
      '-f', 'mov', '-enable_drefs', '0', '-i', input, '-map', '0:v:0',
      '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease',
      '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'
    ], { encoding: 'buffer', timeout: 8000, maxBuffer: 1024 * 1024 });
    if (!stdout.length) throw Error('Video has no preview frame');
    return stdout;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function install(app, findClip, renderFrame = videoFrame) {
  const previews = new Map(), pending = new Map();
  function frameFor(source) {
    const key = source.cacheKey;
    if (previews.has(key)) return previews.get(key);
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 2) throw Error('Preview busy');
    const result = renderFrame(source.url, source.headers).then(frame => {
      if (previews.size >= 32) previews.delete(previews.keys().next().value);
      previews.set(key, frame);
      return frame;
    }).finally(() => pending.delete(key));
    pending.set(key, result);
    return result;
  }
  const lookup = async id => {
    if (typeof id !== 'string' || !clipIDPattern.test(id)) return null;
    const clip = await findClip(id, '', { engagementOnly: true });
    return clip && describeClip(clip);
  };

  app.get('/tab/shorts', async (req, res, next) => {
    const id = req.query.clip;
    if (id == null) return next();
    try {
      const clip = await lookup(id);
      if (!clip) return res.status(404).send('Short unavailable');
      const url = `${site}/tab/shorts?clip=${id}`;
      const image = previewSource(clip.ball) ? `${site}/share/shorts/${id}.jpg` : null;
      res.set('Cache-Control', 'public, max-age=300').type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(clip.title)}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="JBMR Sports">
<meta property="og:title" content="${escape(clip.title)}">
<meta property="og:description" content="${escape(clip.description)}">
<meta property="og:url" content="${url}">
${image ? `<meta property="og:image" content="${image}"><meta property="og:image:type" content="image/jpeg">` : ''}
<meta name="apple-itunes-app" content="app-id=6808138064, app-argument=${url}">
</head><body><main><h1>${escape(clip.title)}</h1><p>${escape(clip.description)}</p>
${image ? `<img src="${image}" alt="Frame from the Short" style="max-width:100%;height:auto">` : ''}
<p><a href="https://apps.apple.com/in/app/jbmr-sports/id6808138064">JBMR Sports on the App Store</a></p>
<p><a href="https://play.google.com/store/apps/details?id=in.jbmrsports.ott">JBMR Sports on Google Play</a></p>
</main></body></html>`);
    } catch { res.status(503).send('Short preview temporarily unavailable'); }
  });

  app.get('/share/shorts/:id.jpg', async (req, res) => {
    try {
      const clip = await lookup(req.params.id);
      const source = clip && previewSource(clip.ball);
      if (!source) return res.status(404).end();
      const jpeg = await frameFor(source);
      res.set('Cache-Control', 'public, max-age=300').type('jpeg').send(jpeg);
    } catch { res.status(503).end(); }
  });
}

module.exports = { install, describeClip, trustedVideoURL, videoFrame };
