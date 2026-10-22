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

// Like cachedFor, but one cached value per key (a small set of query parameters). At most `maxKeys` values are
// kept (the oldest is dropped first), so a caller varying the key on purpose cannot grow memory without bound.
// compute(key) receives the key. ttlMs <= 0 turns the cache off. `clock` is a parameter for tests.
function cachedByKey(compute, ttlMs, maxKeys = 200, clock = Date.now) {
  const entries = new Map(); // key -> { value, at, inFlight }
  function get(key) {
    const ttl = typeof ttlMs === "function" ? ttlMs() : ttlMs;
    if (!(ttl > 0)) return compute(key);
    const hit = entries.get(key);
    if (hit && hit.at != null && clock() - hit.at < ttl) return Promise.resolve(hit.value);
    if (hit && hit.inFlight) return hit.inFlight;
    const entry = hit || { value: undefined, at: null, inFlight: null };
    entry.inFlight = Promise.resolve()
      .then(() => compute(key))
      .then((v) => { entry.value = v; entry.at = clock(); return v; })
      .finally(() => { entry.inFlight = null; if (entry.at == null) entries.delete(key); });
    if (!hit) {
      if (entries.size >= maxKeys) entries.delete(entries.keys().next().value);
      entries.set(key, entry);
    }
    return entry.inFlight;
  }
  get.clear = () => entries.clear();
  return get;
}

module.exports = { runLimited, cachedFor, cachedByKey };
