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
  // Neutral page, not a redirect/auto-login (same for existing emails).
  assert.equal(signupRes.status, 200);

  const { rows } = await pool.query("SELECT email_verified_at FROM users WHERE email = $1", [email]);
  assert.equal(rows[0].email_verified_at, null);

  // The verification email is sent in the background after the response,
  // so its token row can land a moment later.
  let tokenRows = [];
  for (let i = 0; i < 40 && tokenRows.length === 0; i++) {
    ({ rows: tokenRows } = await pool.query(
      `SELECT evt.id FROM email_verification_tokens evt JOIN users u ON u.id = evt.user_id WHERE u.email = $1`,
      [email]
    ));
    if (!tokenRows.length) await new Promise((r) => setTimeout(r, 100));
  }
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

// Regression: an admin changing a member's email used to leave
// email_verified_at set, so the new (unproven) address was still
// auto-matched to HelloAsso membership payments.
test("an admin changing a member's email clears verification and burns old links", async () => {
  const bcrypt = require("bcryptjs");
  const crypto = require("node:crypto");
  const ts = Date.now();
  const adminEmail = `admin-editor-${ts}@example.test`;
  await pool.query(
    "INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ($1, $2, 'Admin Editor', TRUE)",
    [adminEmail, await bcrypt.hash("Irrelevant1!", 12)]
  );
  const oldEmail = `edit-old-${ts}@example.test`;
  const newEmail = `edit-new-${ts}@example.test`;
  const { rows: u } = await pool.query(
    "INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, $2, 'Edit Me', now()) RETURNING id",
    [oldEmail, await bcrypt.hash("Irrelevant1!", 12)]
  );
  const rawOld = `old-link-${ts}`;
  await pool.query(
    "INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [u[0].id, crypto.createHash("sha256").update(rawOld).digest("hex")]
  );

  const jar = makeCookieJar();
  const t1 = await fetchCsrfToken(app.base, jar);
  const loginRes = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `email=${encodeURIComponent(adminEmail)}&password=${encodeURIComponent("Irrelevant1!")}&_csrf=${t1}`,
  });
  jar.capture(loginRes);

  const edit = async (email, name) => {
    const t = await fetchCsrfToken(app.base, jar);
    return fetch(`${app.base}/admin/members/${u[0].id}/edit`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
      body: `email=${encodeURIComponent(email)}&displayName=${encodeURIComponent(name)}&_csrf=${t}`,
    });
  };

  // Name-only edit keeps verification.
  await edit(oldEmail, "Renamed");
  let { rows } = await pool.query("SELECT email_verified_at FROM users WHERE id = $1", [u[0].id]);
  assert.ok(rows[0].email_verified_at, "a name-only edit must not clear verification");

  await edit(newEmail, "Renamed");
  ({ rows } = await pool.query("SELECT email, email_verified_at FROM users WHERE id = $1", [u[0].id]));
  assert.equal(rows[0].email, newEmail);
  assert.equal(rows[0].email_verified_at, null);

  const oldLink = await fetch(`${app.base}/verify-email/${rawOld}`, { redirect: "manual" });
  assert.equal(oldLink.headers.get("location"), "/login?verified=invalid");
  ({ rows } = await pool.query("SELECT email_verified_at FROM users WHERE id = $1", [u[0].id]));
  assert.equal(rows[0].email_verified_at, null, "an old-address link must not verify the new address");

  const { rows: fresh } = await pool.query(
    "SELECT 1 FROM email_verification_tokens WHERE user_id = $1 AND used_at IS NULL", [u[0].id]
  );
  assert.equal(fresh.length, 1, "a fresh link for the new address should have been issued");
});

// Regression: editing a member's email to one another account already
// uses hit users.email's UNIQUE constraint and went unhandled.
test("an admin editing a member to a duplicate email gets a redirect, not a crash", async () => {
  const bcrypt = require("bcryptjs");
  const ts = Date.now();
  const hash = await bcrypt.hash("Irrelevant1!", 12);
  const adminEmail = `admin-dup-${ts}@example.test`;
  await pool.query("INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ($1, $2, 'Admin Dup', TRUE)", [adminEmail, hash]);
  const takenEmail = `dup-taken-${ts}@example.test`;
  await pool.query("INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, $2, 'Taken', now())", [takenEmail, hash]);
  const origEmail = `dup-orig-${ts}@example.test`;
  const { rows: u } = await pool.query(
    "INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, $2, 'Orig', now()) RETURNING id", [origEmail, hash]);

  const jar = makeCookieJar();
  const t1 = await fetchCsrfToken(app.base, jar);
  jar.capture(await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `email=${encodeURIComponent(adminEmail)}&password=${encodeURIComponent("Irrelevant1!")}&_csrf=${t1}`,
  }));
  const t2 = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/admin/members/${u[0].id}/edit`, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `email=${encodeURIComponent(takenEmail)}&displayName=Orig&_csrf=${t2}`,
  });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get("location").includes("emailTaken=1"));
  const { rows } = await pool.query("SELECT email, email_verified_at FROM users WHERE id = $1", [u[0].id]);
  assert.equal(rows[0].email, origEmail);
  assert.ok(rows[0].email_verified_at, "a rejected change must leave verification intact");

  const page = await fetch(`${app.base}/admin/members?view=${u[0].id}&panel=edit&emailTaken=1`, { headers: { cookie: jar.header() } });
  assert.ok((await page.text()).includes("already used by another account"));
});
