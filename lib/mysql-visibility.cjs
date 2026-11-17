'use strict';
const { database } = require('./mysql-pin.cjs');

function decode(rows) {
  // A missing migration must fail closed, never publish every match.
  if (rows.length !== 1) throw Error('MySQL visibility migration is missing or ambiguous');
  const body = typeof rows[0].body === 'string' ? JSON.parse(rows[0].body) : rows[0].body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('Invalid visibility');
  return body;
}
function createStore(pool = database) {
  return {
    async read() {
      const [rows] = await pool().execute('SELECT body FROM app_json_roots WHERE root=?', ['app_visibility']);
      return decode(rows);
    },
    async change(scope, id, show) {
      const { validChange } = require('./admin-visibility.cjs');
      if (!validChange({ scope, id, show })) throw Error('Invalid visibility change');
      const conn = await pool().getConnection();
      try {
        await conn.beginTransaction();
        const [rows] = await conn.execute('SELECT namespace,body FROM app_json_roots WHERE root=? FOR UPDATE', ['app_visibility']);
        const body = decode(rows);
        const values = body[scope];
        body[scope] = { ...(values && typeof values === 'object' ? values : {}), [id]: { show } };
        await conn.execute('UPDATE app_json_roots SET body=? WHERE namespace=? AND root=?', [JSON.stringify(body), rows[0].namespace, 'app_visibility']);
        await conn.commit();
      } catch (error) { await conn.rollback(); throw error; }
      finally { conn.release(); }
    }
  };
}
const store = createStore();
module.exports = { ...store, createStore, decode };
