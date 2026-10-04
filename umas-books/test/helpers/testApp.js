// Shared "boot the real app against a throwaway database" helper for
// integration tests that need a real running server (test/integration/).
// Each test FILE still gets its own instance — node's test runner runs
// each *.test.js file in its own process by default, and can run several
// of them concurrently — this just avoids duplicating the same
// create-db/migrate/spawn/wait/teardown block in every one of them.

const { spawn, execFileSync } = require("node:child_process");
const path = require("node:path");
const { Client } = require("pg");

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

// Same server as DATABASE_URL, different database name.
function withDatabaseName(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
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
      ...env,
    },
    stdio: "inherit",
  });

  await waitForHealthy(base, 20000);

  return {
    base,
    databaseUrl,
    async stop() {
      serverProcess.kill();
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

module.exports = { startTestApp };
