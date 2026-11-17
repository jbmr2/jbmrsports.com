'use strict';

const path = require('node:path');

function install(app, readRevision, liveHealth = () => undefined) {
  let lastRevision, latestChangeAt, lastCheckAt, reachable, pending;
  async function sample() {
    if (pending) return pending;
    if (lastCheckAt && Date.now() - lastCheckAt < 2000) return;
    pending = (async () => {
      try {
        const revision = await readRevision();
        if (lastRevision !== undefined && revision !== lastRevision) {
          latestChangeAt = Date.now();
        }
        lastRevision = revision;
        reachable = true;
      } catch {
        reachable = false;
      } finally {
        lastCheckAt = Date.now();
        pending = undefined;
      }
    })();
    return pending;
  }

  app.get('/datahealth', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'datahealth.html'));
  });
  app.get('/api/datahealth', async (_req, res) => {
    const realtime = liveHealth();
    if (!realtime?.clients) await sample();
    res.set('Cache-Control', 'no-store').json({
      reachable: realtime?.clients ? realtime.reachable : reachable,
      lastCheckAt: realtime?.clients ? realtime.lastCheckAt : lastCheckAt,
      latestChangeAt: realtime?.latestChangeAt || latestChangeAt,
      realtime
    });
  });
}

module.exports = { install };
