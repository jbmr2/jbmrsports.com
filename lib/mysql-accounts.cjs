'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { database } = require('./mysql-pin.cjs');
const lifetimeMs = 30 * 24 * 60 * 60 * 1000;
const prefix = 'jbmr1_';
const isSessionToken = token => /^jbmr1_[A-Za-z0-9_-]{43}$/.test(token);
const hashToken = token => createHash('sha256').update(token).digest('hex');

async function findAccount(phone) {
  const [[account]] = await database().execute(
    `SELECT a.uid, a.phone, a.disabled, EXISTS(SELECT 1 FROM phone_pins p WHERE p.uid = a.uid AND p.phone = a.phone) AS pin_configured FROM app_accounts a WHERE a.phone = ?`, [phone]
  );
  return account;
}

function unavailableAccount() {
  return Object.assign(new Error('Account unavailable'), { status: 401 });
}

async function issueSessionForPin(phone, uid) {
  const account = await findAccount(phone);
  if (account?.uid !== uid || account.disabled) throw unavailableAccount();
  return issueSession(account);
}

async function issueSessionForOtp(phone) {
  const account = await findAccount(phone);
  if (!account || account.disabled) throw unavailableAccount();
  return issueSession(account);
}

async function issueSession(account) {
  const db = database();
  const token = prefix + randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = now + lifetimeMs;
  await db.execute('DELETE FROM app_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT 100', [now]);
  await db.execute(
    'INSERT INTO app_sessions (token_hash, uid, expires_at) VALUES (?, ?, ?)',
    [hashToken(token), account.uid, expiresAt]
  );
  return { token, uid: account.uid, phone: account.phone, expiresAt, pinConfigured: Boolean(account.pin_configured) };
}

async function verifySession(token) {
  if (!isSessionToken(token)) throw unavailableAccount();
  const [[row]] = await database().execute(
    `SELECT a.uid, a.phone FROM app_sessions AS s
     JOIN app_accounts AS a ON a.uid = s.uid
     WHERE s.token_hash = ? AND s.expires_at > ? AND a.disabled = FALSE`,
    [hashToken(token), Date.now()]
  );
  if (!row) throw unavailableAccount();
  return { uid: row.uid, phone_number: '+91' + row.phone };
}

async function revokeSession(token) {
  if (isSessionToken(token)) {
    await database().execute('DELETE FROM app_sessions WHERE token_hash = ?', [hashToken(token)]);
  }
}

async function importAccount(uid, phone, disabled) {
  await database().execute(
    'INSERT INTO app_accounts (uid, phone, disabled) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE phone = phone',
    [uid, phone, disabled]
  );
  const account = await findAccount(phone);
  if (account?.uid !== uid || Boolean(account.disabled) !== disabled) {
    throw new Error('Existing MySQL account conflicts with Firebase');
  }
}

async function checkSchema() {
  await database().query(`SELECT
    (SELECT COUNT(*) FROM (SELECT uid FROM app_accounts LIMIT 0) AS accounts),
    (SELECT COUNT(*) FROM (SELECT token_hash FROM app_sessions LIMIT 0) AS sessions)`);
}

module.exports = { checkSchema, isSessionToken, verifySession, revokeSession, issueSessionForPin, issueSessionForOtp, importAccount };
