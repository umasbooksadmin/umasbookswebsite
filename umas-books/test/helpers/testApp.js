// Shared "boot the real app against a throwaway database" helper for
// integration tests that need a real running server (test/integration/).
// Each test FILE still gets its own instance — node's test runner runs
// each *.test.js file in its own process by default, and can run several
// of them concurrently — this just avoids duplicating the same
// create-db/migrate/spawn/wait/teardown block in every one of them.

const { spawn, execFileSync } = require("node:child_process");
const path = require("node:path");

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
async function startTestApp({ port }) {
  const ownsDatabase = !process.env.DATABASE_URL;
  const testDb = `umasbooks_test_${port}_${Date.now()}`;
  const databaseUrl = process.env.DATABASE_URL || `postgres://localhost:5432/${testDb}`;
  const base = `http://127.0.0.1:${port}`;

  if (ownsDatabase) {
    execFileSync("createdb", [testDb], { stdio: "inherit" });
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
    },
    stdio: "inherit",
  });

  await waitForHealthy(base, 20000);

  return {
    base,
    databaseUrl,
    stop() {
      serverProcess.kill();
      if (ownsDatabase) {
        execFileSync("dropdb", ["--if-exists", testDb], { stdio: "inherit" });
      }
    },
  };
}

module.exports = { startTestApp };
