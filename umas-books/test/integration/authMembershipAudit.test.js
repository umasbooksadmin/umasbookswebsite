// Audit set B, route level (in-process so HelloAsso and the mailer can be
// stubbed): pay-first members get activated when their account is later
// verified / reset / admin-created, the password-reset token is an atomic
// single-use gate with its side effects, and the login lockout counts
// exactly under concurrency.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { prepareDatabase, buildApp, listen, waitFor } = require("../helpers/inProcessApp");
const { clickConfirmationLink, makeCookieJar, withSeeOtherPage } = require("../helpers/httpClient");

const db = prepareDatabase("authaudit", { isolated: true });

// Stubs go in BEFORE the routes load (membership.js destructures them).
const helloasso = require("../../src/lib/helloasso");
let mockedOrders = [];
helloasso.isConfigured = () => true;
helloasso.findMembershipOrdersByEmail = async (email) =>
  mockedOrders.filter((o) => o.payer.email.toLowerCase() === email.toLowerCase());
const mailer = require("../../src/mailer");
mailer.sendMail = async () => {};

const { pool } = require("../../src/db");
const { hashToken } = require("../../src/lib/resetTokens");

let server;
before(async () => {
  db.create();
  server = await listen(buildApp([require("../../src/routes/auth"), require("../../src/routes/admin/members")]));
});
after(async () => {
  await server.close();
  await pool.end();
  db.drop();
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const rid = () => Math.floor(Math.random() * 2e9);
function paidOrder(email) {
  return { id: rid(), payer: { email }, payments: [{ state: "Authorized" }], amount: { total: 3000 }, date: new Date().toISOString() };
}
async function createUser(email, { verified = false, password = "Irrelevant-1!", cost = 4 } = {}) {
  const hash = await bcrypt.hash(password, cost);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at)
     VALUES ($1, $2, 'Audit Test', ${verified ? "now()" : "NULL"}) RETURNING id`,
    [email, hash]
  );
  return rows[0].id;
}
async function addToken(table, userId, raw) {
  await pool.query(
    `INSERT INTO ${table} (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [userId, hashToken(raw)]
  );
}
function post(path, body, headers = {}) {
  return fetch(`${server.base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body).toString(),
  });
}
// Same, in its own session, and a refused form's 303 is followed like a browser does:
// `.text()` is the page the redirect leads to, `.page` that GET response, `.location` the redirect.
async function postSeen(path, body) {
  const jar = makeCookieJar();
  const res = await post(path, body);
  jar.capture(res);
  const seen = await withSeeOtherPage(res, { base: server.base, jar });
  return Object.assign(seen, { location: res.headers.get("location") });
}
const isMember = async (email) =>
  (await pool.query("SELECT is_member FROM users WHERE email = $1", [email])).rows[0].is_member;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test("pay first, verify the account later: membership is granted without the webhook", async () => {
  const email = `payfirst-verify-${uniq()}@example.test`;
  mockedOrders = [paidOrder(email)];
  const userId = await createUser(email, { verified: false });
  const raw = `vt-${uniq()}`;
  await addToken("email_verification_tokens", userId, raw);

  assert.equal(await isMember(email), false);
  const res = await clickConfirmationLink(server.base, `/verify-email/${raw}`);
  assert.equal(res.headers.get("location"), "/login?verified=success");
  await waitFor(() => isMember(email), { message: "membership after verification" });

  const again = await clickConfirmationLink(server.base, `/verify-email/${raw}`);
  assert.equal(again.status, 400);
});

test("an unverified account stays unattributed (trust rule)", async () => {
  const email = `unverified-${uniq()}@example.test`;
  mockedOrders = [paidOrder(email)];
  await createUser(email, { verified: false });
  await pause(200);
  assert.equal(await isMember(email), false);
});

test("pay first, admin creates the account later: membership is granted", async () => {
  const email = `payfirst-admin-${uniq()}@example.test`;
  mockedOrders = [paidOrder(email)];
  const admin = JSON.stringify({ id: 1, email: "a@x.test", isAdmin: true });
  const res = await post("/admin/members", { email, displayName: "Admin Made" }, { "x-test-user": admin });
  assert.equal(res.status, 302);
  await waitFor(() => isMember(email), { message: "membership after admin create" });
});

test("a failing sync never fails the verification request", async () => {
  const email = `syncfail-${uniq()}@example.test`;
  const userId = await createUser(email, { verified: false });
  const raw = `vt-${uniq()}`;
  await addToken("email_verification_tokens", userId, raw);
  mockedOrders = [paidOrder(email)];
  const q = pool.query.bind(pool);
  pool.query = (sql, ...rest) =>
    typeof sql === "string" && /FROM users WHERE lower\(email\)/.test(sql) ? Promise.reject(new Error("boom")) : q(sql, ...rest);
  try {
    const res = await clickConfirmationLink(server.base, `/verify-email/${raw}`);
    assert.equal(res.headers.get("location"), "/login?verified=success");
    await pause(200);
  } finally {
    pool.query = q;
  }
  assert.equal(await isMember(email), false);
});

test("password reset: pay-first member activated, email verified, lock cleared, other tokens retired", async () => {
  const email = `reset-effects-${uniq()}@example.test`;
  mockedOrders = [paidOrder(email)];
  const userId = await createUser(email, { verified: false });
  await pool.query(
    "UPDATE users SET failed_login_attempts = 3, locked_until = now() + interval '10 minutes', password_changed_at = now() - interval '1 day' WHERE id = $1",
    [userId]
  );
  const raw = `rt-${uniq()}`;
  const otherRaw = `rt-other-${uniq()}`;
  await addToken("password_reset_tokens", userId, raw);
  await addToken("password_reset_tokens", userId, otherRaw);

  const res = await post(`/reset-password/${raw}`, { newPassword: "Brand-New-Passw0rd!" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/login?reset=success");

  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
  assert.ok(rows[0].email_verified_at, "email verified by completing a reset");
  assert.equal(rows[0].failed_login_attempts, 0);
  assert.equal(rows[0].locked_until, null);
  assert.ok(Date.now() - new Date(rows[0].password_changed_at).getTime() < 60_000, "password_changed_at bumped");
  assert.ok(await bcrypt.compare("Brand-New-Passw0rd!", rows[0].password_hash));
  const { rows: unused } = await pool.query("SELECT 1 FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL", [userId]);
  assert.equal(unused.length, 0, "other unused tokens are retired");
  const other = await post(`/reset-password/${otherRaw}`, { newPassword: "Another-Passw0rd-9" });
  assert.equal(other.status, 303, "a retired token is refused (back to its own page)");
  assert.equal(other.headers.get("location"), `/reset-password/${otherRaw}`);
  await waitFor(() => isMember(email), { message: "membership after reset" });
});

test("password reset: a weak password does not burn the token; an expired token is rejected", async () => {
  const email = `reset-weak-${uniq()}@example.test`;
  const userId = await createUser(email, { verified: true });
  const raw = `rt-${uniq()}`;
  await addToken("password_reset_tokens", userId, raw);
  const weak = await postSeen(`/reset-password/${raw}`, { newPassword: "short" });
  assert.equal(weak.status, 303);
  assert.equal(weak.location, `/reset-password/${raw}`);
  assert.equal(weak.page.status, 200, "the token is still live, the page shows the form with the message");
  assert.match(await weak.text(), /error-box/);
  const ok = await post(`/reset-password/${raw}`, { newPassword: "Strong-Enough-Passw0rd!" });
  assert.equal(ok.status, 302);

  const expired = `rt-exp-${uniq()}`;
  await pool.query(
    "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() - interval '1 minute')",
    [userId, hashToken(expired)]
  );
  const res = await postSeen(`/reset-password/${expired}`, { newPassword: "Strong-Enough-Passw0rd-2!" });
  assert.equal(res.status, 303);
  assert.equal(res.location, `/reset-password/${expired}`);
  assert.equal(res.page.status, 400, "the link's own page says it is invalid or expired");
  assert.match(await res.text(), /invalid or has expired/);
});

test("password reset race: 8 parallel POSTs with one token set exactly one password", async () => {
  const email = `reset-race-${uniq()}@example.test`;
  const userId = await createUser(email, { verified: true });
  const raw = `rt-${uniq()}`;
  await addToken("password_reset_tokens", userId, raw);
  const passwords = Array.from({ length: 8 }, (_, i) => `Race-Passw0rd-${i}-${uniq()}`);
  const results = await Promise.all(passwords.map((p) => post(`/reset-password/${raw}`, { newPassword: p })));
  const winners = results.map((r, i) => [r.status, i]).filter(([s]) => s === 302);
  assert.equal(winners.length, 1, `statuses: ${results.map((r) => r.status)}`);
  assert.equal(results.filter((r) => r.status === 303).length, 7);

  const { rows } = await pool.query("SELECT password_hash FROM users WHERE id = $1", [userId]);
  assert.ok(await bcrypt.compare(passwords[winners[0][1]], rows[0].password_hash), "stored password is the winner's");
});

const wrongLogins = (email, n) =>
  Promise.all(Array.from({ length: n }, () => post("/login", { email, password: "wrong-password" })));

test("login lockout: concurrent wrong passwords below the threshold are all counted", async () => {
  const email = `lockout-count-${uniq()}@example.test`;
  const userId = await createUser(email, { verified: true, password: "Right-Passw0rd-1!", cost: 12 });
  const results = await wrongLogins(email, 4);
  for (const r of results) assert.equal(r.status, 303);
  // One more crosses the threshold (5 per account+IP, counted in memory,
  // lib/loginThrottle.js): if the 4 concurrent ones had been undercounted this
  // would still be below it and the right password would get in.
  assert.equal((await wrongLogins(email, 1))[0].status, 303);
  // Locked for this address: even the right password gets the same generic refusal
  // (a redirect back to /login with the same message as a wrong password).
  const locked = await postSeen("/login", { email, password: "Right-Passw0rd-1!" });
  assert.equal(locked.status, 303);
  assert.equal(locked.location, "/login");
  const wrongAgain = await postSeen("/login", { email, password: "wrong-password" });
  assert.equal(await locked.text(), await wrongAgain.text());
  assert.match(await locked.text(), /Incorrect email or password/);
  // ...without locking the account itself for anyone else.
  assert.equal((await pool.query("SELECT locked_until FROM users WHERE id = $1", [userId])).rows[0].locked_until, null);
});

test("login lockout: a burst of concurrent wrong passwords cannot bypass the lock", async () => {
  const email = `lockout-burst-${uniq()}@example.test`;
  const userId = await createUser(email, { verified: true, password: "Right-Passw0rd-1!", cost: 12 });
  const results = await wrongLogins(email, 8);
  for (const r of results) assert.equal(r.status, 303);
  assert.equal((await post("/login", { email, password: "Right-Passw0rd-1!" })).status, 303, "locked after >=5 concurrent failures, right password refused");
  assert.ok(userId);
});
