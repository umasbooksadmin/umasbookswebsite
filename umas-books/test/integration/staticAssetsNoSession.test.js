// Marketing static assets (/assets/*, /logo.png) must be served before
// the session store and attachUser, so they never cost a per-request DB
// read. Proved by making the session table unreachable: anything that
// still passes through session middleware then fails.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3416; // distinct from 3411-3415

let app;
let pool;

before(async () => {
  app = await startTestApp({ port: PORT });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
});

after(async () => {
  await pool.end();
  app.stop();
});

test("marketing assets are served without touching the session store", async () => {
  // A genuinely signed, logged-in session cookie — an invalid one is
  // ignored by express-session without ever reading the store, which
  // would make this test pass regardless of middleware order.
  const email = `static-assets-${Date.now()}@example.test`;
  await pool.query(
    "INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, $2, 'Static', now())",
    [email, await bcrypt.hash("Irrelevant1!", 12)]
  );
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const loginRes = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent("Irrelevant1!")}&_csrf=${token}`,
  });
  jar.capture(loginRes);
  assert.equal(loginRes.status, 302);

  await pool.query("ALTER TABLE session RENAME TO session_hidden");
  try {
    const headers = { cookie: jar.header() };
    const css = await fetch(`${app.base}/assets/about.css`, { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(css.status, 200);
    const logo = await fetch(`${app.base}/logo.png`, { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(logo.status, 200);
  } finally {
    await pool.query("ALTER TABLE session_hidden RENAME TO session");
  }
});
