'use strict';
const { createHash, timingSafeEqual } = require('node:crypto');

function install(app, notify, { configuredHash = () => process.env.SCORER_NOTIFICATION_TOKEN_SHA256 || '' } = {}) {
  app.post('/api/scorer/committed', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const expected = configuredHash();
    if (!/^[a-f0-9]{64}$/.test(expected)) return res.status(503).json({ ok: false, error: 'Scorer notification is not configured' });
    const token = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(String(req.headers.authorization || ''))?.[1] || '';
    const actual = createHash('sha256').update(token).digest();
    if (!token || !timingSafeEqual(actual, Buffer.from(expected, 'hex'))) return res.status(401).json({ ok: false });
    const matchId = String(req.body?.matchId || '');
    const version = String(req.body?.version || '');
    if (!/^[1-9][0-9]{0,19}$/.test(matchId) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(version)) {
      return res.status(400).json({ ok: false, error: 'Invalid match or version' });
    }
    // No score or version from the scorer is trusted. The broadcast reads the
    // current committed database state, so retries and out-of-order calls are safe.
    notify();
    res.status(202).json({ ok: true });
  });
}
module.exports = { install };
