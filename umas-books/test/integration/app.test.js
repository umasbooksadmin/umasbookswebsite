// Boots the real app (as a child process, exactly like `npm start` would)
// against a throwaway Postgres database, migrated from scratch — not a
// mock of the app, the actual thing, hit over real HTTP. CI supplies that
// database via DATABASE_URL (a Postgres service container, see
// .github/workflows/ci.yml); running locally, this creates and drops its
// own temporary database so it never touches a developer's dev/seed data.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3411; // distinct per test file — see test/helpers/testApp.js
let app;

before(async () => {
  app = await startTestApp({ port: PORT });
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
  // auth logic and gets a real 401, not a CSRF-layer rejection.
  assert.equal(res.status, 401);
});

test("a duplicate form field does not crash the request (regression)", async () => {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `email=a@example.test&email=b@example.test&password=wrong&_csrf=${token}`,
  });
  assert.equal(res.status, 401); // not 500
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

test("signup then login works end to end", async () => {
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
  // emails — see authHardening.test.js); the new user logs in afterwards.
  assert.equal(signupRes.status, 200);

  const token2 = await fetchCsrfToken(app.base, jar);
  const loginRes = await fetch(`${app.base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent("Correct-Horse-1")}&_csrf=${token2}`,
  });
  assert.equal(loginRes.status, 302);
});
