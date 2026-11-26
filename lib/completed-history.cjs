'use strict';

async function read({
  firestore = () => require('./admin-visibility.cjs').archivesForLiveCatalog(),
  firestoreDiagnostics = () => require('./admin-visibility.cjs').archiveDiagnostics(),
  migrated = options => require('./mysql-archives.cjs').read(options)
} = {}) {
  const invalid = new Set();
  const [legacy, sql] = await Promise.allSettled([
    Promise.resolve().then(firestore),
    Promise.resolve().then(() => migrated({ onInvalidArchive: ({ matchUID }) => invalid.add(matchUID) }))
  ]);
  if (legacy.status === 'rejected' && sql.status === 'rejected') throw legacy.reason;
  const payloads = new Map();
  for (const result of [sql, legacy]) {
    if (result.status !== 'fulfilled') continue;
    for (const payload of result.value) {
      const uid = payload.archive_manifest?.match_uid;
      if (uid) payloads.set(JSON.stringify([payload.installation_id, uid]), payload);
    }
  }
  const legacyReport = legacy.status === 'fulfilled' ? firestoreDiagnostics() : {};
  for (const uid of legacyReport.invalidMatchUIDs || []) invalid.add(uid);
  for (const payload of payloads.values()) invalid.delete(payload.archive_manifest.match_uid);
  return { payloads: [...payloads.values()], diagnostics: {
    invalidArchives: invalid.size,
    invalidMatchUIDs: [...invalid],
    partialSources: [legacy.status === 'rejected' ? 'firestore' : null, sql.status === 'rejected' ? 'mysql' : null].filter(Boolean)
  } };
}

module.exports = { read };
