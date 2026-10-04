// External-audit reliability fixes that need the real app: the marketing CSP
// must let the HelloAsso membership widget iframe load (it had no frame-src,
// so default-src 'self' blocked it), and /api/favorites/toggle must treat
// only the client's exact "1" as "add" (Boolean("false") is true).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3500;
const PASSWORD = "Audit-Reliab-1!";

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
  app.stop();
});

function frameSrc(csp) {
  const directive = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("frame-src"));
  return directive ? directive.split(/\s+/).slice(1) : null;
}

test("/membership.html CSP allows the HelloAsso widget frame, and only that", async () => {
  const res = await fetch(`${app.base}/membership.html`);
  assert.equal(res.status, 200);
  const sources = frameSrc(res.headers.get("content-security-policy"));
  assert.ok(sources, "marketing CSP has a frame-src");
  assert.deepEqual(sources, ["https://www.helloasso.com"]);
  // The iframe in the page really points at that origin.
  assert.match(await res.text(), /<iframe[^>]+src="https:\/\/www\.helloasso\.com\//);
});

test("the app's own (non-marketing) CSP does not gain a HelloAsso frame-src", async () => {
  const res = await fetch(`${app.base}/login`);
  const csp = res.headers.get("content-security-policy") || "";
  // (form-action does list HelloAsso's payment pages: see cspFormAction.test.js)
  assert.equal(frameSrc(csp), null, csp);
  assert.ok(!/frame-src[^;]*helloasso/.test(csp), csp);
});

async function loginJar(email) {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header(), "x-forwarded-for": "10.50.0.1" },
    body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent(PASSWORD)}&_csrf=${token}`,
  });
  jar.capture(res);
  assert.equal(res.status, 302);
  return jar;
}

test("favorites toggle: only isFavorite=1 adds; false/0/empty/missing do not", async () => {
  const email = `fav-${Date.now()}@example.test`;
  const { rows: u } = await pool.query(
    "INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, $2, 'Fav', now()) RETURNING id",
    [email, await bcrypt.hash(PASSWORD, 10)]
  );
  const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ('Fav Book', 'A') RETURNING id");
  const jar = await loginJar(email);

  async function toggle(isFavorite) {
    const token = await fetchCsrfToken(app.base, jar);
    const body = new URLSearchParams({ bookId: String(b[0].id), _csrf: token });
    if (isFavorite !== undefined) body.set("isFavorite", isFavorite);
    const res = await fetch(`${app.base}/api/favorites/toggle`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
      body: body.toString(),
    });
    assert.equal(res.status, 204);
    const { rows } = await pool.query("SELECT 1 FROM favorites WHERE user_id = $1 AND book_id = $2", [u[0].id, b[0].id]);
    return rows.length === 1;
  }

  for (const bad of ["false", "0", "", undefined]) {
    assert.equal(await toggle(bad), false, `isFavorite=${JSON.stringify(bad)} must not add a favourite`);
  }
  assert.equal(await toggle("1"), true, "isFavorite=1 adds");
  assert.equal(await toggle(""), false, "isFavorite= (empty) removes, as public/favorites.js sends it");
});
