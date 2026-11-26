'use strict';
const { entries } = require('./match-archives.cjs');
function phone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return /^91\d{10}$/.test(digits) ? digits.slice(2) : /^\d{10}$/.test(digits) ? digits : '';
}
function mappedPhones(player, directory, links) {
  const id = String(player.id);
  // An explicit link replaces the previous owner. An empty/invalid override
  // revokes access; it must never fall back to stale archive/directory phones.
  if (links && Object.hasOwn(links, id)) {
    const link = links[id];
    const number = phone(typeof link === 'string' ? link : link?.phone);
    return number ? [number] : [];
  }
  const candidates = entries(directory).filter(row =>
    String(row.player_id ?? row.playerId ?? row.scorer_player_id ?? row.id) === id
    && (!player.player_uid || String(row.public_player_uid || '') === String(player.player_uid)));
  const numbers = [...new Set(candidates.flatMap(row =>
    [row.mobile, row.mobile_number, row.phone, row.phone_number, row.unique_id].map(phone).filter(Boolean)))];
  // Conflicting identity mappings require correction by the admin, not a guess.
  return numbers.length === 1 ? numbers : [];
}
function scopedPlayerKey(installationId, playerId) {
  return JSON.stringify([String(installationId), String(playerId)]);
}
function mappedPayloadPhones(player, payload, directories, overrides) {
  const source = payload.installation_id;
  const id = String(player.id);
  const direct = overrides[source];
  if (direct && Object.hasOwn(direct, id)) return mappedPhones(player, directories[source], direct);

  // Historical aliases are supplied only after matching the archive against
  // the same match UID, numeric ID and tournament in the active scorer.
  const aliases = (payload.ownershipBackups ?? []).flatMap(backup => {
    const matchId = String(backup.archive_manifest.match_id);
    const innings = new Set(entries(backup.tables?.innings).filter(row => String(row.match_id) === matchId).map(row => String(row.id)));
    const inSquad = entries(backup.tables?.match_lineups).some(row => String(row.match_id) === matchId && String(row.player_id) === id);
    const played = entries(backup.tables?.balls).some(row => innings.has(String(row.innings_id))
      && [row.striker_id, row.non_striker_id, row.bowler_id].some(value => String(value) === id));
    if (!inSquad && !played) return [];
    const candidates = entries(backup.tables?.players).filter(row => String(row.id) === id
      && (!player.player_uid || !row.player_uid || player.player_uid === row.player_uid));
    return candidates.length === 1 ? [{ source: backup.installation_id, player: candidates[0] }] : [];
  });
  // A stable player UID also allows matching a player in matches created after
  // migration. Numeric IDs from unrelated installations never do.
  if (player.player_uid) {
    for (const [scope, directory] of Object.entries(directories)) {
      if (scope === source) continue;
      const candidates = entries(directory).filter(row => row.public_player_uid === player.player_uid);
      if (candidates.length !== 1) continue;
      const row = candidates[0];
      const playerId = row.player_id ?? row.playerId ?? row.scorer_player_id ?? row.id;
      if (playerId != null) aliases.push({ source: scope, player: { id: playerId, player_uid: player.player_uid } });
    }
  }
  const linkedOverrides = aliases.filter(({ source, player }) =>
    overrides[source] && Object.hasOwn(overrides[source], String(player.id)));
  if (linkedOverrides.length) {
    const numbers = linkedOverrides.map(ref => mappedPhones(ref.player, directories[ref.source], overrides[ref.source])[0]);
    return numbers.every(number => number && number === numbers[0]) ? [numbers[0]] : [];
  }
  const numbers = new Set([...mappedPhones(player, directories[source], direct),
    ...aliases.flatMap(ref => mappedPhones(ref.player, directories[ref.source], overrides[ref.source]))]);
  return numbers.size === 1 ? [...numbers] : [];
}
function resolveMappedPlayerKeys({ archives, verifiedPhone, playerDirectory = {}, playerDownloadLinks = {} }) {
  const normalized = phone(verifiedPhone), keys = new Set();
  if (!normalized) return keys;
  for (const archive of archives) {
    const source = String(archive.installation_id || '');
    if (!source) continue;
    for (const player of entries(archive.tables?.players)) {
      if (mappedPayloadPhones(player, archive, playerDirectory, playerDownloadLinks).includes(normalized)) {
        keys.add(scopedPlayerKey(source, player.id));
      }
    }
  }
  return keys;
}
module.exports = { phone, mappedPhones, mappedPayloadPhones, scopedPlayerKey, resolveMappedPlayerKeys };
