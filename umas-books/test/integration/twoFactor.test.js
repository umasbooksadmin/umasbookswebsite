// Two-step verification (routes/twoFactor.js + /login/2fa in routes/auth.js)
// with enforcement ON: admins are forced to enrol, login needs a code,
// codes can't be replayed, recovery codes work once, another admin can reset.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken, withSeeOtherPage } = require("../helpers/httpClient");

process.env.SESSION_SECRET = "test-session-secret-not-for-production"; // same as the app under test
const totp = require("../../src/lib/totp");

const PORT = 3492;
const PASSWORD = "TwoFactorTest1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let app, pool;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true, env: { ADMIN_2FA_REQUIRED: "true" } });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
});
after(async () => {
  await pool.end();
  app.stop();
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function createUser({ admin = false } = {}) {
  const email = `tf-${uniq()}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, email_verified_at)
     VALUES ($1, $2, 'TF', $3, now()) RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 10), admin]
  );
  return { id: rows[0].id, email };
}

async function post(jar, path, fields) {
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}${path}`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
  });
  jar.capture(res);
  // A refused form answers 303 to a GET page; read the message from that page (same session).
  const seen = await withSeeOtherPage(res, { base: app.base, jar });
  return { res, text: await seen.text(), location: res.headers.get("location") };
}
async function get(jar, path) {
  const res = await fetch(`${app.base}${path}`, { redirect: "manual", headers: { cookie: jar.header() } });
  jar.capture(res);
  return { res, text: await res.text() };
}
const passwordLogin = async (email) => {
  const jar = makeCookieJar();
  const r = await post(jar, "/login", { email, password: PASSWORD });
  return { jar, r };
};
const secretOf = async (id) =>
  totp.decryptSecret((await pool.query("SELECT totp_secret_enc FROM users WHERE id=$1", [id])).rows[0].totp_secret_enc);
const nextCode = (secret) => totp.hotp(secret, totp.currentStep() + 1);

// Enrols the user and returns { secret, codes }.
async function enrol(user) {
  const { jar, r } = await passwordLogin(user.email);
  assert.equal(r.res.status, 302);
  const page = await get(jar, "/account/2fa");
  assert.equal(page.res.status, 200);
  assert.match(page.text, /data:image\/png;base64/);
  const secret = await secretOf(user.id);
  const badPw = await post(jar, "/account/2fa/enable", { code: totp.hotp(secret, totp.currentStep()), password: "wrong" });
  assert.equal(badPw.res.status, 303);
  assert.equal(badPw.location, "/account/2fa");
  assert.equal((await pool.query("SELECT totp_enabled_at FROM users WHERE id=$1", [user.id])).rows[0].totp_enabled_at, null);
  const wrong = await post(jar, "/account/2fa/enable", { code: "000000", password: PASSWORD });
  assert.equal(wrong.res.status, 303);
  assert.equal(wrong.location, "/account/2fa");
  const ok = await post(jar, "/account/2fa/enable", { code: totp.hotp(secret, totp.currentStep()), password: PASSWORD });
  assert.equal(ok.res.status, 200);
  const codes = [...ok.text.matchAll(/<code>([A-Z2-7]{5}-[A-Z2-7]{5})<\/code>/g)].map((m) => m[1]);
  assert.equal(codes.length, 10);
  return { jar, secret, codes };
}

test("an admin without two-step is sent to set it up and cannot reach /admin", async () => {
  const admin = await createUser({ admin: true });
  const { jar } = await passwordLogin(admin.email);
  const r = await get(jar, "/admin");
  assert.equal(r.res.status, 302);
  assert.match(r.res.headers.get("location"), /^\/account\/2fa/);
});

test("enrolment turns /admin on; the secret is stored encrypted", async () => {
  const admin = await createUser({ admin: true });
  const { jar, secret } = await enrol(admin);
  assert.equal((await get(jar, "/admin")).res.status, 200);
  const { rows } = await pool.query("SELECT totp_secret_enc, totp_enabled_at FROM users WHERE id=$1", [admin.id]);
  assert.ok(rows[0].totp_enabled_at);
  assert.ok(!rows[0].totp_secret_enc.includes(secret));
});

test("login with two-step: password alone is not enough, a valid code is, a replay is not", async () => {
  const admin = await createUser({ admin: true });
  const { secret } = await enrol(admin);

  const a = await passwordLogin(admin.email);
  assert.equal(a.r.res.headers.get("location"), "/login/2fa");
  assert.equal((await get(a.jar, "/admin")).res.status, 302, "not logged in yet");
  assert.match((await get(a.jar, "/admin")).res.headers.get("location"), /\/login/);

  const bad = await post(a.jar, "/login/2fa", { code: "123456" });
  assert.equal(bad.res.status, 303);
  assert.equal(bad.location, "/login/2fa");
  assert.match(bad.text, /That code didn&#39;t work|That code didn't work/);

  const code = nextCode(secret);
  const good = await post(a.jar, "/login/2fa", { code });
  assert.equal(good.res.status, 302);
  assert.equal(good.res.headers.get("location"), "/admin");
  assert.equal((await get(a.jar, "/admin")).res.status, 200);

  const b = await passwordLogin(admin.email);
  const replay = await post(b.jar, "/login/2fa", { code });
  assert.equal(replay.res.status, 303, "same code twice must fail");
});

test("recovery codes work once", async () => {
  const admin = await createUser({ admin: true });
  const { codes } = await enrol(admin);
  const a = await passwordLogin(admin.email);
  const ok = await post(a.jar, "/login/2fa", { code: codes[0].toLowerCase() });
  assert.equal(ok.res.status, 302);
  const b = await passwordLogin(admin.email);
  assert.equal((await post(b.jar, "/login/2fa", { code: codes[0] })).res.status, 303);
});

test("five wrong codes end the pending login", async () => {
  const admin = await createUser({ admin: true });
  await enrol(admin);
  const a = await passwordLogin(admin.email);
  let last;
  for (let i = 0; i < 5; i++) last = await post(a.jar, "/login/2fa", { code: "111111" });
  assert.match(last.text, /Too many wrong codes/);
  assert.equal((await get(a.jar, "/login/2fa")).res.headers.get("location"), "/login");
});

test("a user without two-step logs in as before", async () => {
  const u = await createUser();
  const { r } = await passwordLogin(u.email);
  assert.equal(r.res.status, 302);
  assert.equal(r.res.headers.get("location"), "/");
});

test("admins cannot disable it; another admin can reset it and the account must re-enrol", async () => {
  const victim = await createUser({ admin: true });
  const { jar: victimJar, secret } = await enrol(victim);
  const dis = await post(victimJar, "/account/2fa/disable", { code: nextCode(secret) });
  assert.equal(dis.res.status, 302);
  assert.ok((await pool.query("SELECT totp_enabled_at FROM users WHERE id=$1", [victim.id])).rows[0].totp_enabled_at);

  const other = await createUser({ admin: true });
  const { jar: otherJar, secret: otherSecret } = await enrol(other);
  // log in fully as the other admin
  const l = await passwordLogin(other.email);
  await post(l.jar, "/login/2fa", { code: nextCode(otherSecret) });
  const reset = await post(l.jar, `/admin/members/${victim.id}/reset-2fa`, {});
  assert.equal(reset.res.status, 302);
  const { rows } = await pool.query("SELECT totp_enabled_at, totp_secret_enc FROM users WHERE id=$1", [victim.id]);
  assert.equal(rows[0].totp_enabled_at, null);
  assert.equal(rows[0].totp_secret_enc, null);
  assert.equal((await pool.query("SELECT 1 FROM totp_recovery_codes WHERE user_id=$1", [victim.id])).rows.length, 0);
  // the victim's old session is out and a fresh login is sent to enrol again
  const again = await passwordLogin(victim.email);
  assert.equal(again.r.res.status, 302);
  assert.match((await get(again.jar, "/admin")).res.headers.get("location"), /^\/account\/2fa/);
  void otherJar;
});

test("wrong two-step codes lock the account, whatever cookie or session the attacker uses", async () => {
  const admin = await createUser({ admin: true });
  await enrol(admin);
  // Fresh login (new cookie) each round: the per-session counter never reaches 5, the account counter does.
  for (let round = 0; round < 3; round++) {
    const a = await passwordLogin(admin.email);
    if (a.r.res.headers.get("location") !== "/login/2fa") break;
    for (let i = 0; i < 2; i++) await post(a.jar, "/login/2fa", { code: "222222" });
  }
  const { rows } = await pool.query("SELECT locked_until FROM users WHERE id=$1", [admin.id]);
  assert.ok(rows[0].locked_until && new Date(rows[0].locked_until) > new Date(), "account must be locked");
});

test("an undecryptable secret does not 500 the login; recovery codes still work", async () => {
  const admin = await createUser({ admin: true });
  const { codes } = await enrol(admin);
  await pool.query("UPDATE users SET totp_secret_enc = 'AAAA.BBBB.CCCC' WHERE id=$1", [admin.id]);
  const a = await passwordLogin(admin.email);
  const bad = await post(a.jar, "/login/2fa", { code: "123456" });
  assert.equal(bad.res.status, 303);
  const ok = await post(a.jar, "/login/2fa", { code: codes[0] });
  assert.equal(ok.res.status, 302);
});
