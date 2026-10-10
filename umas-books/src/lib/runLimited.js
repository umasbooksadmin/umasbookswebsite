// Runs async tasks with at most `limit` in flight at once, resolving their
// results in the SAME ORDER as `tasks` (like Promise.all). The first rejection
// rejects the whole call and no further task is started (tasks already running
// cannot be cancelled and finish on their own).
//
// Used where a request fans out into several database queries: Promise.all
// over six queries takes six pool connections at once, so a few parallel
// requests drain the pool and the next one times out waiting for a connection.
async function runLimited(tasks, limit = 3) {
  const list = Array.from(tasks);
  const max = Math.max(1, Math.floor(Number(limit)) || 1);
  const results = new Array(list.length);
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < list.length) {
      const i = next++;
      try {
        results[i] = await list[i]();
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(max, list.length) }, worker));
  return results;
}

// A value computed at most once per `ttlMs` per process, and once at a time:
// callers that arrive while it is being computed share that computation.
// ttlMs <= 0 turns the cache off (every call computes; nothing is shared).
// A failure is never cached. `clock` is a parameter for tests.
function cachedFor(compute, ttlMs, clock = Date.now) {
  let value;
  let at = -Infinity;
  let inFlight = null;
  return function get() {
    const ttl = typeof ttlMs === "function" ? ttlMs() : ttlMs;
    if (!(ttl > 0)) return compute();
    if (clock() - at < ttl) return Promise.resolve(value);
    if (!inFlight) {
      inFlight = Promise.resolve()
        .then(compute)
        .then((v) => { value = v; at = clock(); return v; })
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  };
}

module.exports = { runLimited, cachedFor };
