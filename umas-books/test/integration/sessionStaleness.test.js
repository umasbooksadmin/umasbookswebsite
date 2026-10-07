// Regression coverage for the exact scenarios reported: role/disabled
// status cached into req.session.user at login (see loginAs in
// routes/auth.js) used to never be re-checked, so a disabled or demoted
// admin kept their old access for the rest of the session's 30-day life,
// and changing a password never touched sessions already open elsewhere.
// See middleware/auth.js's attachUser for the fix.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken, withSeeOtherPage } = require("../helpers/httpClient");

const PORT = 3412; // distinct from app.test.js (3411)
const PASSWORD = "StalenessTest1!";

let app;
let pool;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  // Reuse whichever database startTestApp decided on (an externally
  // supplied one in CI, or a freshly created one locally) for direct row
  // manipulation below — required() lazily, after DATABASE_URL is known,
  // since src/db.js reads it at require time.
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
});

after(async () => {
  await pool.end();
  app.stop();
});

async function createTestUser(email, { isAdmin = false, isMember = false } = {}) {
  const hash = await bcrypt.hash(PASSWORD, 12);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, is_member)
     VALUES ($1, $2, 'Staleness Test', $3, $4) RETURNING id`,
    [email, hash, isAdmin, isMember]
  );
  return rows[0].id;
}

async function login(email) {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent(PASSWORD)}&_csrf=${token}`,
  });
  jar.capture(res);
  assert.equal(res.status, 302, "login should have succeeded");
  return jar;
}

test("a disabled account loses access on its very next request, without logging out", async () => {
  const email = `staleness-disabled-${Date.now()}@example.test`;
  await createTestUser(email, { isAdmin: true });
  const jar = await login(email);

  const before1 = await fetch(`${app.base}/admin`, { headers: { cookie: jar.header() }, redirect: "manual" });
  assert.equal(before1.status, 200);

  await pool.query("UPDATE users SET is_disabled = TRUE WHERE email = $1", [email]);

  const after1 = await fetch(`${app.base}/admin`, { headers: { cookie: jar.header() }, redirect: "manual" });
  assert.equal(after1.status, 302);
  assert.equal(after1.headers.get("location"), "/login");
});

test("a demoted admin immediately loses admin access but keeps their member access", async () => {
  const email = `staleness-demoted-${Date.now()}@example.test`;
  await createTestUser(email, { isAdmin: true, isMember: true });
  const jar = await login(email);

  const adminBefore = await fetch(`${app.base}/admin`, { headers: { cookie: jar.header() }, redirect: "manual" });
  assert.equal(adminBefore.status, 200);

  await pool.query("UPDATE users SET is_admin = FALSE WHERE email = $1", [email]);

  const adminAfter = await fetch(`${app.base}/admin`, { headers: { cookie: jar.header() }, redirect: "manual" });
  assert.equal(adminAfter.status, 403);

  const memberAreaAfter = await fetch(`${app.base}/announcements`, { headers: { cookie: jar.header() }, redirect: "manual" });
  assert.equal(memberAreaAfter.status, 200);
});

test("changing a password logs out other sessions but keeps the one that made the change", async () => {
  const email = `staleness-pwchange-${Date.now()}@example.test`;
  await createTestUser(email, { isMember: true });
  const jarA = await login(email);
  const jarB = await login(email);

  assert.equal((await fetch(`${app.base}/announcements`, { headers: { cookie: jarA.header() }, redirect: "manual" })).status, 200);
  assert.equal((await fetch(`${app.base}/announcements`, { headers: { cookie: jarB.header() }, redirect: "manual" })).status, 200);

  const token = await fetchCsrfToken(app.base, jarA);
  const changeRes = await fetch(`${app.base}/account/password`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jarA.header() },
    body: `currentPassword=${encodeURIComponent(PASSWORD)}&newPassword=${encodeURIComponent("NewStalenessTest1!")}&_csrf=${token}`,
  });
  // Success answers 303 back to the password page, whose notice says it worked (same session).
  assert.equal(changeRes.status, 303);
  assert.equal(changeRes.headers.get("location"), "/account/password");
  jarA.capture(changeRes);
  const changed = await withSeeOtherPage(changeRes, { base: app.base, jar: jarA });
  assert.equal(changed.page.status, 200);
  assert.match(await changed.text(), /Password updated/);

  const aAfter = await fetch(`${app.base}/announcements`, { headers: { cookie: jarA.header() }, redirect: "manual" });
  assert.equal(aAfter.status, 200, "the session that made the change should still work");

  const bAfter = await fetch(`${app.base}/announcements`, { headers: { cookie: jarB.header() }, redirect: "manual" });
  assert.equal(bAfter.status, 302);
  assert.equal(bAfter.headers.get("location"), "/login");
});
