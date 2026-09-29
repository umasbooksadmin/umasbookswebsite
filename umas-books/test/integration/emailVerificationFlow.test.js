// HTTP-level coverage for signup/verification: a real signup should
// leave the account unverified until the emailed link is clicked, that
// link should work exactly once, and an admin-created account (the
// admin already vouching for the email, and the invite flow requiring a
// click from that same inbox to set a password) should be verified
// immediately. See migrations/032_email_verification.sql.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3413; // distinct from app.test.js (3411) and sessionStaleness (3412)

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

test("a new signup is unverified until the emailed link is used", async () => {
  const email = `signup-verify-${Date.now()}@example.test`;
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const signupRes = await fetch(`${app.base}/signup`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent("Correct-Horse-1")}&displayName=Signup+Verify&_csrf=${token}`,
  });
  assert.equal(signupRes.status, 302);

  const { rows } = await pool.query("SELECT email_verified_at FROM users WHERE email = $1", [email]);
  assert.equal(rows[0].email_verified_at, null);

  const { rows: tokenRows } = await pool.query(
    `SELECT evt.id FROM email_verification_tokens evt JOIN users u ON u.id = evt.user_id WHERE u.email = $1`,
    [email]
  );
  assert.equal(tokenRows.length, 1, "signup should have created exactly one verification token");
});

test("visiting an invalid verification link redirects with an error, a real one verifies and can't be reused", async () => {
  const invalidRes = await fetch(`${app.base}/verify-email/not-a-real-token`, { redirect: "manual" });
  assert.equal(invalidRes.status, 302);
  assert.equal(invalidRes.headers.get("location"), "/login?verified=invalid");

  // Insert a real token directly — the actual raw token never leaves the
  // (unsent, since GMAIL_* isn't configured in tests) email body, so this
  // mirrors sendVerificationEmail's own hashing rather than needing to
  // intercept a real email.
  const crypto = require("node:crypto");
  const rawToken = "test-verification-token-for-http-flow";
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const email = `token-flow-${Date.now()}@example.test`;
  const bcrypt = require("bcryptjs");
  const { rows: userRows } = await pool.query(
    "INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, 'Token Flow') RETURNING id",
    [email, await bcrypt.hash("Irrelevant1!", 12)]
  );
  await pool.query(
    "INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [userRows[0].id, tokenHash]
  );

  const firstUse = await fetch(`${app.base}/verify-email/${rawToken}`, { redirect: "manual" });
  assert.equal(firstUse.status, 302);
  assert.equal(firstUse.headers.get("location"), "/login?verified=success");

  const { rows: afterVerify } = await pool.query("SELECT email_verified_at FROM users WHERE id = $1", [userRows[0].id]);
  assert.ok(afterVerify[0].email_verified_at);

  const secondUse = await fetch(`${app.base}/verify-email/${rawToken}`, { redirect: "manual" });
  assert.equal(secondUse.status, 302);
  assert.equal(secondUse.headers.get("location"), "/login?verified=invalid");
});

test("an admin-created account is verified immediately, with no link to click", async () => {
  const bcrypt = require("bcryptjs");
  const adminEmail = `admin-creator-${Date.now()}@example.test`;
  await pool.query(
    "INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ($1, $2, 'Admin Creator', TRUE)",
    [adminEmail, await bcrypt.hash("Irrelevant1!", 12)]
  );

  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const loginRes = await fetch(`${app.base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `email=${encodeURIComponent(adminEmail)}&password=${encodeURIComponent("Irrelevant1!")}&_csrf=${token}`,
  });
  jar.capture(loginRes);
  assert.equal(loginRes.status, 302);

  const newMemberEmail = `admin-invited-${Date.now()}@example.test`;
  const token2 = await fetchCsrfToken(app.base, jar);
  const createRes = await fetch(`${app.base}/admin/members`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `email=${encodeURIComponent(newMemberEmail)}&displayName=Admin+Invited&_csrf=${token2}`,
  });
  assert.equal(createRes.status, 302);

  const { rows } = await pool.query("SELECT email_verified_at FROM users WHERE email = $1", [newMemberEmail]);
  assert.ok(rows[0].email_verified_at, "admin-created accounts should be verified immediately");
});

// Regression: signup used to respond "An account with that email already
// exists" — confirming registration to anyone who tried, the same
// enumeration /forgot-password already deliberately avoids.
test("signing up with an already-registered email doesn't confirm the account exists", async () => {
  const bcrypt = require("bcryptjs");
  const email = `enum-check-${Date.now()}@example.test`;
  await pool.query(
    "INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, 'Existing User')",
    [email, await bcrypt.hash("Irrelevant1!", 12)]
  );

  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/signup`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent("Correct-Horse-2")}&displayName=Attacker&_csrf=${token}`,
  });
  assert.equal(res.status, 200); // re-renders the signup page, doesn't redirect/log in
  const body = await res.text();
  assert.ok(!body.includes("already exists"), "response should not confirm the email is registered");
});
