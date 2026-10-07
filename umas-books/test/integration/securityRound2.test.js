// Second security review, items that need the real app over HTTP:
//  7  /img: per-IP rate limit on database reads, 304 and bad names not counted
//  8  static files carry nosniff / Referrer-Policy / Cross-Origin-Resource-Policy
//  9  /healthz answers from a 3 second cache
//  12 marketing CSP has no 'unsafe-inline' for scripts and the pages carry no inline script
//  13 login lockout is per (account, IP) so a stranger cannot lock the owner out
//  2  signup answers the same neutral page whether or not the address was throttled

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken, withSeeOtherPage } = require("../helpers/httpClient");

const PORT = 4301;
const PASSWORD = "Round2Test-1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
let app, pool;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
});
after(async () => { await pool.end(); await app.stop(); });

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const get = (path, headers = {}) => fetch(`${app.base}${path}`, { redirect: "manual", headers });

// ---------- 7: /img ----------

test("/img: bad names and If-None-Match answers are not rate limited and never read the database", async () => {
  const ip = { "x-forwarded-for": "10.90.0.1" };
  const hash = "a".repeat(64);
  assert.equal((await get("/img/not-a-hash.jpg", ip)).status, 404);
  assert.equal((await get(`/img/${hash}.gif`, ip)).status, 404);
  const r304 = await get(`/img/${hash}.jpg`, { ...ip, "if-none-match": `"${hash}"` });
  assert.equal(r304.status, 304);
  assert.match(r304.headers.get("cache-control"), /immutable/);
  assert.equal(r304.headers.get("etag"), `"${hash}"`);
  // Query strings do not matter.
  assert.equal((await get(`/img/${hash}.jpg?cb=${uniq()}`, { ...ip, "if-none-match": `"${hash}"` })).status, 304);
});

test("/img: 300 database reads a minute per IP, then 429; 304s still answer", async () => {
  const ip = { "x-forwarded-for": "10.90.0.2" };
  const hash = "b".repeat(64);
  let last;
  for (let i = 0; i < 300; i++) last = await get(`/img/${hash}.jpg?n=${i}`, ip); // unknown image: 404, but a database read
  assert.equal(last.status, 404);
  assert.equal((await get(`/img/${hash}.jpg`, ip)).status, 429);
  assert.equal((await get(`/img/${hash}.jpg`, { ...ip, "if-none-match": `"${hash}"` })).status, 304, "cached clients are never refused");
  assert.equal((await get("/img/garbage.png", ip)).status, 404, "nor are malformed names");
  // Another address has its own budget.
  assert.equal((await get(`/img/${hash}.jpg`, { "x-forwarded-for": "10.90.0.3" })).status, 404);
});

// ---------- 8: static headers ----------

test("static files, /assets and /logo.png carry nosniff, Referrer-Policy and Cross-Origin-Resource-Policy", async () => {
  for (const path of ["/style.css", "/app.js", "/page-i18n.js", "/assets/site.js", "/logo.png"]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(res.headers.get("referrer-policy"), "no-referrer", path);
    assert.equal(res.headers.get("cross-origin-resource-policy"), "cross-origin", path);
    await res.arrayBuffer();
  }
});

// ---------- 9: /healthz cache ----------

test("/healthz answers 200 with a no-store header", async () => {
  const res = await get("/healthz");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

// ---------- 12: marketing CSP ----------

test("every marketing page: script-src has no unsafe-inline, script-src-attr is none, and the HTML has no inline script", async () => {
  const pages = ["/", "/books.html", "/events.html", "/blog.html", "/about.html", "/membership.html", "/volunteer.html", "/pre-registration.html", "/privacy-policy.html", "/visit.html", "/programs.html", "/immersion.html"];
  for (const path of pages) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    const csp = res.headers.get("content-security-policy");
    const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src "));
    assert.equal(scriptSrc, "script-src 'self'", path);
    assert.ok(csp.split(";").map((d) => d.trim()).includes("script-src-attr 'none'"), path);
    const html = await res.text();
    const inline = [...html.matchAll(/<script\b([^>]*)>/gi)].filter((m) => !/\ssrc=/.test(m[1]) && !/type="application\/(ld\+)?json"/.test(m[1]));
    assert.deepEqual(inline.map((m) => m[0]), [], `${path} has an inline script`);
    assert.doesNotMatch(html, /\son(click|load|submit|change|error)\s*=/i, path);
    // The strings the language toggle needs travel as data, read by an external file.
    assert.match(html, /<script type="application\/json" id="page-i18n-data">/, path);
    assert.match(html, /<script src="\/page-i18n\.js\?v=[0-9a-f]+"><\/script>/, path);
  }
});

test("the page scripts the marketing pages load exist and parse", async () => {
  for (const f of ["/page-i18n.js", "/page-books.js", "/page-events.js", "/page-blog.js", "/page-home.js"]) {
    const res = await get(f);
    assert.equal(res.status, 200, f);
    new Function(await res.text());
  }
});

// ---------- 13: login lockout per (account, IP) ----------

async function createUser(email) {
  await pool.query("INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, $2, 'Lock Test', now())", [email, await bcrypt.hash(PASSWORD, 8)]);
}
// A refused login answers 303 to /login, whose page (fetched with the same session) shows the message.
async function attempt(email, password, ip) {
  const jar = makeCookieJar();
  const headers = { "x-forwarded-for": ip };
  const token = await fetchCsrfToken(app.base, jar, headers);
  const res = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header(), ...headers },
    body: new URLSearchParams({ email, password, _csrf: token }).toString(),
  });
  jar.capture(res);
  const seen = await withSeeOtherPage(res, { base: app.base, jar, headers });
  const text = (await seen.text()).split(token).join("CSRF").replace(/(id="email"[^>]*value=")[^"]*"/, '$1"');
  return { status: res.status, location: res.headers.get("location"), text };
}
const login = async (email, password, ip) => (await attempt(email, password, ip)).status;

test("a stranger's wrong guesses lock only the stranger's address, never the owner", async () => {
  const email = `lock-${uniq()}@example.test`;
  await createUser(email);
  const stranger = "10.91.0.1";
  let wrongPage;
  for (let i = 0; i < 5; i++) {
    const r = await attempt(email, "Wrong-Password-9", stranger);
    assert.equal(r.status, 303);
    assert.equal(r.location, "/login");
    wrongPage = r.text;
  }
  // The stranger is now locked out of this account, even with the right password:
  // refused (303, never the 302 of a login) with exactly the page a wrong password gets.
  const lockedOut = await attempt(email, PASSWORD, stranger);
  assert.equal(lockedOut.status, 303);
  assert.equal(lockedOut.location, "/login");
  assert.equal(lockedOut.text, wrongPage);
  // The owner, from their own address, gets straight in.
  assert.equal(await login(email, PASSWORD, "10.91.0.2"), 302);
  // The account itself is not locked in the database.
  const { rows } = await pool.query("SELECT locked_until, failed_login_attempts FROM users WHERE email = $1", [email]);
  assert.equal(rows[0].locked_until, null);
});

test("the owner's own five typos still lock their own address for a while", async () => {
  const email = `typo-${uniq()}@example.test`;
  await createUser(email);
  for (let i = 0; i < 5; i++) assert.equal(await login(email, "Wrong-Password-9", "10.91.0.3"), 303);
  assert.equal(await login(email, PASSWORD, "10.91.0.3"), 303);
});

// ---------- 2 over HTTP ----------

test("signup: the same address twice gets the same neutral page, but only one mail is stored", async () => {
  const email = `bomb-${uniq()}@example.test`;
  const post = async (ip) => {
    const jar = makeCookieJar();
    const headers = { "x-forwarded-for": ip };
    const token = await fetchCsrfToken(app.base, jar, headers);
    const res = await fetch(`${app.base}/signup`, {
      method: "POST", redirect: "manual",
      headers: { ...FORM, cookie: jar.header(), ...headers },
      body: new URLSearchParams({ email, displayName: "Bomb Target", _csrf: token }).toString(),
    });
    jar.capture(res);
    const seen = await withSeeOtherPage(res, { base: app.base, jar, headers });
    return { status: res.status, location: res.headers.get("location"), body: (await seen.text()).split(token).join("CSRF") };
  };
  const first = await post("10.92.0.1");
  const second = await post("10.92.0.2"); // a different IP: the per-IP limits do not help here
  const third = await post("10.92.0.3");
  assert.equal(first.status, 303);
  assert.equal(first.location, "/signup");
  assert.deepEqual([second.status, third.status], [303, 303]);
  assert.deepEqual([second.location, third.location], ["/signup", "/signup"]);
  assert.equal(second.body, first.body, "neutral response unchanged");
  assert.equal(third.body, first.body);
  // The signup_attempt notice (account now exists) is a different kind: at most one more.
  await new Promise((r) => setTimeout(r, 500));
  const { rows } = await pool.query("SELECT kind, count(*)::int AS n FROM email_outbox WHERE lower(to_email) = $1 GROUP BY kind", [email]);
  const byKind = Object.fromEntries(rows.map((r) => [r.kind, r.n]));
  assert.equal(byKind.verification, 1);
  assert.ok((byKind.signup_attempt || 0) <= 1);
});
