// Tier 2C: account-enumeration consistency (signup, login), charity vote
// window/atomicity, and admin email change killing sessions/reset links.
// Note authLimiter allows 20 auth POSTs per IP per 15 min — keep the
// total number of /signup, /login and /forgot-password calls here well
// under that.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3450;
const PASSWORD = "HardeningTest1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

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

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function createUser(email, { isAdmin = false, isMember = false, isDisabled = false } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, is_member, is_disabled)
     VALUES ($1, $2, 'Hardening Test', $3, $4, $5) RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 12), isAdmin, isMember, isDisabled]
  );
  return rows[0].id;
}

// Returns { res, body, jar } with the CSRF token value scrubbed from the
// body so two responses can be compared for equality.
async function postForm(path, fields, jar = makeCookieJar()) {
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
  });
  jar.capture(res);
  const text = await res.text();
  return { res, jar, body: text.split(token).join("CSRF") };
}

const login = (email, password = PASSWORD, jar) => postForm("/login", { email, password }, jar);

async function loggedInJar(email) {
  const { res, jar } = await login(email);
  assert.equal(res.status, 302, "login should have succeeded");
  return jar;
}

async function pollTokens(email, expected) {
  for (let i = 0; i < 40; i++) {
    const { rows } = await pool.query(
      `SELECT 1 FROM email_verification_tokens evt JOIN users u ON u.id = evt.user_id WHERE u.email = $1`, [email]
    );
    if (rows.length >= expected) return rows.length;
    await new Promise((r) => setTimeout(r, 100));
  }
  return 0;
}

test("signup responds identically for a new and an existing email, and never logs in", async () => {
  const newEmail = `signup-new-${uniq()}@example.test`;
  const oldEmail = `signup-old-${uniq()}@example.test`;
  await createUser(oldEmail);

  const fields = (email) => ({ email, password: "Correct-Horse-1", displayName: "Someone" });
  const fresh = await postForm("/signup", fields(newEmail));
  const dup = await postForm("/signup", fields(oldEmail));

  assert.equal(fresh.res.status, 200);
  assert.equal(dup.res.status, fresh.res.status);
  assert.equal(dup.res.headers.get("location"), fresh.res.headers.get("location"));
  // Same page; only the echoed-nothing form is identical.
  assert.equal(dup.body, fresh.body, "the two responses must be byte-identical");

  // No auto-login for the brand-new account: an authenticated-only page
  // still bounces to /login with the signup session.
  const probe = await fetch(`${app.base}/account/password`, { redirect: "manual", headers: { cookie: fresh.jar.header() } });
  assert.equal(probe.status, 302);
  assert.equal(probe.headers.get("location"), "/login");

  // The new account exists, unverified, with a verification token queued.
  const { rows } = await pool.query("SELECT email_verified_at FROM users WHERE email = $1", [newEmail]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email_verified_at, null);
  assert.equal(await pollTokens(newEmail, 1), 1, "signup should create one verification token");
  // The existing account gets no verification token (and isn't modified).
  const { rows: oldTokens } = await pool.query(
    "SELECT 1 FROM email_verification_tokens evt JOIN users u ON u.id = evt.user_id WHERE u.email = $1", [oldEmail]
  );
  assert.equal(oldTokens.length, 0);

  // ...and has no password until the email is confirmed and one is chosen
  // (account pre-hijack defence; see accountPreHijack.test.js).
  const loginRes = await login(newEmail, "Correct-Horse-1");
  assert.equal(loginRes.res.status, 401);
});

test("a locked account answers login exactly like a wrong password, even for the right one", async () => {
  const email = `locked-${uniq()}@example.test`;
  await createUser(email);

  const unknown = await login(`nobody-${uniq()}@example.test`, "Wrong-Password-1");
  assert.equal(unknown.res.status, 401);

  for (let i = 0; i < 5; i++) {
    const r = await login(email, "Wrong-Password-1");
    assert.equal(r.res.status, 401);
  }
  const { rows } = await pool.query("SELECT locked_until FROM users WHERE email = $1", [email]);
  assert.ok(rows[0].locked_until && new Date(rows[0].locked_until) > new Date(), "5 failures should lock the account");

  const lockedWrong = await login(email, "Wrong-Password-1");
  const lockedRight = await login(email, PASSWORD);
  for (const r of [lockedWrong, lockedRight]) {
    assert.equal(r.res.status, 401, "a locked account must not reveal itself with a distinct status");
    assert.equal(r.body, unknown.body, "...nor a distinct message");
  }
  // The lockout itself still holds: the correct password didn't get in.
  const after = await pool.query("SELECT locked_until FROM users WHERE email = $1", [email]);
  assert.equal(new Date(after.rows[0].locked_until).getTime(), new Date(rows[0].locked_until).getTime(), "lock not extended or cleared");
});

test("a disabled account is only told so after the correct password", async () => {
  const email = `disabled-${uniq()}@example.test`;
  await createUser(email, { isDisabled: true });

  const unknown = await login(`nobody-${uniq()}@example.test`, "Wrong-Password-1");
  const wrong = await login(email, "Wrong-Password-1");
  assert.equal(wrong.res.status, 401);
  assert.equal(wrong.body, unknown.body);

  const right = await login(email, PASSWORD);
  assert.equal(right.res.status, 403);
  assert.ok(right.body.includes("deactivated"));
  // ...and it still isn't logged in.
  const probe = await fetch(`${app.base}/account/password`, { redirect: "manual", headers: { cookie: right.jar.header() } });
  assert.equal(probe.status, 302);
  assert.equal(probe.headers.get("location"), "/login");
});

async function createRound({ allowMultiple, opensAt, closesAt, optionCount = 2 }) {
  await pool.query("UPDATE charity_rounds SET is_active = FALSE");
  const { rows } = await pool.query(
    `INSERT INTO charity_rounds (title, opens_at, closes_at, is_active, allow_multiple)
     VALUES ('Hardening round', $1, $2, TRUE, $3) RETURNING id`,
    [opensAt, closesAt, allowMultiple]
  );
  const optionIds = [];
  for (let i = 0; i < optionCount; i++) {
    const { rows: o } = await pool.query(
      "INSERT INTO charity_options (round_id, name) VALUES ($1, $2) RETURNING id", [rows[0].id, `Option ${i}`]
    );
    optionIds.push(o[0].id);
  }
  return { roundId: rows[0].id, optionIds };
}

async function vote(jar, optionIds) {
  const token = await fetchCsrfToken(app.base, jar);
  const body = new URLSearchParams();
  for (const id of optionIds) body.append("optionIds", String(id));
  body.append("_csrf", token);
  return fetch(`${app.base}/charity/vote`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: body.toString(),
  });
}

test("charity votes outside the open window are rejected and leave existing votes alone", async () => {
  const email = `voter-${uniq()}@example.test`;
  await createUser(email, { isMember: true });
  const jar = await loggedInJar(email);

  const open = await createRound({ allowMultiple: false, opensAt: new Date(Date.now() - 3600e3), closesAt: new Date(Date.now() + 3600e3) });
  await vote(jar, [open.optionIds[0]]);
  let { rows } = await pool.query("SELECT option_id FROM charity_votes WHERE round_id = $1", [open.roundId]);
  assert.deepEqual(rows.map((r) => r.option_id), [open.optionIds[0]], "an open round accepts the vote");

  // Round closes (still is_active): changing the vote must be refused.
  await pool.query("UPDATE charity_rounds SET closes_at = now() - interval '1 minute' WHERE id = $1", [open.roundId]);
  const closedRes = await vote(jar, [open.optionIds[1]]);
  assert.equal(closedRes.status, 302);
  ({ rows } = await pool.query("SELECT option_id FROM charity_votes WHERE round_id = $1", [open.roundId]));
  assert.deepEqual(rows.map((r) => r.option_id), [open.optionIds[0]], "a closed round must not change votes");

  const future = await createRound({ allowMultiple: false, opensAt: new Date(Date.now() + 3600e3), closesAt: null });
  await vote(jar, [future.optionIds[0]]);
  ({ rows } = await pool.query("SELECT 1 FROM charity_votes WHERE round_id = $1", [future.roundId]));
  assert.equal(rows.length, 0, "a round that hasn't opened yet must not take votes");
});

test("concurrent votes in a single-choice round never leave more than one vote", async () => {
  const email = `racer-${uniq()}@example.test`;
  await createUser(email, { isMember: true });
  const jar = await loggedInJar(email);
  const { roundId, optionIds } = await createRound({
    allowMultiple: false, opensAt: new Date(Date.now() - 3600e3), closesAt: null, optionCount: 4,
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    await Promise.all(
      Array.from({ length: 16 }, (_, i) => vote(jar, [optionIds[i % optionIds.length]]))
    );
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM charity_votes WHERE round_id = $1", [roundId]);
    assert.equal(rows[0].n, 1, `attempt ${attempt}: exactly one vote expected`);
  }
});

test("an admin email change kills the account's sessions and unused reset links", async () => {
  const ts = uniq();
  const adminEmail = `hardening-admin-${ts}@example.test`;
  await createUser(adminEmail, { isAdmin: true });
  const oldEmail = `squatted-${ts}@example.test`;
  const newEmail = `rightful-${ts}@example.test`;
  const userId = await createUser(oldEmail, { isMember: true });

  const squatterJar = await loggedInJar(oldEmail);
  const before1 = await fetch(`${app.base}/announcements`, { redirect: "manual", headers: { cookie: squatterJar.header() } });
  assert.equal(before1.status, 200);

  const rawReset = `reset-${ts}`;
  await pool.query(
    "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [userId, crypto.createHash("sha256").update(rawReset).digest("hex")]
  );

  const adminJar = await loggedInJar(adminEmail);

  // A name-only edit must NOT log the account out or burn its reset links.
  await postForm(`/admin/members/${userId}/edit`, { email: oldEmail, displayName: "Renamed" }, adminJar);
  const stillIn = await fetch(`${app.base}/announcements`, { redirect: "manual", headers: { cookie: squatterJar.header() } });
  assert.equal(stillIn.status, 200, "a name-only edit keeps sessions");
  const { rows: unused } = await pool.query("SELECT 1 FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL", [userId]);
  assert.equal(unused.length, 1, "a name-only edit keeps reset links");

  await postForm(`/admin/members/${userId}/edit`, { email: newEmail, displayName: "Renamed" }, adminJar);

  const after1 = await fetch(`${app.base}/announcements`, { redirect: "manual", headers: { cookie: squatterJar.header() } });
  assert.equal(after1.status, 302);
  assert.equal(after1.headers.get("location"), "/login", "the old session must be logged out");

  const resetPage = await fetch(`${app.base}/reset-password/${rawReset}`, { redirect: "manual" });
  assert.equal(resetPage.status, 400, "a reset link sent to the old address must be dead");
  const { rows: stillUnused } = await pool.query(
    "SELECT 1 FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL", [userId]
  );
  assert.equal(stillUnused.length, 0);
});
