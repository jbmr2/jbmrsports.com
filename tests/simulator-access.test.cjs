'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { middleware } = require('../lib/simulator-access.cjs');
const { allowedSession, allowedRequest } = require('../lib/simulator-preview.cjs');
const preview = () => ({ uid: 'simulator-preview', simulator_preview: true,
  preview_expires_at: Math.floor(Date.now() / 1000) + 3600 });
const response = () => ({ status(n) { this.code = n; return this; }, json(body) { this.body = body; } });
test('preview claims expire and cannot belong to a normal user', () => {
  assert.equal(allowedSession(preview()), true);
  assert.equal(allowedSession({ ...preview(), uid: 'normal-user' }), false);
  assert.equal(allowedSession({ ...preview(), preview_expires_at: 1 }), false);
  assert.equal(allowedSession({ uid: 'simulator-preview' }), false);
});
test('renewable simulator grant remains valid beyond 24 hours and rejects other identities', () => {
  const config = require('../lib/simulator-preview-access.json');
  const continuous = { uid: 'simulator-preview', simulator_preview: true, simulator_grant_version: config.grantVersion };
  assert.equal(allowedSession(continuous, Date.now() + 365 * 86400000), true);
  assert.equal(allowedSession({ ...continuous, uid: 'viewer' }), false);
  assert.equal(allowedSession({ ...continuous, simulator_grant_version: 'revoked-version' }), false);
  assert.equal(allowedSession({ uid: 'simulator-preview', simulator_preview: true }), false);
});
test('preview scope cannot change PINs, publish content, comment or download', () => {
  for (const path of ['/savePin', '/api/admin/catalog', '/api/shorts/rtdb-ball-2-1/download']) {
    assert.equal(allowedRequest({ method: 'POST', path }), false);
    assert.equal(allowedRequest({ method: 'GET', path }), false);
  }
  assert.equal(allowedRequest({ method: 'GET', path: '/api/public/live-feed' }), true);
  assert.equal(allowedRequest({ method: 'GET', path: '/api/my-performance/analytics/batting' }), true);
});
test('verified preview token reaches reads and is blocked before write handlers', async () => {
  const guard = middleware(() => ({ verifyIdToken: async () => preview() }));
  let calls = 0;
  const read = { headers: { authorization: 'Bearer signed' }, method: 'GET', path: '/api/scoring-archives' };
  await guard(read, response(), () => calls++);
  assert.equal(read.simulatorPreview, true); assert.equal(calls, 1);
  const res = response();
  await guard({ ...read, method: 'PUT', path: '/api/admin/visibility' }, res, () => calls++);
  assert.equal(res.code, 403); assert.equal(calls, 1);
});
test('forged tokens and expired claims fail, normal users receive no preview access', async () => {
  const expired = middleware(() => ({ verifyIdToken: async () => ({ ...preview(), preview_expires_at: 1 }) }));
  const request = { headers: { authorization: 'Bearer signed', 'x-jbmr-simulator-player': 'forged' }, method: 'GET', path: '/api/simulator/players' };
  const res = response(); await expired(request, res, () => assert.fail('Expired session passed'));
  assert.equal(res.code, 401);
  const forged = middleware(() => ({ verifyIdToken: async () => { throw Error('Invalid signature'); } }));
  const bad = response(); await forged(request, bad, () => assert.fail('Forged token passed'));
  assert.equal(bad.code, 401);
  const normal = { ...request };
  await middleware(() => ({ verifyIdToken: async () => ({ uid: 'viewer' }) }))(normal, response(), () => {});
  assert.equal(normal.simulatorPreview, undefined);
});
