'use strict';

const { entries } = require('./match-archives.cjs');
const { allowsClip } = require('./admin-visibility.cjs');

function matchOf(payload) {
  const manifest = payload.archive_manifest;
  if (!manifest?.match_uid) return undefined;
  const matches = entries(payload.tables?.matches).filter(row =>
    String(row.match_uid ?? row.matchUid ?? '') === String(manifest.match_uid) &&
    (manifest.match_id == null || String(row.id) === String(manifest.match_id)));
  return matches.length === 1 ? matches[0] : undefined;
}

const isComplete = match => ['completed', 'complete', 'finished', 'ended', 'result']
  .includes(String(match?.status ?? '').trim().toLowerCase());

function identity(match) {
  return JSON.stringify([match.match_uid ?? match.matchUid, String(match.id), String(match.tournament_id)]);
}

function publicationRules(payload, scopedRules) {
  const match = matchOf(payload);
  if (!match) return scopedRules;
  return { ...scopedRules, matches: { ...scopedRules.matches,
    [`${payload.installation_id}:${match.id}`]: { show: true } } };
}

async function load({
  readArchive = options => require('./mysql-archives.cjs').read(options),
  readScores = () => require('./mysql-scoring.cjs').scoreHeads(),
  readMatch = id => require('./mysql-scoring.cjs').readMatch(id),
  readVisibility = () => require('./mysql-visibility.cjs').read(),
  resolve = (payload, visibility) => require('./mysql-match-identity.cjs').visibility(payload, visibility),
  publicOnly = true
} = {}) {
  const invalid = new Set();
  const [rules, sources] = await Promise.all([
    publicOnly ? readVisibility() : Promise.resolve({}),
    Promise.allSettled([readArchive({ onInvalidArchive: ({ matchUID }) => invalid.add(matchUID) }), readScores()])
  ]);
  const [archiveResult, scoreResult] = sources;
  if (archiveResult.status === 'rejected' && scoreResult.status === 'rejected') throw scoreResult.reason;
  const archives = archiveResult.value ?? [];
  const current = scoreResult.value;
  const effective = publicOnly && current ? await resolve(current, rules) : rules;
  const currentRows = entries(current?.tables?.matches).filter(row => row.match_uid);
  const indexedCurrent = new Map(currentRows.map(match => [identity(match), match]));
  const archiveByIdentity = new Map();
  const payloads = new Map();
  const partialSources = new Set(archiveResult.status === 'rejected' ? ['migrated-mysql'] : []);
  if (!current) partialSources.add('current-scoring');

  for (const archive of archives) {
    const match = matchOf(archive);
    if (!isComplete(match)) continue;
    const key = identity(match);
    const known = indexedCurrent.get(key);
    if (known && isComplete(known)) {
      if (!archiveByIdentity.has(key)) archiveByIdentity.set(key, []);
      archiveByIdentity.get(key).push(archive);
    } else if (!known && (!publicOnly || allowsClip(String(match.id), String(match.tournament_id), rules, archive.installation_id))) {
      payloads.set(key, { payload: archive, rules });
    }
  }

  const approved = currentRows.filter(match => isComplete(match)
    && (!publicOnly || allowsClip(String(match.id), String(match.tournament_id), effective, current.installation_id)));
  // Keep within the scorer connection pool on shared hosting.
  for (let index = 0; index < approved.length; index += 2) {
    await Promise.all(approved.slice(index, index + 2).map(async match => {
      const key = identity(match);
      const backups = archiveByIdentity.get(key) ?? [];
      let detail;
      try { detail = await readMatch(String(match.id)); }
      catch { partialSources.add('current-scoring'); }
      if (detail?.installation_id === current.installation_id && isComplete(matchOf(detail))
          && identity(matchOf(detail)) === key) {
        payloads.set(key, { payload: detail, rules: publicationRules(detail, effective), backups });
      } else {
        const backup = backups.find(row => !publicOnly || allowsClip(String(match.id), String(match.tournament_id), rules, row.installation_id));
        if (backup) payloads.set(key, { payload: backup, rules });
        else partialSources.add('current-scoring');
      }
    }));
  }
  const selected = [...payloads.values()];
  for (const { payload } of selected) invalid.delete(payload.archive_manifest.match_uid);
  return { selected, diagnostics: { invalidArchives: invalid.size, invalidMatchUIDs: [...invalid], partialSources: [...partialSources],
    currentCompleted: currentRows.filter(isComplete).length, currentPublished: approved.length,
    backupCompleted: archives.filter(payload => isComplete(matchOf(payload))).length,
    completedReturned: selected.length } };
}

let pending;
function read(deps) {
  if (deps) return load(deps);
  pending ||= load().finally(() => { pending = undefined; });
  return pending;
}

function readForPlayerAnalytics(deps) {
  if (deps) return load({ ...deps, publicOnly: false });
  return load({ publicOnly: false });
}

module.exports = { read, readForPlayerAnalytics, matchOf };
