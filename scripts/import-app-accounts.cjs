'use strict';

require('dotenv').config();
const { initializeApp, applicationDefault, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { close } = require('../lib/mysql-pin.cjs');
const { importAccount } = require('../lib/mysql-accounts.cjs');

async function run() {
  const projectId = 'jbmrsports-cricket-live';
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 &&
      Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'));
  const account = raw && JSON.parse(raw);
  if (account && account.project_id !== projectId) throw new Error('Wrong source project');
  initializeApp({ projectId, credential: account ? cert(account) : applicationDefault() });

  const dryRun = !process.argv.includes('--apply');
  const records = [];
  let excluded = 0;
  let pageToken;
  do {
    const result = await getAuth().listUsers(1000, pageToken);
    for (const user of result.users) {
      const phone = /^\+91(\d{10})$/.exec(user.phoneNumber || '')?.[1];
      if (phone) records.push({ uid: user.uid, phone, disabled: user.disabled });
      else excluded++;
    }
    pageToken = result.pageToken;
  } while (pageToken);

  let verified = 0;
  if (!dryRun) {
    for (const { uid, phone, disabled } of records) {
      await importAccount(uid, phone, disabled);
      verified++;
    }
  }
  console.log(JSON.stringify({ dryRun, eligible: records.length, excluded, verified }));
}

run().catch(error => {
  console.error('Account import failed', error.code || error.name);
  process.exitCode = 1;
}).finally(() => close());
