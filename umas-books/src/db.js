const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

// Render's managed Postgres (see render.yaml) signs its certificates with a
// CA that isn't in Node's default trust store, so verifying against that
// store outright would reject every connection in production. PGSSLROOTCERT
// — the PEM contents of the database's CA certificate, copied from its
// Render dashboard page under Connections > CA Certificate — lets us verify
// the real cert instead of skipping verification. Without it we fall back
// to encrypting the connection without checking who's on the other end,
// same as before.
function sslConfig() {
  if (process.env.PGSSLMODE === "disable") return false;
  if (process.env.PGSSLROOTCERT) {
    return { ca: process.env.PGSSLROOTCERT, rejectUnauthorized: true };
  }
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig(),
});

module.exports = { pool };
