'use strict';

const { createHash } = require('node:crypto');
const { database } = require('./mysql-pin.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');

function account(req) {
  const user = req.user;
  if (!user?.uid || user.auth_provider !== 'mysql' || !/^\+91\d{10}$/.test(user.phone_number || '')) {
    throw Object.assign(Error('MySQL session required'), { status: 401 });
  }
  return { uid: user.uid, phoneE164: user.phone_number, phoneNational: user.phone_number.slice(3) };
}

function iso(value, fallback) {
  const seconds = value?._seconds ?? value?.seconds;
  const date = typeof seconds === 'number' ? new Date(seconds * 1000) : new Date(value);
  return value != null && Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function profile(body, identity, now) {
  return { ...identity, displayName: String(body.displayName || 'JBMR User').slice(0, 100),
    createdAt: iso(body.createdAt, now), lastLoginAt: iso(body.lastLoginAt, now) };
}

function createService(pool = database) {
  return async (identity, displayName) => {
    const path = `users/${identity.uid}`, now = new Date().toISOString();
    const conn = await pool().getConnection();
    try {
      await conn.beginTransaction();
      const initial = profile({}, identity, now);
      // Existing migrated profile fields are preserved; concurrent first reads
      // converge on the same unique hash, without overwriting imported data.
      await conn.execute('INSERT INTO app_documents (path_hash,path,collection_path,body) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE path_hash=path_hash',
        [hash(path), path, 'users', JSON.stringify(initial)]);
      const [[row]] = await conn.execute('SELECT path,body FROM app_documents WHERE path_hash=? FOR UPDATE', [hash(path)]);
      if (!row || row.path !== path) throw Error('Profile identity mismatch');
      const body = typeof row.body === 'string' ? JSON.parse(row.body) : row.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('Invalid profile');
      if (displayName !== undefined) {
        body.displayName = displayName;
        await conn.execute('UPDATE app_documents SET body=? WHERE path_hash=?', [JSON.stringify(body), hash(path)]);
      }
      await conn.commit();
      return profile(body, identity, now);
    } catch (error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
  };
}

function install(app, authenticated, { service = createService() } = {}) {
  const handle = update => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const identity = account(req);
      const name = update ? String(req.body?.displayName || '').trim() : undefined;
      if (update && (name.length < 2 || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name))) {
        return res.status(400).json({ error: 'Name must be 2–100 characters' });
      }
      res.json(await service(identity, name));
    } catch (error) {
      res.status(error.status || 503).json({ error: error.status === 401 ? 'Please sign in again' : 'Profile is temporarily unavailable' });
    }
  };
  app.get('/api/account/profile', authenticated, handle(false));
  app.put('/api/account/profile', authenticated, handle(true));
}

module.exports = { install, createService, account, profile };
