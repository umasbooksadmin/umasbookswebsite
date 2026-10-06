// The emailed confirmation link is safe against mail scanners and abuse:
//  - GET only shows a "Confirm my email" button and consumes nothing (Outlook
//    SafeLinks / antivirus open every link in a message);
//  - the work happens on the POST (CSRF protected), with the same outcome as
//    before: verified, sessions killed, redirect to choose a password;
//  - an invalid/used link offers a new confirmation link and "Forgot your password?";
//  - the unusable password hash is computed once at startup, not per request;
//  - GET and POST are rate limited per IP.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 4103;
let app;
let pool;
let n = 0;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
});
after(async () => {
  await pool.end();
  app.stop();
});

let ipSeq = 0;
const ip = () => `10.88.${(++ipSeq >> 8) & 255}.${ipSeq & 255}`;

async function pendingAccount() {
  const raw = `scanner-test-${Date.now()}-${++n}`;
  const email = `scan-${Date.now()}-${n}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, first_verification_pending)
     VALUES ($1, 'x', 'Scan Test', TRUE) RETURNING id`, [email]);
  await pool.query(
    "INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [rows[0].id, crypto.createHash("sha256").update(raw).digest("hex")]);
  return { id: rows[0].id, email, raw };
}
const userRow = async (id) => (await pool.query("SELECT email_verified_at, password_hash FROM users WHERE id = $1", [id])).rows[0];
const tokenUsed = async (id) => (await pool.query("SELECT used_at FROM email_verification_tokens WHERE user_id = $1", [id])).rows[0].used_at;

test("GET shows the button and consumes nothing, however often a scanner opens it", async () => {
  const a = await pendingAccount();
  const headers = { "x-forwarded-for": ip() };
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${app.base}/verify-email/${a.raw}`, { headers });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Confirm my email/);
    assert.match(html, new RegExp(`<form[^>]+method="post"[^>]+action="/verify-email/${a.raw}"`));
    assert.match(html, /name="_csrf"/);
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
  assert.equal(await tokenUsed(a.id), null, "token still unused");
  assert.equal((await userRow(a.id)).email_verified_at, null, "account still unconfirmed");
});

test("the button's POST verifies, kills sessions, and redirects to choose a password; reuse is refused", async () => {
  const a = await pendingAccount();
  const jar = makeCookieJar();
  const headers = { "x-forwarded-for": ip() };
  const token = await fetchCsrfToken(app.base, jar, headers);
  const post = (t) => fetch(`${app.base}/verify-email/${a.raw}`, {
    method: "POST", redirect: "manual",
    headers: { cookie: jar.header(), "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(t ? { _csrf: t } : {}).toString(),
  });
  assert.equal((await post(null)).status, 403, "no CSRF token, no confirmation");
  assert.equal(await tokenUsed(a.id), null);

  const res = await post(token);
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /^\/reset-password\/[0-9a-f]+\?confirmed=1$/);
  const row = await userRow(a.id);
  assert.ok(row.email_verified_at);
  assert.notEqual(row.password_hash, "x");
  const { rows } = await pool.query("SELECT password_changed_at FROM users WHERE id = $1", [a.id]);
  assert.ok(rows[0].password_changed_at, "sessions are killed via password_changed_at");

  const again = await post(token);
  assert.equal(again.status, 400);
  const html = await again.text();
  assert.match(html, /Request a new confirmation link/);
});

test("the unusable password hash is computed once at startup, not per confirmation", async () => {
  const [a, b] = [await pendingAccount(), await pendingAccount()];
  for (const acct of [a, b]) {
    const jar = makeCookieJar();
    const headers = { "x-forwarded-for": ip() };
    const page = await (await fetch(`${app.base}/verify-email/${acct.raw}`, { headers })).text();
    // fetch the csrf-bound session via the API instead of the page (cookie jar needed)
    const token = await fetchCsrfToken(app.base, jar, headers);
    assert.match(page, /Confirm my email/);
    const res = await fetch(`${app.base}/verify-email/${acct.raw}`, {
      method: "POST", redirect: "manual",
      headers: { cookie: jar.header(), "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ _csrf: token }).toString(),
    });
    assert.equal(res.status, 302);
  }
  assert.equal((await userRow(a.id)).password_hash, (await userRow(b.id)).password_hash, "one precomputed hash, not one bcrypt per request");
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "routes", "auth.js"), "utf8");
  const handlers = src.slice(src.indexOf('router.get("/verify-email/:token"'), src.indexOf('router.post("/resend-verification"'));
  assert.doesNotMatch(handlers, /bcrypt\.hash\(/, "no bcrypt.hash inside the verify-email handlers");
});

test("an invalid link page offers a new confirmation link and the forgot-password link (EN and FR)", async () => {
  const headers = { "x-forwarded-for": ip() };
  const en = await fetch(`${app.base}/verify-email/nope`, { headers });
  assert.equal(en.status, 400);
  const enHtml = await en.text();
  assert.match(enHtml, /Request a new confirmation link/);
  assert.match(enHtml, /action="\/resend-verification"/);
  assert.match(enHtml, /name="_csrf"/);
  assert.match(enHtml, /href="\/forgot-password"[^>]*>Forgot your password\?/);
  const fr = await fetch(`${app.base}/verify-email/nope`, { headers: { ...headers, cookie: "umasbooks_lang=fr" } });
  const frHtml = await fr.text();
  assert.match(frHtml, /Demander un nouveau lien de confirmation/);
  assert.match(frHtml, /Mot de passe oublié/);
});

test("GET and POST share a per-IP limiter", async () => {
  const headers = { "x-forwarded-for": ip() };
  let last;
  for (let i = 0; i < 31; i++) last = await fetch(`${app.base}/verify-email/nope-${i}`, { headers });
  assert.equal(last.status, 429);
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar, headers);
  const post = await fetch(`${app.base}/verify-email/nope`, {
    method: "POST", redirect: "manual",
    headers: { ...headers, cookie: jar.header(), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: token }).toString(),
  });
  assert.equal(post.status, 429, "the POST counts against the same bucket");
  const other = await fetch(`${app.base}/verify-email/nope`, { headers: { "x-forwarded-for": ip() } });
  assert.equal(other.status, 400, "another IP is unaffected");
});
