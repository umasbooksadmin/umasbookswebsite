// The /healthz handler, split out of index.js so a test can mount it with a
// stub pool. See the comment at its registration in index.js for why it
// touches the database at all.

const HEALTH_TIMEOUT_MS = 3000;
// The answer (good or bad) is reused for this long: /healthz is public, so a
// loop hitting it must not turn into a loop of database queries. The uptime
// check and Render's probe poll far less often than this.
const HEALTH_CACHE_MS = 3000;

function healthzHandler(pool, timeoutMs = HEALTH_TIMEOUT_MS, { cacheMs = HEALTH_CACHE_MS, now = Date.now } = {}) {
  let last = null; // { ok, at }
  let inflight = null; // concurrent callers share one SELECT 1
  const answer = (res, ok) => res.status(ok ? 200 : 503).set("Cache-Control", "no-store").json({ ok });
  return async (req, res) => {
    if (last && now() - last.at < cacheMs) return answer(res, last.ok);
    if (inflight) return answer(res, await inflight);
    inflight = check().finally(() => { inflight = null; });
    return answer(res, await inflight);
  };

  async function check() {
    let timer;
    let ok = false;
    try {
      // With the database unreachable pool.query can wait on a connection
      // for seconds; a health check has to answer 503 promptly instead of
      // hanging until Render's/the uptime check's own (longer) timeout.
      await Promise.race([
        pool.query("SELECT 1"),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      ok = true;
    } catch (err) {
      // This route is public and unauthenticated (the uptime-check workflow
      // and Render's own health probe both hit it with no login) — logging
      // the real error server-side, rather than handing a raw database
      // error message (connection details, driver internals, ...) to
      // whoever's asking, same reasoning as never surfacing a raw err in
      // any other response.
      console.error("Health check failed:", err.message);
    } finally {
      clearTimeout(timer);
    }
    last = { ok, at: now() };
    return ok;
  }
}

module.exports = { healthzHandler, HEALTH_TIMEOUT_MS, HEALTH_CACHE_MS };
