// The real app (child process) wiring for the security quick fixes:
// /healthz does not advertise Express, logged-in responses are no-store
// while anonymous marketing pages are not, a malformed URI / oversized
// upload are 400 / 413 with a friendly page (not 500).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3600;

let app;
let pool;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
});
after(async () => {
  await pool.end();
  await app.stop();
});

async function login({ admin = false } = {}) {
  const email = `sechdr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, email_verified_at)
     VALUES ($1, $2, 'Sec Hdr', $3, now())`,
    [email, await bcrypt.hash("Correct-Horse-1", 4), admin]
  );
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: new URLSearchParams({ email, password: "Correct-Horse-1", _csrf: token }).toString(),
  });
  jar.capture(res);
  assert.equal(res.status, 302);
  return jar;
}

test("/healthz does not send X-Powered-By", async () => {
  const res = await fetch(`${app.base}/healthz`);
  await res.text();
  assert.equal(res.headers.get("x-powered-by"), null);
});

test("logged-in responses are no-store; anonymous marketing pages are not", async () => {
  const jar = await login();
  for (const p of ["/account/password", "/about.html"]) {
    const res = await fetch(`${app.base}${p}`, { headers: { cookie: jar.header() }, redirect: "manual" });
    await res.text();
    assert.equal(res.headers.get("cache-control"), "no-store", p);
    assert.equal(res.headers.get("pragma"), "no-cache", p);
  }
  const anon = await fetch(`${app.base}/about.html`);
  await anon.text();
  assert.notEqual(anon.headers.get("cache-control"), "no-store");
  // Static assets stay cacheable even with a session cookie.
  const css = await fetch(`${app.base}/style.css`, { headers: { cookie: jar.header() } });
  await css.text();
  assert.match(css.headers.get("cache-control") || "", /max-age=/);
});

test("a malformed URI is a 400 page, not a 500", async () => {
  const res = await fetch(`${app.base}/books/%E0%A4%A`);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /<h1>/);
});

test("an oversized admin upload is a 413 with a friendly message, not a 500", async () => {
  const jar = await login({ admin: true });
  const token = await fetchCsrfToken(app.base, jar);
  const fd = new FormData();
  fd.append("_csrf", token);
  fd.append("photo", new Blob([Buffer.alloc(9 * 1024 * 1024)]), "big.jpg");
  const res = await fetch(`${app.base}/admin/inventory/scan`, { method: "POST", headers: { cookie: jar.header() }, body: fd });
  assert.equal(res.status, 413);
  assert.match(await res.text(), /too large/i);
});
