// The /healthz handler, split out of index.js so a test can mount it with a
// stub pool. See the comment at its registration in index.js for why it
// touches the database at all.

const HEALTH_TIMEOUT_MS = 3000;

function healthzHandler(pool, timeoutMs = HEALTH_TIMEOUT_MS) {
  return async (req, res) => {
    let timer;
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
      res.status(200).json({ ok: true });
    } catch (err) {
      // This route is public and unauthenticated (the uptime-check workflow
      // and Render's own health probe both hit it with no login) — logging
      // the real error server-side, rather than handing a raw database
      // error message (connection details, driver internals, ...) to
      // whoever's asking, same reasoning as never surfacing a raw err in
      // any other response.
      console.error("Health check failed:", err.message);
      res.status(503).json({ ok: false });
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { healthzHandler, HEALTH_TIMEOUT_MS };
