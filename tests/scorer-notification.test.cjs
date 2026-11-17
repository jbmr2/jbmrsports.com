'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { install } = require('../lib/scorer-notification.cjs');
test('commit notifications require configured authentication and valid IDs; never accept client score data', () => {
  let route, calls = 0, hash = '';
  install({ post: (path, fn) => { assert.equal(path, '/api/scorer/committed'); route = fn; } }, () => calls++, { configuredHash: () => hash });
  const token = 'a'.repeat(43), body = { matchId: '90', version: '12', runs: 9999 };
  function send(value = token, requestBody = body) {
    let status = 200;
    const res = { set() { return this; }, status(code) { status = code; return this; }, json() { return status; } };
    route({ headers: { authorization: 'Bearer ' + value }, body: requestBody }, res);
    return status;
  }
  assert.equal(send(), 503);
  hash = createHash('sha256').update(token).digest('hex');
  assert.equal(send('invalid'), 401); assert.equal(calls, 0);
  assert.equal(send(token, { matchId: '../90', version: 12 }), 400);
  assert.equal(send(), 202); assert.equal(calls, 1);
  assert.equal(send(), 202); assert.equal(calls, 2);
});
