// Tier 2B: cut per-visitor database work. Covers
//  - the CSRF token being created lazily (no session row for form-less pages),
//  - /api/session's JSON shape (cartCount folded in),
//  - sessions being refreshed at most daily, not on every request,
//  - compression and cache headers.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3440;

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

async function sessionRowCount() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM session");
  return rows[0].n;
}

test("cookieless GETs of a form-less page and of /api/session create no session row", async () => {
  // connect-pg-simple creates the `session` table lazily on first use; one
  // throwaway session makes sure it exists before counting rows.
  await fetchCsrfToken(app.base, makeCookieJar());
  const before = await sessionRowCount();
  for (const path of ["/about.html", "/api/session", "/api/books/genres", "/api/events/upcoming"]) {
    const res = await fetch(`${app.base}${path}`);
    assert.equal(res.status, 200, path);
    await res.arrayBuffer();
    assert.equal(res.headers.getSetCookie().length, 0, `${path} must not set a cookie`);
  }
  assert.equal(await sessionRowCount(), before);
});

test("a page with a form still gets a working CSRF token", async () => {
  const jar = makeCookieJar();
  const page = await fetch(`${app.base}/login`);
  jar.capture(page);
  const html = await page.text();
  const m = html.match(/name="_csrf" value="([0-9a-f]{64})"/);
  assert.ok(m, "login form should render a real token, not '[object Object]'");
  assert.ok(jar.header().includes("umasbooks.sid="), "rendering a token must start a session");

  // The rendered token is the one the session holds: /api/csrf-token agrees.
  assert.equal(await fetchCsrfToken(app.base, jar), m[1]);

  const post = (body) => fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body,
  });
  assert.equal((await post("email=nobody%40example.test&password=x")).status, 403, "POST without token is rejected");
  const ok = await post(`email=nobody%40example.test&password=x&_csrf=${m[1]}`);
  assert.notEqual(ok.status, 403, "POST with the rendered token passes CSRF");
});

test("/api/csrf-token works for a cookieless client and sets up a session", async () => {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.ok(jar.header().includes("umasbooks.sid="));
});

test("/api/session returns the logged-out shape including cartCount", async () => {
  const res = await fetch(`${app.base}/api/session`);
  assert.deepEqual(await res.json(), {
    cartCount: 0, loggedIn: false, isMember: false, isVolunteer: false, isAdmin: false,
  });
});

test("an existing session is not touched on every request, but is refreshed once it is a day old", async () => {
  const jar = makeCookieJar();
  await fetchCsrfToken(app.base, jar);
  const sid = decodeURIComponent(jar.header().split("umasbooks.sid=")[1].split(";")[0]).slice(2).split(".")[0];
  const expireOf = async () => (await pool.query("SELECT extract(epoch FROM expire) AS e FROM session WHERE sid = $1", [sid])).rows[0].e;

  // Backdate: pretend it was last saved 10 days ago (20 days left).
  const DAY = 86400;
  const backdated = Math.floor(Date.now() / 1000) + 20 * DAY;
  await pool.query(
    `UPDATE session SET expire = to_timestamp($1),
       sess = jsonb_set(sess::jsonb, '{cookie,expires}', to_jsonb(to_char(to_timestamp($1) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.000"Z"')))::json
     WHERE sid = $2`, [backdated, sid]);

  // First request after backdating: refreshes the expiry (one save).
  // (Read the body: express-session only finishes the response after its
  // save completes, so a fully read body means the write has landed.)
  await (await fetch(`${app.base}/api/session`, { headers: { cookie: jar.header() } })).arrayBuffer();
  const refreshed = await expireOf();
  assert.ok(refreshed > backdated + 9 * DAY, "a >1-day-old session is extended");

  // Further requests the same day must not write again.
  for (let i = 0; i < 3; i++) await (await fetch(`${app.base}/api/session`, { headers: { cookie: jar.header() } })).arrayBuffer();
  assert.equal(await expireOf(), refreshed, "no per-request touch");
});

test("responses are gzip-compressed when the client accepts it", async () => {
  const res = await fetch(`${app.base}/about.html`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-encoding"), "gzip");
  await res.arrayBuffer();
});

test("cache headers: public JSON and static assets cacheable, per-user endpoints never", async () => {
  const cc = async (path) => {
    const res = await fetch(`${app.base}${path}`);
    await res.arrayBuffer();
    return res.headers.get("cache-control") || "";
  };
  assert.equal(await cc("/api/events/upcoming"), "public, max-age=60");
  assert.equal(await cc("/api/books/latest-arrivals"), "public, max-age=60");
  assert.equal(await cc("/api/books/search?q=a"), "public, max-age=60");
  assert.equal(await cc("/api/books/genres"), "public, max-age=300");
  assert.equal(await cc("/api/books/recommendation"), "public, max-age=300");
  assert.equal(await cc("/api/blog/posts"), "public, max-age=300");
  assert.match(await cc("/assets/site.js"), /max-age=604800/);

  for (const path of ["/api/session", "/api/csrf-token", "/api/cart/count"]) {
    const value = await cc(path);
    assert.ok(!/public/.test(value), `${path} must not be publicly cacheable (got "${value}")`);
    assert.match(value, /no-store/, path);
  }
});
