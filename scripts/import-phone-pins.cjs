'use strict';

require('dotenv').config();
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const mysqlPin = require('../lib/mysql-pin.cjs');
const projectId = 'jbmrsports-cricket-live';
const validHash = /^(?:[a-f0-9]{64}|scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{64})$/;

async function run() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 &&
      Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'));
  const account = raw && JSON.parse(raw);
  if (account && account.project_id !== projectId) throw new Error('Wrong source project');
  initializeApp({ projectId, credential: account ? cert(account) : applicationDefault() });
  const dryRun = !process.argv.includes('--apply');
  const candidates = new Map();
  const source = getFirestore('criccricket');
  let skipped = 0;

  async function verifiedPhone(uid) {
    const user = await getAuth().getUser(uid).catch(error => {
      if (error.code === 'auth/user-not-found') return null;
      throw error;
    });
    return user && !user.disabled ? /^\+91(\d{10})$/.exec(user.phoneNumber || '')?.[1] : null;
  }

  for await (const document of source.collection('phonePins').stream()) {
    const { uid, pinHash } = document.data();
    if (!/^\d{10}$/.test(document.id) || typeof uid !== 'string' || !uid || uid.length > 128 ||
      typeof pinHash !== 'string' || !validHash.test(pinHash) ||
      await verifiedPhone(uid) !== document.id) {
      skipped++;
      continue;
    }
    candidates.set(document.id, { uid, pinHash });
  }

  for await (const document of source.collection('users').where('pinHash', '!=', null).stream()) {
    const { pinHash } = document.data();
    const phone = await verifiedPhone(document.id);
    if (phone && candidates.has(phone)) continue;
    if (!phone || typeof pinHash !== 'string' || !validHash.test(pinHash)) {
      skipped++;
      continue;
    }
    candidates.set(phone, { uid: document.id, pinHash });
  }

  let verified = 0;
  let conflicts = 0;
  if (!dryRun && skipped === 0) {
    for (const [phone, { uid, pinHash }] of candidates) {
      await mysqlPin.importPin(phone, uid, pinHash);
      const stored = await mysqlPin.findPin(phone);
      if (stored?.uid === uid && stored.pinHash === pinHash) verified++;
      else conflicts++;
    }
  }
  console.log(JSON.stringify({ dryRun, accepted: candidates.size, skipped, verified, conflicts }));
  if (skipped || conflicts) process.exitCode = 1;
}

run().catch(error => {
  console.error('PIN import failed', error.code || error.name);
  process.exitCode = 1;
}).finally(() => mysqlPin.close());
