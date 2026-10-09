// Admin sessions: 8-hour idle and 7-day absolute limits (src/lib/adminSession.js).
// Old sessions are simulated by rewriting the session row's JSON directly.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 4311;
const PORT_SHORT = 4312;
const PASSWORD = "AdminSession1!";
const H = 60 * 60 * 1000;
const D = 24 * H;

let app;
let shortApp; // ADMIN_SESSION_MAX_DAYS=1
let pool;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  shortApp = await startTestApp({ port: PORT_SHORT, isolated: true, env: { ADMIN_SESSION_MAX_DAYS: "1", ADMIN_SESSION_IDLE_HOURS: "bogus" } });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
});

after(async () => {
  await pool.end();
  await shortApp.stop();
  await app.stop();
});

async function createUser(email, { isAdmin = false, isMember = false, isTill = false } = {}) {
  const hash = await bcrypt.hash(PASSWORD, 4);
  const { rows } = await pool.query(
    "INSERT INTO users (email, password_hash, display_name, is_admin, is_member, is_till) VALUES ($1, $2, 'Session Test', $3, $4, $5) RETURNING id",
    [email, hash, isAdmin, isMember, isTill]
  );
  return rows[0].id;
}

async function login(base, email, returnTo) {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(base, jar);
  const res = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent(PASSWORD)}&_csrf=${token}` + (returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : ""),
  });
  jar.capture(res);
  assert.equal(res.status, 302, "login should succeed");
  // express-session also saves again AFTER the redirect went out (the session hash it compares
  // with predates loginAs' own save). On a slow runner that late write could land after a test
  // has aged the session row and silently undo it; let it finish first.
  await new Promise((r) => setTimeout(r, 400));
  return { jar, location: res.headers.get("location") };
}

const sidOf = (jar) => decodeURIComponent(jar.header().match(/umasbooks\.sid=([^;]+)/)[1]).slice(2).split(".")[0];
async function readSess(jar) {
  const { rows } = await pool.query("SELECT sess FROM session WHERE sid = $1", [sidOf(jar)]);
  return rows[0] ? rows[0].sess : null;
}
async function patchSess(jar, patch) {
  await pool.query("UPDATE session SET sess = (sess::jsonb || $2::jsonb)::json WHERE sid = $1", [sidOf(jar), JSON.stringify(patch)]);
}
const get = (base, jar, path, headers = {}) => fetch(`${base}${path}`, { redirect: "manual", headers: { cookie: jar.header(), ...headers } });

test("login stamps adminLoginAt and adminLastActivity for an admin, not for a member", async () => {
  const email = `as-stamp-${Date.now()}@example.test`;
  await createUser(email, { isAdmin: true });
  const { jar } = await login(app.base, email);
  const sess = await readSess(jar);
  assert.ok(sess.adminLoginAt > Date.now() - 60000);
  assert.ok(sess.adminLastActivity > Date.now() - 60000);

  const m = `as-member-${Date.now()}@example.test`;
  await createUser(m, { isMember: true });
  const { jar: mj } = await login(app.base, m);
  const msess = await readSess(mj);
  assert.equal(msess.adminLoginAt, undefined);
});

test("an admin idle for more than 8 hours is signed out and sent to /login with returnTo and the notice", async () => {
  const email = `as-idle-${Date.now()}@example.test`;
  await createUser(email, { isAdmin: true });
  const { jar } = await login(app.base, email);
  assert.equal((await get(app.base, jar, "/admin")).status, 200);

  await patchSess(jar, { adminLastActivity: Date.now() - 9 * H });
  const res = await get(app.base, jar, "/admin/orders?page=2");
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/login?expired=1&returnTo=%2Fadmin%2Forders%3Fpage%3D2");
  assert.equal(await readSess(jar), null, "the session row is destroyed");

  // The notice, in English and in French.
  const fresh = makeCookieJar();
  const en = await (await get(app.base, fresh, res.headers.get("location"))).text();
  assert.match(en, /You were signed out after a period of inactivity\. Please log in again\./);
  const fr = await (await get(app.base, makeCookieJar(), res.headers.get("location"), { "accept-language": "fr-FR,fr;q=0.9" })).text();
  assert.match(fr, /déconnecté/);

  // Logging in again returns to the requested page.
  const again = await login(app.base, email, "/admin/orders?page=2");
  assert.equal(again.location, "/admin/orders?page=2");
});

test("the old cookie no longer works after expiry (not even for the public site)", async () => {
  const email = `as-public-${Date.now()}@example.test`;
  await createUser(email, { isAdmin: true });
  const { jar } = await login(app.base, email);
  await patchSess(jar, { adminLastActivity: Date.now() - 9 * H });
  const res = await get(app.base, jar, "/books");
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /^\/login\?expired=1&returnTo=%2Fbooks/);
  assert.equal((await get(app.base, jar, "/admin")).status, 302); // now simply logged out
});

test("an admin active within 8 hours stays signed in, for a whole day of shifts, and activity is written at most every 5 minutes", async () => {
  const email = `as-active-${Date.now()}@example.test`;
  await createUser(email, { isAdmin: true });
  const { jar } = await login(app.base, email);
  const first = (await readSess(jar)).adminLastActivity;

  await get(app.base, jar, "/admin");
  assert.equal((await readSess(jar)).adminLastActivity, first, "a request a moment later does not write the session");

  await patchSess(jar, { adminLastActivity: Date.now() - 7 * H });
  assert.equal((await get(app.base, jar, "/admin")).status, 200);
  // express-session saves after the response went out: poll briefly instead of reading at once.
  let touched = 0;
  for (let i = 0; i < 50 && !(touched > Date.now() - 60000); i++) {
    touched = (await readSess(jar)).adminLastActivity;
    if (!(touched > Date.now() - 60000)) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(touched > Date.now() - 60000, "stale activity is refreshed");
});

test("absolute limit: an active admin is signed out 7 days after the login", async () => {
  const email = `as-max-${Date.now()}@example.test`;
  await createUser(email, { isAdmin: true });
  const { jar } = await login(app.base, email);
  await patchSess(jar, { adminLoginAt: Date.now() - 7 * D - 1000 });
  const res = await get(app.base, jar, "/admin");
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /^\/login\?expired=1/);

  const { jar: ok } = await login(app.base, email);
  await patchSess(ok, { adminLoginAt: Date.now() - 6 * D });
  assert.equal((await get(app.base, ok, "/admin")).status, 200);
});

test("members and customers keep the 30-day behaviour: nothing is enforced however old the clocks", async () => {
  const email = `as-cust-${Date.now()}@example.test`;
  await createUser(email, { isMember: true });
  const { jar } = await login(app.base, email);
  await patchSess(jar, { adminLoginAt: Date.now() - 20 * D, adminLastActivity: Date.now() - 20 * D });
  assert.equal((await get(app.base, jar, "/announcements")).status, 200);
});

test("fetch requests get 401 JSON session_expired (till, scan lookup), not a redirect", async () => {
  const email = `as-json-${Date.now()}@example.test`;
  await createUser(email, { isAdmin: true });
  const { jar } = await login(app.base, email);
  await patchSess(jar, { adminLastActivity: Date.now() - 9 * H });
  const res = await fetch(`${app.base}/admin/till/scan`, {
    method: "POST", redirect: "manual",
    headers: { cookie: jar.header(), accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: "_csrf=whatever&code=9780000000002",
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, "session_expired");
  assert.match(body.loginUrl, /^\/login/);

  const { jar: j2 } = await login(app.base, email);
  await patchSess(j2, { adminLastActivity: Date.now() - 9 * H });
  const lookup = await get(app.base, j2, "/admin/inventory/lookup?isbn=9780306406157", { accept: "application/json" });
  assert.equal(lookup.status, 401);
  assert.equal((await lookup.json()).error, "session_expired");
});

test("a till-only account has the same limits", async () => {
  const email = `as-till-${Date.now()}@example.test`;
  await createUser(email, { isTill: true });
  const { jar } = await login(app.base, email);
  assert.equal((await get(app.base, jar, "/admin/till")).status, 200);
  await patchSess(jar, { adminLastActivity: Date.now() - 9 * H });
  assert.equal((await get(app.base, jar, "/admin/till")).status, 303);
});

test("promoted to admin mid-session: the rule applies from that moment", async () => {
  const email = `as-promo-${Date.now()}@example.test`;
  const id = await createUser(email, { isMember: true });
  const { jar } = await login(app.base, email);
  assert.equal((await readSess(jar)).adminLoginAt, undefined);
  await pool.query("UPDATE users SET is_admin = TRUE WHERE id = $1", [id]);
  assert.equal((await get(app.base, jar, "/admin")).status, 200);
  let sess = await readSess(jar);
  for (let i = 0; i < 50 && !(sess.adminLoginAt > 0); i++) { await new Promise((r) => setTimeout(r, 100)); sess = await readSess(jar); }
  assert.ok(sess.adminLoginAt > Date.now() - 60000, "clocks start now");
  await patchSess(jar, { adminLastActivity: Date.now() - 9 * H });
  assert.equal((await get(app.base, jar, "/admin")).status, 303);
});

test("2FA flow is untouched: a pending two-step login is not an admin session", async () => {
  const res = await fetch(`${app.base}/login/2fa`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/login");
});

test("environment override: ADMIN_SESSION_MAX_DAYS=1 applies, a bad IDLE value falls back to 8 hours", async () => {
  const email = `as-env-${Date.now()}@example.test`;
  process.env.DATABASE_URL = shortApp.databaseUrl;
  const { Pool } = require("pg");
  const shortPool = new Pool({ connectionString: shortApp.databaseUrl });
  try {
    const hash = await bcrypt.hash(PASSWORD, 4);
    await shortPool.query("INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ($1, $2, 'Env', TRUE)", [email, hash]);
    const { jar } = await login(shortApp.base, email);
    const sid = sidOf(jar);
    const patch = (p) => shortPool.query("UPDATE session SET sess = (sess::jsonb || $2::jsonb)::json WHERE sid = $1", [sid, JSON.stringify(p)]);
    await patch({ adminLoginAt: Date.now() - 2 * D });
    assert.equal((await get(shortApp.base, jar, "/admin")).status, 303, "older than 1 day");

    const { jar: j2 } = await login(shortApp.base, email);
    const sid2 = sidOf(j2);
    await shortPool.query("UPDATE session SET sess = (sess::jsonb || $2::jsonb)::json WHERE sid = $1", [sid2, JSON.stringify({ adminLastActivity: Date.now() - 7 * H })]);
    assert.equal((await get(shortApp.base, j2, "/admin")).status, 200, "bad idle value ignored: 8 hours");
    await shortPool.query("UPDATE session SET sess = (sess::jsonb || $2::jsonb)::json WHERE sid = $1", [sid2, JSON.stringify({ adminLastActivity: Date.now() - 9 * H })]);
    assert.equal((await get(shortApp.base, j2, "/admin")).status, 303);
  } finally {
    await shortPool.end();
    process.env.DATABASE_URL = app.databaseUrl;
  }
});
