'use strict';
const { allowedSession, allowedRequest } = require('./simulator-preview.cjs');

function middleware(getAuth) {
  const requests = new Map();
  return async (req, res, next) => {
    const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!bearer) return next();
    try {
      const decoded = await getAuth().verifyIdToken(bearer[1]);
      req.verifiedUser = decoded;
      if (decoded.simulator_preview === true) {
        if (!allowedSession(decoded)) return res.status(401).json({ error: 'Simulator session expired.' });
        if (!allowedRequest(req)) return res.status(403).json({ error: 'Simulator session is read-only.' });
        const minute = Math.floor(Date.now() / 60000);
        const previous = requests.get(decoded.uid);
        const count = previous?.minute === minute ? previous.count + 1 : 1;
        requests.set(decoded.uid, { minute, count });
        if (count > 600) return res.status(429).json({ error: 'Please wait before retrying.' });
        req.simulatorPreview = true;
      }
      next();
    } catch { res.status(401).json({ error: 'Please sign in again.' }); }
  };
}
module.exports = { middleware };
