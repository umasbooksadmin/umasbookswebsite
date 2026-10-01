const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

// DATABASE_URL is Render's Internal Database URL (render.yaml's
// fromDatabase: connectionString resolves to the private-network URL, not
// the external one), and Render's internal Postgres connections use a
// self-signed certificate per database instance — Render's own docs say
// these explicitly don't support sslmode=verify-ca/verify-full, since
// there's no stable CA to verify against. rejectUnauthorized: false is
// this app's equivalent of Render's own recommended sslmode=require for
// internal connections: the connection is still encrypted, it just can't
// also verify the server's identity. Real certificate verification would
// require switching to the external database URL instead (a publicly
// verifiable certificate, but traffic leaves Render's private network).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

// Shared transaction boilerplate — checkout (lib/cart.js) and the event/
// volunteer-shift signup routes each used to hand-roll their own
// connect/BEGIN/COMMIT/ROLLBACK/release, identical except for what ran in
// between. fn receives the checked-out client (queries inside it must use
// that client, not pool, to actually run inside the transaction) and its
// return value is passed through on commit. Any throw from fn rolls back
// and rethrows unchanged — a fn that needs to signal "stop and do X
// instead of committing" (sold out, at capacity, ...) throws a plain
// Error with a distinct .message and the caller's own try/catch decides
// what that means, the same way each of these three routes already did
// before this helper existed.
async function withTransaction(pool, fn) {
  const client = await pool.connect();
  let brokenConnection;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    // A dead connection makes ROLLBACK itself throw, which would replace
    // the original error with a useless one — keep the original, and
    // release(err) below tells the pool to discard this client rather
    // than hand a broken one to the next caller.
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      brokenConnection = rollbackErr;
    }
    throw err;
  } finally {
    client.release(brokenConnection);
  }
}

module.exports = { pool, withTransaction };
