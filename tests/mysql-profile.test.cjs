'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { install, createService, account, profile } = require('../lib/mysql-profile.cjs');
const identity = { uid: 'fixture', phoneE164: '+919999999999', phoneNational: '9999999999' };
test('profile identity comes only from authenticated MySQL session', () => {
  assert.deepEqual(account({ user: { uid: 'fixture', auth_provider: 'mysql', phone_number: identity.phoneE164 }, body: { uid: 'other', phone: '1111111111' } }), identity);
  for (const user of [undefined, { uid: 'fixture' }, { uid: 'simulator-preview', simulator_preview: true }]) assert.throws(() => account({ user }));
});
test('profile projection preserves imported timestamp and hides unrelated private fields', () => {
  const result = profile({ createdAt: { _seconds: 1600000000 }, lastLoginAt: '2026-11-16T00:00:00Z', displayName: 'Fixture Player', privateField: 'secret' }, identity, '2026-11-17T00:00:00Z');
  assert.equal(result.createdAt, '2020-09-13T12:26:40.000Z');
  assert.equal(result.privateField, undefined);
});
test('updating profile preserves all other stored fields and rolls back failures', async () => {
  let stored = { displayName: 'Old', favouriteTeam: 'A', createdAt: '2020-01-01T00:00:00Z' }, committed = 0, rolledBack = 0, released = 0;
  const conn = { beginTransaction: async () => {}, commit: async () => committed++, rollback: async () => rolledBack++, release: () => released++, execute: async (sql, params) => {
    if (sql.startsWith('SELECT')) return [[{ path: 'users/fixture', body: JSON.stringify(stored) }]];
    if (sql.startsWith('UPDATE')) stored = JSON.parse(params[0]);
    return [{ affectedRows: 1 }];
  } };
  const service = createService(() => ({ getConnection: async () => conn }));
  const result = await service(identity, 'New Name');
  assert.equal(result.displayName, 'New Name'); assert.equal(stored.favouriteTeam, 'A'); assert.equal(committed, 1);
  await assert.rejects(service({ ...identity, uid: 'different' }));
  assert.equal(rolledBack, 1); assert.equal(released, 2);
});
test('profile routes reject invalid names before invoking storage', async () => {
  const routes = new Map(); let calls = 0;
  install({ get: (p,...h) => routes.set('GET'+p,h), put: (p,...h) => routes.set('PUT'+p,h) }, () => {}, { service: async () => { calls++; } });
  const req = { user: { uid: 'fixture', auth_provider: 'mysql', phone_number: identity.phoneE164 }, body: { displayName: 'x' } };
  const res = { set() { return this; }, status(n) { this.code = n; return this; }, json() {} };
  await routes.get('PUT/api/account/profile').at(-1)(req,res);
  assert.equal(res.code,400); assert.equal(calls,0);
});
