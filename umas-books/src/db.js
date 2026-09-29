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

module.exports = { pool };
