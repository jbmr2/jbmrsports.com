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
function resolveMappedPlayerKeys({ archives, verifiedPhone, playerDirectory = {}, playerDownloadLinks = {} }) {
  const normalized = phone(verifiedPhone), keys = new Set();
  if (!normalized) return keys;
  for (const archive of archives) {
    const source = String(archive.installation_id || '');
    if (!source) continue;
    for (const player of entries(archive.tables?.players)) {
      if (mappedPhones(player, playerDirectory[source], playerDownloadLinks[source]).includes(normalized)) {
        keys.add(scopedPlayerKey(source, player.id));
      }
    }
  }
  return keys;
}
module.exports = { phone, mappedPhones, scopedPlayerKey, resolveMappedPlayerKeys };
