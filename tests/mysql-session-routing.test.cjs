'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { middleware } = require('../lib/simulator-access.cjs');
const { phoneForRequest } = require('../lib/verified-account.cjs');
const { scheduleExpiry } = require('../lib/session-expiry.cjs');
const response = () => ({ status(code) { this.code = code; return this; }, json(body) { this.body = body; } });

test('MySQL bearer survives the global guard without Firebase verification or preview privileges', async () => {
  const token = 'jbmr1_' + 'a'.repeat(43);
  let calls = 0;
  const guard = middleware(async received => {
    assert.equal(received, token);
    return { uid: 'fixture', phone_number: '+919999999999', auth_provider: 'mysql' };
  });
  const req = { method: 'GET', path: '/api/my-performance', headers: { authorization: `Bearer ${token}` }, query: { phone: '1111111111' } };
  await guard(req, response(), () => calls++);
  assert.equal(calls, 1);
  assert.equal(req.simulatorPreview, undefined);
  req.user = req.verifiedUser;
  assert.equal(await phoneForRequest(req), '+919999999999');
});

test('invalid or revoked tokens stop before data handlers', async () => {
  const res = response();
  await middleware(async () => { throw Error('Revoked'); })({ headers: { authorization: 'Bearer invalid' } }, res, () => assert.fail('Unauthorized request passed'));
  assert.equal(res.code, 401);
});

test('client phone selectors and preview identities cannot become verified MySQL ownership', async () => {
  for (const user of [undefined, { uid: 'fixture', auth_provider: 'mysql' }, { uid: 'preview', simulator_preview: true }]) {
    await assert.rejects(phoneForRequest({ user, body: { phone: '9999999999' }, query: { phone: '9999999999' } }));
  }
});

test('30-day socket sessions do not overflow Node timers and close at expiry', () => {
  let now = 0, closed = 0, callback, delay;
  const expiry = 30 * 86400000;
  scheduleExpiry(expiry, () => closed++, { now: () => now, schedule: (cb, ms) => { callback = cb; delay = ms; return 1; } });
  assert.equal(delay, 2147483647); assert.equal(closed, 0);
  now += delay; callback();
  assert.equal(delay, expiry - now); assert.equal(closed, 0);
  now = expiry; callback(); assert.equal(closed, 1);
});

test('cancelled and already-expired session deadlines behave correctly', () => {
  let closed = 0, cancelled = 0, callback;
  const stop = scheduleExpiry(100, () => closed++, { now: () => 0, schedule: cb => { callback = cb; return 7; }, cancel: id => { assert.equal(id, 7); cancelled++; } });
  stop(); callback(); assert.equal(closed, 0); assert.equal(cancelled, 1);
  scheduleExpiry(1, () => closed++, { now: () => 2 }); assert.equal(closed, 1);
});
