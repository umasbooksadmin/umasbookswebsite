require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { pool } = require("./db");

// Applies each migrations/*.sql file exactly once, in filename order, and
// records it in schema_migrations. Render runs this on every boot and
// wake (see render.yaml), so before this table existed every file had to
// be safe to re-run — and two weren't: 014 reset cleared session
// capacities to 5, and 032 marked any still-unverified account as
// verified, on every deploy. Tracking removes that whole class of bug:
// a migration can now freely contain one-time data fixes.
//
// First run against a database that predates the tracking table: every
// file in the directory has already been applied by the old
// run-everything boot, so they're recorded without being re-run.
const LOCK_KEY = 7243901; // arbitrary constant; stops two booting instances racing

async function main() {
  const dir = path.join(__dirname, "..", "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool.connect();
  try {
    // The pool's statement_timeout (db.js) is for web requests; here it would
    // abort the wait on the advisory lock while another instance migrates,
    // and cap legitimately long migrations.
    await client.query("SET statement_timeout = 0");
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);

    const { rows: existing } = await client.query("SELECT to_regclass('public.schema_migrations') AS t, to_regclass('public.users') AS u");
    const trackingExisted = existing[0].t !== null;
    const legacyDatabase = !trackingExisted && existing[0].u !== null;
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
    );
    if (legacyDatabase) {
      for (const file of files) {
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING", [file]);
      }
      console.log(`Baselined ${files.length} existing migrations (database predates schema_migrations).`);
    }

    const { rows: applied } = await client.query("SELECT filename FROM schema_migrations");
    const done = new Set(applied.map((r) => r.filename));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      console.log("Running migration:", file);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    console.log("Migrations complete.");
  } finally {
    try { await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]); } catch (_) { /* connection may be gone */ }
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
