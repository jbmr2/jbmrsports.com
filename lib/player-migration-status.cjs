'use strict';
// This diagnostic never returns phone numbers or identities, and does not write.
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
function inspect(firebase, rows) {
  const status = {};
  for (const root of ['player_directory', 'player_download_links']) {
    const found = rows.filter(row => row.root === root);
    let target;
    try { target = found.length === 1 ? (typeof found[0].body === 'string' ? JSON.parse(found[0].body) : found[0].body) : undefined; }
    catch { target = undefined; }
    const original = firebase[root] ?? {};
    status[root] = { sourceCount: Object.keys(original).length, mysqlRootCount: found.length,
      matches: target === undefined ? false : JSON.stringify(stable(original)) === JSON.stringify(stable(target)) };
  }
  return status;
}
async function read() {
  const db = require('firebase-admin/database').getDatabaseWithUrl('https://jbmrsports-cricket-live-default-rtdb.asia-southeast1.firebasedatabase.app');
  const [directory, links, [rows]] = await Promise.all([
    db.ref('player_directory').get(), db.ref('player_download_links').get(),
    require('./mysql-pin.cjs').database().execute('SELECT root, body FROM app_json_roots WHERE root IN (?, ?)', ['player_directory', 'player_download_links'])
  ]);
  return inspect({player_directory: directory.val(), player_download_links: links.val()}, rows);
}
module.exports = { inspect, read };
