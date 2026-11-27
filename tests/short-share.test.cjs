const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const express = require('express');
const { install, trustedVideoURL } = require('../lib/short-share.cjs');

test('published Short has escaped match and delivery metadata, an image, and the same universal link', async t => {
  const previousBase = process.env.R2_PUBLIC_BASE_URL;
  process.env.R2_PUBLIC_BASE_URL = 'https://media.example.com/clips';
  t.after(() => {
    if (previousBase === undefined) delete process.env.R2_PUBLIC_BASE_URL;
    else process.env.R2_PUBLIC_BASE_URL = previousBase;
  });
  const id = 'rtdb-ball-94-48850';
  const match = { id: 94, team_a_id: 10, team_b_id: 12 };
  const ball = { over_index: 0, ball_index: 1, event_json: '{"bat_runs":4}',
    clip_status: 'ready', clip_path: 'over-1/ball.mp4' };
  const app = express();
  let renders = 0;
  install(app, async (requestedID, _phone, { engagementOnly }) => {
    assert.equal(engagementOnly, true);
    if (requestedID !== id) return null;
    return { tables: { matches: [match], teams: [{ id: 10, name: 'A & B' }, { id: 12, name: 'Home' }] },
      matchID: '94', ball };
  }, async url => {
    assert.equal(url.href, 'https://media.example.com/clips/over-1/ball.mp4');
    renders++;
    return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  });
  app.get('/tab/shorts', (_req, res) => res.send('Normal website'));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${origin}/tab/shorts?clip=${id}`, { headers: { 'User-Agent': 'WhatsApp' } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /og:title" content="A &amp; B vs Home · FOUR"/);
  assert.match(html, /og:description" content="Ball 0\.1"/);
  assert.ok(html.includes(`og:url" content="https://jbmrsports.com/tab/shorts?clip=${id}"`));
  assert.ok(html.includes(`og:image" content="https://jbmrsports.com/share/shorts/${id}.jpg"`));
  const image = await fetch(`${origin}/share/shorts/${id}.jpg`);
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await (await fetch(`${origin}/share/shorts/${id}.jpg`)).arrayBuffer();
  assert.equal(renders, 1);
  assert.equal((await fetch(`${origin}/tab/shorts?clip=rtdb-ball-1-1`)).status, 404);
  assert.equal((await fetch(`${origin}/share/shorts/rtdb-ball-1-1.jpg`)).status, 404);
  assert.equal(await (await fetch(`${origin}/tab/shorts`)).text(), 'Normal website');
});

test('preview media is restricted to the configured HTTPS bucket path', () => {
  const base = 'https://media.example.com/clips';
  for (const clip_url of [
    'https://media.example.com/private/video.mp4',
    'https://media.example.com/clips-extra/video.mp4',
    'https://another.example.com/clips/video.mp4',
    'http://media.example.com/clips/video.mp4',
    'https://media.example.com/clips/video.mp4?signature=value',
  ]) assert.equal(trustedVideoURL({ clip_url }, base), undefined);
});
