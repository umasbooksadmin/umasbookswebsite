// Boots the real app (as a child process, exactly like `npm start` would)
// against a throwaway Postgres database, migrated from scratch — not a
// mock of the app, the actual thing, hit over real HTTP. CI supplies that
// database via DATABASE_URL (a Postgres service container, see
// .github/workflows/ci.yml); running locally, this creates and drops its
// own temporary database so it never touches a developer's dev/seed data.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const PORT = 3411; // distinct from the dev server's default (3000) and this repo's usual dev port (3099)
const BASE = `http://127.0.0.1:${PORT}`;

const OWNS_DATABASE = !process.env.DATABASE_URL;
const TEST_DB = `umasbooks_test_${Date.now()}`;
const DATABASE_URL = process.env.DATABASE_URL || `postgres://localhost:5432/${TEST_DB}`;

let serverProcess;

async function waitForHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
      lastError = new Error(`/healthz returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server never became healthy: ${lastError && lastError.message}`);
}

function fetchCsrfToken(cookieJar) {
  return fetch(`${BASE}/api/csrf-token`, { headers: { cookie: cookieJar.header() } }).then(async (res) => {
    cookieJar.capture(res);
    const body = await res.json();
    return body.token;
  });
}

// A tiny cookie jar — good enough for one session across several fetch()
// calls, which is all these tests need (no external dependency for it).
function makeCookieJar() {
  const cookies = new Map();
  return {
    capture(res) {
      for (const raw of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
        const [pair] = raw.split(";");
        const eq = pair.indexOf("=");
        cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    },
    header() {
      return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}

before(async () => {
  if (OWNS_DATABASE) {
    execFileSync("createdb", [TEST_DB], { stdio: "inherit" });
  }

  execFileSync("node", ["src/migrate.js"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL, PGSSLMODE: "disable" },
    stdio: "inherit",
  });

  serverProcess = spawn("node", ["src/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL,
      PGSSLMODE: "disable",
      PORT: String(PORT),
      SESSION_SECRET: "test-session-secret-not-for-production",
      NODE_ENV: "test",
    },
    stdio: "inherit",
  });

  await waitForHealthy(20000);
});

after(() => {
  if (serverProcess) serverProcess.kill();
  if (OWNS_DATABASE) {
    execFileSync("dropdb", ["--if-exists", TEST_DB], { stdio: "inherit" });
  }
});

test("GET / responds 200", async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
});

test("GET /healthz reports ok", async () => {
  const res = await fetch(`${BASE}/healthz`);
  assert.equal(res.status, 200);
});

test("a POST with no CSRF token is rejected", async () => {
  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "email=nobody@example.test&password=wrong",
  });
  assert.equal(res.status, 403);
});

test("a POST with a valid CSRF token reaches the real handler", async () => {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(jar);
  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `email=nobody@example.test&password=wrong&_csrf=${token}`,
  });
  // Wrong credentials against a real (nonexistent) account: reaches the
  // auth logic and gets a real 401, not a CSRF-layer rejection.
  assert.equal(res.status, 401);
});

test("a duplicate form field does not crash the request (regression)", async () => {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(jar);
  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `email=a@example.test&email=b@example.test&password=wrong&_csrf=${token}`,
  });
  assert.equal(res.status, 401); // not 500
});

test("a protocol-relative backTo does not produce an off-site redirect (regression)", async () => {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(jar);
  const res = await fetch(`${BASE}/cart/add`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `copyId=1&backTo=${encodeURIComponent("//evil.example/phish")}&_csrf=${token}`,
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/cart");
});

test("signup then login works end to end", async () => {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(jar);
  const email = `integration-${Date.now()}@example.test`;
  const signupRes = await fetch(`${BASE}/signup`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent("Correct-Horse-1")}&displayName=Integration+Test&_csrf=${token}`,
  });
  jar.capture(signupRes);
  assert.equal(signupRes.status, 302);

  const token2 = await fetchCsrfToken(jar);
  const loginRes = await fetch(`${BASE}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent("Correct-Horse-1")}&_csrf=${token2}`,
  });
  assert.equal(loginRes.status, 302);
});
