// Boots the real app (as a child process, exactly like `npm start` would)
// against a throwaway Postgres database, migrated from scratch — not a
// mock of the app, the actual thing, hit over real HTTP. CI supplies that
// database via DATABASE_URL (a Postgres service container, see
// .github/workflows/ci.yml); running locally, this creates and drops its
// own temporary database so it never touches a developer's dev/seed data.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken, clickConfirmationLink, withSeeOtherPage } = require("../helpers/httpClient");

const PORT = 3411; // distinct per test file — see test/helpers/testApp.js
let app;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
});

after(() => {
  app.stop();
});

test("GET / responds 200", async () => {
  const res = await fetch(`${app.base}/`);
  assert.equal(res.status, 200);
});

test("GET /healthz reports ok", async () => {
  const res = await fetch(`${app.base}/healthz`);
  assert.equal(res.status, 200);
});

test("a POST with no CSRF token is rejected", async () => {
  const res = await fetch(`${app.base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "email=nobody@example.test&password=wrong",
  });
  assert.equal(res.status, 403);
});

test("a POST with a valid CSRF token reaches the real handler", async () => {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `email=nobody@example.test&password=wrong&_csrf=${token}`,
  });
  // Wrong credentials against a real (nonexistent) account: reaches the
  // auth logic, which answers 303 back to the login page (the error shows
  // there, once), not a CSRF-layer 403.
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/login");
  jar.capture(res);
  const page = await withSeeOtherPage(res, { base: app.base, jar });
  assert.match(await page.text(), /Incorrect email or password\./);
});

test("a duplicate form field does not crash the request (regression)", async () => {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `email=a@example.test&email=b@example.test&password=wrong&_csrf=${token}`,
  });
  assert.equal(res.status, 303); // the normal refusal (back to /login), not 500
  assert.equal(res.headers.get("location"), "/login");
});

test("a protocol-relative backTo does not produce an off-site redirect (regression)", async () => {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/cart/add`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `copyId=1&backTo=${encodeURIComponent("//evil.example/phish")}&_csrf=${token}`,
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/cart");
});

test("signup, confirm the email, choose a password, then login works end to end", async () => {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const email = `integration-${Date.now()}@example.test`;
  const signupRes = await fetch(`${app.base}/signup`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent("Correct-Horse-1")}&displayName=Integration+Test&_csrf=${token}`,
  });
  jar.capture(signupRes);
  // Signup no longer logs in (identical response for new and existing
  // emails — see authHardening.test.js).
  assert.equal(signupRes.status, 303);
  assert.equal(signupRes.headers.get("location"), "/signup");

  const loginAttempt = async (password) => {
    const t = await fetchCsrfToken(app.base, jar);
    return fetch(`${app.base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
      body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}&_csrf=${t}`,
    });
  };
  // Signup stores no password: nothing logs in until the person confirms
  // and chooses one (account pre-hijack defence, see accountPreHijack.test.js).
  assert.equal((await loginAttempt("Correct-Horse-1")).status, 303, "refused: back to the login page");

  // The real raw token is only in the (unsent) mail; plant a known one.
  const crypto = require("node:crypto");
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  const { pool } = require("../../src/db");
  try {
    const raw = `app-flow-${Date.now()}`;
    const { rows } = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    await pool.query("INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [rows[0].id, crypto.createHash("sha256").update(raw).digest("hex")]);
    const verify = await clickConfirmationLink(app.base, `/verify-email/${raw}`, { jar });
    const resetPath = verify.headers.get("location");
    assert.match(resetPath, /^\/reset-password\/[0-9a-f]+\?confirmed=1$/);
    // The signup password no longer works; the person chooses a new one.
    assert.equal((await loginAttempt("Correct-Horse-1")).status, 303, "refused: back to the login page");
    const t = await fetchCsrfToken(app.base, jar);
    const set = await fetch(`${app.base}${resetPath}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
      body: `newPassword=${encodeURIComponent("Chosen-Anew-2@")}&_csrf=${t}`,
    });
    assert.equal(set.status, 302);
    assert.equal((await loginAttempt("Chosen-Anew-2@")).status, 302);
  } finally {
    await pool.end();
  }
});
