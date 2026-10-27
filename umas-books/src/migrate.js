require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
// Test system (APP_ENV=staging) only: never migrate the production database from staging.
require("./lib/staging").enforceStagingBoot();
const { pool } = require("./db");
const config = require("./lib/config");

// Applies each migrations/*.sql file exactly once, in filename order, and
// records it in schema_migrations. Render runs this in the pre-deploy
// command, before each new version takes traffic (see render.yaml), so
// before this table existed every file had to
// be safe to re-run — and two weren't: 014 reset cleared session
// capacities to 5, and 032 marked any still-unverified account as
// verified, on every deploy. Tracking removes that whole class of bug:
// a migration can now freely contain one-time data fixes.
//
// First run against a database that predates the tracking table: every
// file in the directory has already been applied by the old
// run-everything boot, so they're recorded without being re-run.
const LOCK_KEY = 7243901; // arbitrary constant; stops two booting instances racing
const LOCK_NOT_AVAILABLE = "55P03"; // Postgres: lock_timeout expired

// Table locks: an ALTER/DROP takes ACCESS EXCLUSIVE and, if it queues behind a long read,
// blocks EVERY query on that table (including the ones the OLD version, still serving during
// pre-deploy, sends). So each migration file runs with lock_timeout (MIGRATE_LOCK_TIMEOUT_MS,
// default 5 s): the wait is cut short, the transaction rolls back (the runner is transactional
// per file, so a retry is safe) and the file is tried again up to MIGRATE_LOCK_RETRIES times
// (default 5) with growing pauses. Still locked: the deploy fails with a clear message and the
// old version keeps serving. statement_timeout stays 0 for the work itself.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function applyFile(client, file, sql, opts) {
  const { lockTimeoutMs, retries, backoffMs, log } = opts;
  for (let attempt = 0; ; attempt++) {
    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL lock_timeout = ${Math.trunc(lockTimeoutMs)}`);
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      return attempt;
    } catch (err) {
      await client.query("ROLLBACK");
      if (err && err.code === LOCK_NOT_AVAILABLE) {
        if (attempt >= retries) {
          const e = new Error(
            `Migration ${file} could not get a table lock after ${retries + 1} tries of ${lockTimeoutMs} ms: something is holding a lock on the table it changes ` +
            "(a long query or an open transaction). The deploy is stopped and the current version keeps serving. Wait for it to finish, then deploy again. See docs/runbook.md, " +
            `"When a deploy fails because a migration could not get a lock". Original error: ${err.message}`
          );
          e.code = LOCK_NOT_AVAILABLE;
          throw e;
        }
        const pause = Math.min(backoffMs * 2 ** attempt, 30000);
        log(`Migration ${file}: table lock not available (try ${attempt + 1} of ${retries + 1}); retrying in ${pause} ms.`);
        await sleep(pause);
        continue;
      }
      throw err;
    }
  }
}

async function runMigrations(options = {}) {
  const dir = options.dir || path.join(__dirname, "..", "migrations");
  const opts = {
    lockTimeoutMs: options.lockTimeoutMs ?? config.get("MIGRATE_LOCK_TIMEOUT_MS"),
    retries: options.retries ?? config.get("MIGRATE_LOCK_RETRIES"),
    backoffMs: options.backoffMs ?? 1000,
    log: options.log || console.log,
  };
  const log = opts.log;
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
      log(`Baselined ${files.length} existing migrations (database predates schema_migrations).`);
    }

    const { rows: applied } = await client.query("SELECT filename FROM schema_migrations");
    const done = new Set(applied.map((r) => r.filename));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      log(`Running migration: ${file}`);
      await applyFile(client, file, sql, opts);
    }
    log("Migrations complete.");
  } finally {
    try { await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]); } catch { /* connection may be gone */ }
    client.release();
    if (options.endPool !== false) await pool.end();
  }
}

module.exports = { runMigrations };

if (require.main === module) {
  runMigrations().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
