'use strict';

const { createHash } = require('node:crypto');

let pool;
function database() {
  if (pool) return pool;
  const { DB_USER: user, DB_NAME: database, DB_PASSWORD: password } = process.env;
  if (!user || !database || !password) throw new Error('MySQL PIN database is not configured');
  pool = require('mysql2/promise').createPool({
    host: '127.0.0.1', port: 3306, user, database, password,
    connectionLimit: 4, connectTimeout: 5000, multipleStatements: false,
  });
  return pool;
}

async function findPin(phone) {
  const [rows] = await database().execute(
    'SELECT uid, pin_hash AS pinHash FROM phone_pins WHERE phone = ?', [phone]
  );
  return rows[0];
}

async function savePin(phone, uid, hash) {
  await database().execute(
    'INSERT INTO phone_pins (phone, uid, pin_hash) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE uid = ?, pin_hash = ?',
    [phone, uid, hash, uid, hash]
  );
}

async function importPin(phone, uid, hash) {
  await database().execute(
    'INSERT INTO phone_pins (phone, uid, pin_hash) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE phone = phone',
    [phone, uid, hash]
  );
}

async function upgradePin(phone, uid, oldHash, newHash) {
  await database().execute(
    'UPDATE phone_pins SET pin_hash = ? WHERE phone = ? AND uid = ? AND pin_hash = ?',
    [newHash, phone, uid, oldHash]
  );
}

const windowMs = 15 * 60 * 1000;
const otpResendCooldownMs = 2 * 60 * 1000;
const fingerprint = value => createHash('sha256').update(value).digest('hex');

async function limitAttempts(kind, phone, ip) {
  const phoneHash = fingerprint(phone);
  const scopes = [{ key: kind + '_phone_' + phoneHash, max: kind === 'send' ? 6 : 10, duration: windowMs }];
  if (ip) scopes.unshift({ key: kind + '_ip_' + fingerprint(ip), max: kind === 'send' ? 20 : 60, duration: windowMs });
  if (kind === 'send') {
    scopes.push({ key: 'send_cooldown_' + phoneHash, max: 1, duration: otpResendCooldownMs });
  }
  const conn = await database().getConnection();
  const now = Date.now();
  try {
    await conn.beginTransaction();
    for (const { key, max, duration } of scopes) {
      await conn.execute(
        'INSERT INTO auth_attempts VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE scope = scope',
        [key, now]
      );
      const [[row]] = await conn.execute(
        'SELECT started_at, attempts FROM auth_attempts WHERE scope = ? FOR UPDATE', [key]
      );
      const remaining = Number(row.started_at) + duration - now;
      const expired = remaining <= 0;
      if (!expired && row.attempts >= max) {
        const retryAfter = Math.ceil(remaining / 1000);
        const message = duration === otpResendCooldownMs
          ? 'An OTP was recently requested. Use your latest code or wait before requesting another.'
          : 'Too many attempts. Try again later.';
        throw Object.assign(new Error(message), { status: 429, retryAfter });
      }
      await conn.execute('UPDATE auth_attempts SET started_at = ?, attempts = ? WHERE scope = ?',
        [expired ? now : row.started_at, expired ? 1 : row.attempts + 1, key]);
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function createOtpSession(sessionId, phone) {
  const db = database();
  const now = Date.now();
  await db.execute('DELETE FROM otp_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT 100', [now]);
  await db.execute('INSERT INTO otp_sessions (session_hash, phone, expires_at) VALUES (?, ?, ?)',
    [fingerprint(sessionId), phone, now + 5 * 60 * 1000]);
}

async function checkOtpSession(sessionId, phone) {
  const [rows] = await database().execute(
    'SELECT 1 FROM otp_sessions WHERE session_hash = ? AND phone = ? AND used = FALSE AND expires_at > ?',
    [fingerprint(sessionId), phone, Date.now()]
  );
  return rows.length === 1;
}

async function consumeOtpSession(sessionId, phone) {
  const [result] = await database().execute(
    'UPDATE otp_sessions SET used = TRUE WHERE session_hash = ? AND phone = ? AND used = FALSE AND expires_at > ?',
    [fingerprint(sessionId), phone, Date.now()]
  );
  return result.affectedRows === 1;
}

async function deletePin(phone, uid) {
  await database().execute('DELETE FROM phone_pins WHERE phone = ? AND uid = ?', [phone, uid]);
}

async function checkSchema() {
  await database().query(`SELECT
    (SELECT COUNT(*) FROM (SELECT phone FROM phone_pins LIMIT 0) AS pins),
    (SELECT COUNT(*) FROM (SELECT scope FROM auth_attempts LIMIT 0) AS attempts),
    (SELECT COUNT(*) FROM (SELECT session_hash FROM otp_sessions LIMIT 0) AS otp)`);
}

async function close() {
  if (pool) await pool.end();
}

module.exports = { database, findPin, savePin, importPin, upgradePin, limitAttempts, createOtpSession, checkOtpSession, consumeOtpSession, deletePin, checkSchema, close };
