'use strict';

// Node timers overflow above ~24.8 days; app sessions last 30 days.
function scheduleExpiry(expiresAt, close, { now = Date.now, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let timer;
  let stopped = false;
  function check() {
    if (stopped) return;
    const remaining = expiresAt - now();
    if (!Number.isFinite(remaining) || remaining <= 0) { stopped = true; close(); return; }
    timer = schedule(check, Math.min(remaining, 2_147_483_647));
    timer?.unref?.();
  }
  check();
  return () => { stopped = true; if (timer !== undefined) cancel(timer); };
}

module.exports = { scheduleExpiry };
