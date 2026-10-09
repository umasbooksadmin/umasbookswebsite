// Safety net for guest session rows (see lib/sessionLifetime.js).
//
// connect-pg-simple already deletes EXPIRED rows every 15 minutes
// (pruneSessionInterval in src/index.js). Guest sessions now expire after 2 h
// (24 h with a cart), so that alone clears them. This job additionally removes
// guest rows that would outlive 24 h from now: the 30-day guest rows written
// before the short lifetimes existed (including any flood of them), or a row
// whose expiry was set wrongly. A logged-in session (sess.user set) is never
// touched. It filters on the indexed `expire` column first and deletes in
// batches, so it stays cheap even with a big backlog.
const BATCH = 5000;
const MAX_BATCHES = 40;

async function pruneStaleGuestSessions(pool, { batch = BATCH, maxBatches = MAX_BATCHES } = {}) {
  let removed = 0;
  for (let i = 0; i < maxBatches; i++) {
    const r = await pool.query(
      `DELETE FROM session
       WHERE sid IN (
         SELECT sid FROM session
         WHERE expire > now() + interval '24 hours'
           AND (sess->>'user') IS NULL
         LIMIT $1
       )`,
      [batch]
    );
    removed += r.rowCount;
    if (r.rowCount < batch) break;
  }
  return removed;
}

module.exports = { pruneStaleGuestSessions };
