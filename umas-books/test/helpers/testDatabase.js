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

const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..", "..");

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
function prepareDatabase(label, { isolated = false } = {}) {
  const sharedUrl = process.env.DATABASE_URL;
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
      execFileSync("node", ["src/migrate.js"], { cwd: ROOT, env: process.env, stdio: "inherit" });
    },
    drop() {
      if (ownsDatabase) execFileSync("dropdb", ["--if-exists", dbName], { stdio: "inherit" });
      if (makeIsolatedCopy) adminStatement(sharedUrl, `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    },
  };
}

module.exports = { prepareDatabase, withDatabaseName };
