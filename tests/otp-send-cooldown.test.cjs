const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function load(relativePath, overrides) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve(relativePath), 'utf8'), {
    module, require, Date, ...overrides,
  });
  return module.exports;
}

test('the shared send limit applies across networks and leaves verification available', async () => {
  let now = 1_000_000;
  let rows = new Map();
  const conn = {
    beginTransaction() { this.before = new Map(rows); },
    commit() {},
    rollback() { rows = this.before; },
    release() {},
    async execute(sql, args) {
      if (sql.startsWith('INSERT INTO auth_attempts')) {
        const [scope, started_at] = args;
        if (!rows.has(scope)) rows.set(scope, { started_at, attempts: 0 });
      } else if (sql.startsWith('SELECT')) {
        assert.match(sql, /FOR UPDATE/);
        return [[rows.get(args[0])]];
      } else if (sql.startsWith('UPDATE auth_attempts')) {
        const [started_at, attempts, scope] = args;
        rows.set(scope, { started_at, attempts });
      } else {
        assert.fail('Unexpected database operation');
      }
    },
  };
  const service = load('../lib/mysql-pin.cjs', {
    Date: { now: () => now },
    process: { env: { DB_USER: 'fixture', DB_NAME: 'fixture', DB_PASSWORD: 'fixture' } },
    require: name => name === 'mysql2/promise'
      ? { createPool: () => ({ getConnection: async () => conn }) }
      : require(name),
  });
  const phone = '0000000000';
  await service.limitAttempts('send', phone, '192.0.2.1');
  await assert.rejects(service.limitAttempts('send', phone, '192.0.2.2'),
    { status: 429, retryAfter: 120 });
  await service.limitAttempts('verify', phone, '192.0.2.1');
  now += 120_000;
  await service.limitAttempts('send', phone, '192.0.2.2');
});

test('normal OTP send and sign-in still work and a cooldown denial skips the SMS provider', async () => {
  const phone = '0000000000';
  const code = '123456';
  const sessionId = 'test-session-id';
  const address = '192.0.2.1';
  let shouldLimit = false;
  let challenge;
  let providerSends = 0;
  const audit = [];
  const store = {
    async limitAttempts(kind) {
      if (kind === 'send' && shouldLimit) {
        throw Object.assign(new Error('Wait before requesting another code'), { status: 429, retryAfter: 120 });
      }
    },
    async createOtpSession(id, owner) {
      if (id === sessionId) challenge = { id, owner, used: false };
    },
    async checkOtpSession(id, owner) {
      return challenge?.id === id && challenge.owner === owner && !challenge.used;
    },
    async consumeOtpSession(id, owner) {
      if (!await this.checkOtpSession(id, owner)) return false;
      challenge.used = true;
      return true;
    },
    pinProofKey: (uid, proof) => uid + proof,
  };
  const api = load('../lib/otp-2factor.cjs', {
    process: { env: { TWOFACTOR_API_KEY: 'fixture-key' } },
    AbortSignal,
    console: { info: (...args) => audit.push(args), warn: (...args) => audit.push(args) },
    require: name => name === './mysql-pin.cjs' ? store : require(name),
    fetch: async url => {
      if (url.endsWith('/AUTOGEN/OTP1')) {
        providerSends++;
        return { ok: true, json: async () => ({ Status: 'Success', Details: sessionId }) };
      }
      assert.ok(url.endsWith('/VERIFY/' + sessionId + '/' + code));
      return { ok: true, json: async () => ({ Status: 'Success' }) };
    },
  });
  const req = { method: 'POST', path: '/api/auth/sendOtp', body: { phone }, ip: address,
    headers: { 'user-agent': 'CFNetwork/fixture' } };
  function response() {
    return {
      code: 200, headers: {},
      status(value) { this.code = value; return this; },
      set(key, value) { this.headers[key] = value; return this; },
      json(value) { this.body = value; },
    };
  }
  const sent = response();
  await api.handleSendOtp(req, sent);
  assert.equal(sent.body.sessionId, sessionId);
  shouldLimit = true;
  const rejected = response();
  await api.handleSendOtp({ ...req, path: '/sendOtp' }, rejected);
  assert.equal(rejected.code, 429);
  assert.equal(rejected.headers['Retry-After'], '120');
  assert.equal(providerSends, 1);
  const verified = response();
  await api.verifyOtp({ ...req, body: { phone, otp: code, sessionId } }, verified,
    async owner => ({ uid: 'fixture', phone: owner, token: 'jbmr1_fixture' }));
  assert.equal(verified.body.ok, true);
  assert.equal(verified.body.token, 'jbmr1_fixture');
  assert.equal(challenge.used, true);
  assert.equal(audit[0][1].clientHint, 'apple');
  assert.equal(audit[0][1].network, audit[1][1].network);
  assert.match(audit[0][1].sessionHash, /^[a-f0-9]{64}$/);
  for (const sensitive of [phone, address, sessionId, code]) {
    assert.ok(!JSON.stringify(audit).includes(sensitive));
  }
});
