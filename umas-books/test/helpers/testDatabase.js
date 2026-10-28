// "Which database does this test file use?" — one place for the answer.
//
// Locally DATABASE_URL is unset and every file creates (and drops) its own
// throwaway database. In CI DATABASE_URL names ONE database that every test
// file shares, and node's runner executes several files at once against it.
// A file that counts rows, clears a table, or relies on per-IP caps therefore
// sees (or wrecks) other files' data at random. Such a file passes
// `isolated: true` to get its own throwaway database on that same server —
// the same thing startTestApp({ isolated: true }) does for child-process apps.
// Locally every file is already isolated, so the flag is a no-op there.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");
const MIGRATIONS = path.join(ROOT, "migrations");

// A temporary copy of migrations/ holding only the files numbered <= n.
function migrationsUpTo(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-upto-"));
  for (const f of fs.readdirSync(MIGRATIONS)) {
    if (f.endsWith(".sql") && Number.parseInt(f, 10) <= n) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
  }
  return dir;
}

// Same server as `url`, different database name.
function withDatabaseName(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

// Runs one administrative statement on the shared server. Synchronous (a
// child node process using the app's own `pg` dependency) so callers can
// stay synchronous and never need `psql` to be installed.
function adminStatement(sharedUrl, sql) {
  execFileSync(
    "node",
    ["-e", `const { Client } = require("pg");
      (async () => {
        const c = new Client({ connectionString: process.env.ADMIN_DB_URL });
        await c.connect();
        await c.query(process.env.ADMIN_DB_SQL);
        await c.end();
      })().catch((e) => { console.error(e); process.exit(1); });`],
    { cwd: ROOT, env: { ...process.env, ADMIN_DB_URL: sharedUrl, ADMIN_DB_SQL: sql, PGSSLMODE: process.env.PGSSLMODE || "disable" }, stdio: "inherit" }
  );
}

// Sets DATABASE_URL (and PGSSLMODE) for this process — call it BEFORE
// anything requires src/db — and returns create()/drop() for before()/after().
//
// migrateUpTo: N runs only the migrations numbered N and below (a database "as it was" before a later migration,
// for testing that migration on realistic data). The test then applies the rest itself.
function prepareDatabase(label, { isolated = false, migrateUpTo = null } = {}) {
  const sharedUrl = process.env.DATABASE_URL;
  // A partly migrated database must be its own (CI's shared one is fully migrated already).
  if (migrateUpTo != null && sharedUrl && !isolated) throw new Error("prepareDatabase: migrateUpTo needs isolated: true");
  const ownsDatabase = !sharedUrl;
  const makeIsolatedCopy = isolated && !!sharedUrl;
  const dbName = `umasbooks_${label}_test_${Date.now()}_${process.pid}`;
  process.env.DATABASE_URL = makeIsolatedCopy
    ? withDatabaseName(sharedUrl, dbName)
    : sharedUrl || `postgres://localhost:5432/${dbName}`;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  return {
    create() {
      if (ownsDatabase) execFileSync("createdb", [dbName], { stdio: "inherit" });
      if (makeIsolatedCopy) adminStatement(sharedUrl, `CREATE DATABASE "${dbName}"`);
      if (migrateUpTo == null) {
        execFileSync("node", ["src/migrate.js"], { cwd: ROOT, env: process.env, stdio: "inherit" });
      } else {
        const dir = migrationsUpTo(migrateUpTo);
        try {
          execFileSync("node", ["-e", "require('./src/migrate').runMigrations({ dir: process.env.MIGRATIONS_UP_TO_DIR }).catch((e) => { console.error(e); process.exit(1); })"],
            { cwd: ROOT, env: { ...process.env, MIGRATIONS_UP_TO_DIR: dir }, stdio: "inherit" });
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    },
    drop() {
      if (ownsDatabase) execFileSync("dropdb", ["--if-exists", dbName], { stdio: "inherit" });
      if (makeIsolatedCopy) adminStatement(sharedUrl, `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    },
  };
}

module.exports = { prepareDatabase, withDatabaseName };
