// Shared "boot the real app against a throwaway database" helper for
// integration tests that need a real running server (test/integration/).
// Each test FILE still gets its own instance — node's test runner runs
// each *.test.js file in its own process by default, and can run several
// of them concurrently — this just avoids duplicating the same
// create-db/migrate/spawn/wait/teardown block in every one of them.

const { spawn, execFileSync } = require("node:child_process");
const path = require("node:path");
const { Client } = require("pg");
const { withDatabaseName } = require("./testDatabase");

const ROOT = path.join(__dirname, "..", "..");

async function waitForHealthy(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
      lastError = new Error(`/healthz returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server never became healthy: ${lastError && lastError.message}`);
}

// port: pick a fixed value distinct across test files so two files
// running concurrently never collide on the same port.
//
// isolated: when DATABASE_URL points at one shared database (CI), every
// test file normally runs against it concurrently. A test that does
// something global to the database — e.g. renaming the `session` table,
// which logs out every other file's sessions mid-run — must pass
// isolated: true to get its own throwaway database on that same server
// (locally every file already gets one, so this is a no-op there).
// env: extra environment for the server process (e.g. ADMIN_2FA_REQUIRED=true
// to exercise the real admin two-step enforcement).
async function startTestApp({ port, isolated = false, env = {} }) {
  const sharedUrl = process.env.DATABASE_URL;
  const ownsDatabase = !sharedUrl;
  const testDb = `umasbooks_test_${port}_${Date.now()}`;
  const makeIsolatedCopy = isolated && !!sharedUrl;
  const databaseUrl = makeIsolatedCopy
    ? withDatabaseName(sharedUrl, testDb)
    : sharedUrl || `postgres://localhost:5432/${testDb}`;
  const base = `http://127.0.0.1:${port}`;

  if (ownsDatabase) {
    execFileSync("createdb", [testDb], { stdio: "inherit" });
  }
  if (makeIsolatedCopy) {
    const admin = new Client({ connectionString: sharedUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${testDb}"`);
    await admin.end();
  }
  execFileSync("node", ["src/migrate.js"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl, PGSSLMODE: "disable" },
    stdio: "inherit",
  });

  const serverProcess = spawn("node", ["src/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PGSSLMODE: "disable",
      PORT: String(port),
      SESSION_SECRET: "test-session-secret-not-for-production",
      NODE_ENV: "test",
      // Most tests log in as admins without a second factor; the 2FA test
      // file turns enforcement back on via `env`.
      ADMIN_2FA_REQUIRED: "false",
      // The awards lookups (lib/awards) must never reach the network from a test.
      AWARDS_LOOKUPS: "off",
      // The cover backfill (lib/coverStore) must never reach Open Library from a test.
      COVER_BACKFILL: "off",
      // The shop-wide hourly mail ceiling (lib/outbox.js) counts the whole shared
      // database; a full test run must never trip it. Its own tests lower it.
      MAIL_GLOBAL_PER_HOUR: "100000",
      ...env,
    },
    // stdout is piped (and echoed) so a test can wait for the server's own
    // boot-time background jobs to report in — see waitForLog() below.
    stdio: ["inherit", "pipe", "inherit"],
  });
  let output = "";
  const logWaiters = new Set();
  serverProcess.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    output += chunk;
    for (const w of [...logWaiters]) if (w.pattern.test(output)) { logWaiters.delete(w); w.resolve(); }
  });
  // Resolves once the server has printed a line matching `pattern` (already
  // printed counts). src/index.js starts several maintenance jobs at boot
  // (retention purge, image cleanup, cart sweep) without waiting for them, so
  // the first seconds of a fresh server race with a test that inserts old
  // rows those jobs are allowed to delete. A test that does that waits here
  // for the job's own log line instead of guessing with a sleep.
  function waitForLog(pattern, { timeoutMs = 20000 } = {}) {
    if (pattern.test(output)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const w = { pattern, resolve };
      logWaiters.add(w);
      setTimeout(() => {
        if (logWaiters.delete(w)) reject(new Error(`server never logged ${pattern}`));
      }, timeoutMs).unref();
    });
  }

  await waitForHealthy(base, 20000);

  return {
    base,
    databaseUrl,
    waitForLog,
    async stop() {
      // Wait for the server to finish its graceful shutdown BEFORE dropping
      // its database: dropping first (WITH FORCE) kills the connections of a
      // server that is still shutting down, which then logs/raises errors.
      const exited = new Promise((resolve) => {
        if (serverProcess.exitCode !== null || serverProcess.signalCode !== null) return resolve();
        serverProcess.once("exit", resolve);
      });
      serverProcess.kill();
      let escalate;
      await Promise.race([exited, new Promise((resolve) => { escalate = setTimeout(() => { serverProcess.kill("SIGKILL"); resolve(); }, 15000); })]);
      clearTimeout(escalate);
      if (ownsDatabase) {
        execFileSync("dropdb", ["--if-exists", testDb], { stdio: "inherit" });
      }
      if (makeIsolatedCopy) {
        const admin = new Client({ connectionString: sharedUrl });
        await admin.connect();
        await admin.query(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
        await admin.end();
      }
    },
  };
}

// OPTIONAL in-process alternative to startTestApp(): builds the real app with createApp()
// (src/app.js) inside the test's own process and listens on an OS-assigned port (0), so
// there is no fixed PORT to collide on and the test can stub modules or read module state.
// No background jobs run (they are started by src/index.js, not by createApp). Differences
// from startTestApp: one app per test file (src/db.js is a per-process singleton, so the
// database is this file's), and the server runs in the test's process.
// Same env defaults as the child process; `env` overrides them (set before src/db loads).
async function startInProcessApp({ isolated = false, env = {} } = {}) {
  const { prepareDatabase } = require("./testDatabase");
  const db = prepareDatabase(`inproc_${process.pid}`, { isolated });
  Object.assign(process.env, {
    SESSION_SECRET: "test-session-secret-not-for-production",
    NODE_ENV: "test",
    ADMIN_2FA_REQUIRED: "false",
    AWARDS_LOOKUPS: "off",
    COVER_BACKFILL: "off",
    MAIL_GLOBAL_PER_HOUR: "100000",
    ...env,
  });
  db.create();
  const { createApp } = require("../../src/app");
  const { pool } = require("../../src/db");
  const server = await new Promise((resolve, reject) => {
    const s = createApp().listen(0, "127.0.0.1", (err) => (err ? reject(err) : resolve(s)));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    pool,
    databaseUrl: process.env.DATABASE_URL,
    async stop() {
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
      await pool.end();
      db.drop();
    },
  };
}

module.exports = { startTestApp, startInProcessApp };
