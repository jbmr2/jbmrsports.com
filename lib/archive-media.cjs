const rows = value => Object.values(value || {}).filter(x => x && typeof x === 'object');
function identity(match, installationID) {
  const keys = ['id', 'tournament_id', 'team_a_id', 'team_b_id'];
  if (keys.some(key => match[key] == null)) return null;
  return JSON.stringify([installationID || '', ...keys.map(key => String(match[key]))]);
}
function preserveArchiveMedia(payloads) {
  const published = new Map();
  for (const payload of payloads) for (const match of rows(payload.tables?.matches)) {
    const key = identity(match, payload.installation_id), url = match.highlight_url || match.highlight?.url;
    if (key && /^https?:\/\//.test(url || '') && (!match.highlight?.status || match.highlight.status === 'ready'))
      published.set(key, {url, highlight: match.highlight, uid: match.match_uid});
  }
  for (const payload of payloads) for (const match of rows(payload.tables?.matches)) {
    const media = published.get(identity(match, payload.installation_id));
    if (!media || (media.uid && match.match_uid && media.uid !== match.match_uid)) continue;
    if (!match.highlight_url && !match.highlight?.url) {
      match.highlight_url = media.url;
      if (media.highlight) match.highlight = {...media.highlight};
    }
  }
  return payloads;
}
module.exports = {preserveArchiveMedia};
