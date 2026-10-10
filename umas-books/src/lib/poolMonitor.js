// Pool saturation log line. "waiting" are callers queued for a connection
// because all of them are busy. A momentary queue is normal; a queue that
// lasts more than `waitMs` means the pool is too small for the load (or
// something holds connections too long), and callers are about to hit
// connectionTimeoutMillis. Logged at most once per `everyMs` with the counts.
// check(nowMs) is the whole logic (tests call it with a fake clock); start()
// runs it every second on an unref'd timer.
function createPoolMonitor(pool, { waitMs = 2000, everyMs = 60000, log = console.warn } = {}) {
  let waitingSince = null;
  let lastLogAt = -Infinity;
  function check(nowMs = Date.now()) {
    if (!(pool.waitingCount > 0)) {
      waitingSince = null;
      return false;
    }
    if (waitingSince === null) waitingSince = nowMs;
    if (nowMs - waitingSince < waitMs || nowMs - lastLogAt < everyMs) return false;
    lastLogAt = nowMs;
    log(
      `DB pool saturated: waiting=${pool.waitingCount} total=${pool.totalCount} idle=${pool.idleCount} ` +
      `max=${pool.options && pool.options.max} (callers have waited ${Math.round((nowMs - waitingSince) / 1000)}s for a connection; ` +
      `see docs/runbook.md, "Database connections")`
    );
    return true;
  }
  let timer = null;
  return {
    check,
    start() {
      if (!timer) { timer = setInterval(() => check(), 1000); timer.unref(); }
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}

module.exports = { createPoolMonitor };
