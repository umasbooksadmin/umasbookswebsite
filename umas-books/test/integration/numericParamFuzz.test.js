// Generic guard: no numeric-looking input may turn a GET into a 5xx.
//
// A 5xx is also an alert email (errorHandler only silences 4xx), and an
// anonymous visitor could otherwise burn the 6-alerts-per-15-minutes budget
// and hide a real incident. Every GET route that is registered in src/routes
// (public) or src/routes/admin is hit with hostile values in every path
// segment and in every common numeric query parameter, as a scalar and as a
// repeated parameter (?x=1&x=2), and must answer below 500.
//
// The route list comes from the source, so a NEW public route is fuzzed
// automatically; the exemption list below is the only place to opt out.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar } = require("../helpers/httpClient");
const { createAccount, loginOverHttp } = require("../helpers/accounts");

const HOSTILE = ["1e22", "-1", "0", "2147483648", "99999999999999999999", "abc", "1e21", "0x10", "1.5", "%20", "NaN", "Infinity", "%5B%5D", "9".repeat(60)];
// Common names for a number or a free-text search in this app's query strings.
const NAMES = ["offset", "limit", "days", "page", "ids", "id", "q", "topic", "genre", "n", "view", "month", "year", "date", "from", "to", "week", "start", "end", "day", "type", "sort", "edit", "book", "copyId", "requests", "cleared", "was", "now", "undone", "skipped", "calcCopies", "calcMarket", "linkPayment", "linkQ", "test", "saved", "voided", "period", "dateRange", "status", "role"];

// Every query-string name the source reads, found by scanning src/ for `query.X`, `req.query.X`, `req.query["X"]`
// and `q.X`: a NEW parameter is fuzzed (as text) without anyone remembering to add it to NAMES above.
function harvestQueryNames() {
  const names = new Set();
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) { walk(full); continue; }
      if (!f.name.endsWith(".js")) continue;
      const src = fs.readFileSync(full, "utf8");
      for (const m of src.matchAll(/\b(?:query|q)\.([A-Za-z_]\w*)/g)) names.add(m[1]);
      for (const m of src.matchAll(/\bquery\[\s*["']([A-Za-z_]\w*)["']\s*\]/g)) names.add(m[1]);
    }
  };
  walk(path.join(__dirname, "..", "..", "src"));
  for (const n of ["length", "constructor", "toString", "__proto__", "hasOwnProperty"]) names.delete(n);
  return [...names];
}
const ALL_NAMES = [...new Set([...NAMES, ...harvestQueryNames(), "lang", "returnTo", "preview", "notice", "error", "order", "format", "kind", "pattern", "filter", "category", "tab", "panel", "binding", "isbn", "condition", "dest", "find", "added", "roleNotice", "linkNotice", "emailTaken", "pinnedOnly", "dateRange", "none", "stale", "v"])];

// Routes that reach the network or are not about parameters (a lookup calls
// outside APIs; the rest need nothing numeric).
const EXEMPT = [/\/lookup/, /isbndb-price/, /price-suggestion/, /\/logout/, /\/diagnostics\//];

const ROUTES_DIR = path.join(__dirname, "..", "..", "src", "routes");
function routePaths(dir, filter) {
  const out = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of src.matchAll(/router\.get\(\s*"([^"]+)"/g)) if (filter(m[1])) out.add(m[1]);
  }
  return [...out].filter((p) => !EXEMPT.some((re) => re.test(p))).sort();
}
const publicRoutes = routePaths(ROUTES_DIR, (p) => !p.startsWith("/admin"));

// The routes the running app really has, read from its Express router stack (a route added with app.get in
// src/app.js, or built from a loop, is not in a router.get("...") literal). Added to the lists above in before().
function stackGetPaths(layers, out = new Set()) {
  for (const layer of layers || []) {
    if (layer.route && layer.route.methods && layer.route.methods.get && typeof layer.route.path === "string") out.add(layer.route.path);
    else if (layer.handle && Array.isArray(layer.handle.stack)) stackGetPaths(layer.handle.stack, out);
  }
  return out;
}
const adminRoutes = routePaths(path.join(ROUTES_DIR, "admin"), (p) => p.startsWith("/admin"));

let counter = 100;
const freshIp = () => `198.51.${Math.floor(counter / 250) % 250}.${(counter++ % 250) + 1}`;

function urlsFor(route, valueList) {
  const urls = [];
  for (const v of valueList) {
    const p = route.replace(/:[A-Za-z]+/g, v);
    urls.push(`${p}?paged=1&${NAMES.map((n) => `${n}=${v}`).join("&")}`);
    urls.push(p);
  }
  // Repeated parameters and bracket forms.
  const p1 = route.replace(/:[A-Za-z]+/g, "1");
  urls.push(`${p1}?${NAMES.map((n) => `${n}=1&${n}=2`).join("&")}`);
  urls.push(`${p1}?${NAMES.map((n) => `${n}[]=1&${n}[a]=2`).join("&")}`);
  urls.push(`${p1}?${NAMES.map((n) => `${n}=`).join("&")}`);
  return urls;
}

async function fuzz(base, routes, cookie, label, urlBuilder = (r) => urlsFor(r, HOSTILE)) {
  const failures = [];
  const bodyOf = new Map();
  let sent = 0;
  const queue = routes.flatMap((r) => urlBuilder(r));
  // At most 4 requests at a time.
  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      const res = await fetch(`${base}${url}`, { redirect: "manual", headers: { "x-forwarded-for": `${freshIp()}, 172.70.0.1`, ...(cookie ? { cookie } : {}) } });
      const text = await res.text();
      sent++;
      if (res.status >= 500 || res.status === 429) { failures.push(`${res.status} ${url.slice(0, 90)}`); bodyOf.set(url, text.slice(0, 120)); }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  assert.ok(sent > 100, `${label}: expected to send many requests, sent ${sent}`);
  assert.equal(failures.length, 0, `${label}: ${failures.length} request(s) answered 5xx or 429:\n${failures.slice(0, 12).join("\n")}`);
}

// Text-shaped hostile values for EVERY harvested name, in chunks (a URL has a length limit): a repeated parameter
// (an array in Express 5), the bracket forms (literal keys with the simple parser), an over-long value, a NUL,
// and a value that looks like markup. `idValue` fills each :param of the path.
function stringUrlsFor(route, idValue) {
  const p = route.replace(/:[A-Za-z]+/g, idValue);
  const urls = [];
  const chunk = 30;
  const long = "x".repeat(3000);
  for (let i = 0; i < ALL_NAMES.length; i += chunk) {
    const names = ALL_NAMES.slice(i, i + chunk);
    urls.push(`${p}?${names.map((n) => `${n}=a&${n}=b`).join("&")}`);
    urls.push(`${p}?${names.map((n) => `${n}[]=a&${n}[a]=b&${n}[][x]=c`).join("&")}`);
    urls.push(`${p}?${names.map((n) => `${n}=${long.slice(0, 400)}`).join("&")}`);
    urls.push(`${p}?${names.map((n) => `${n}=%00a%00&${n}=%3Cb%3E`).join("&")}`);
  }
  urls.push(`${p}?${"a=1&".repeat(500)}genre=x`);
  urls.push(`${p}?genre=${long}`);
  return urls;
}

let pub;
let bookId = "1";
before(async () => {
  pub = await startTestApp({ port: 7731, isolated: true, env: { TRUST_PROXY_HOPS: "2" } });
  // A real in-stock book, so /books/:id (and the other detail pages) get past their 404 and run their query handling.
  const { Client } = require("pg");
  const client = new Client({ connectionString: pub.databaseUrl });
  await client.connect();
  const { rows } = await client.query("INSERT INTO books (title, authors) VALUES ('Fuzz Book', 'Fuzz Author') RETURNING id");
  await client.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', 5)", [rows[0].id]);
  await client.end();
  process.env.DATABASE_URL = pub.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-not-for-production";
  const app = require("../../src/app").createApp();
  for (const p of stackGetPaths(app.router.stack)) {
    if (EXEMPT.some((re) => re.test(p)) || /[*(]/.test(p)) continue;
    const list = p.startsWith("/admin") ? adminRoutes : publicRoutes;
    if (!list.includes(p)) list.push(p);
  }
  bookId = String(rows[0].id);
});
after(async () => { await pub.stop(); });

test("the public route list is discovered from the source", () => {
  assert.ok(publicRoutes.includes("/healthz"), "routes registered with app.get in src/app.js are found through the router stack");
  for (const must of ["/books/:id", "/api/books/search", "/api/books/by-ids", "/api/books/new-in", "/events/:id/ics", "/img/:file", "/collections/:slug"]) {
    assert.ok(publicRoutes.includes(must), `${must} should be among the fuzzed public routes`);
  }
});

test("no public GET route answers 5xx to hostile numbers, repeated parameters or brackets", async () => {
  await fuzz(pub.base, publicRoutes, null, "public");
});

test("no public GET route answers 5xx to a repeated, bracketed, long or NUL string parameter (the Express 5 array case)", async () => {
  await fuzz(pub.base, publicRoutes, null, "public strings", (r) => stringUrlsFor(r, r.includes("/books/:id") ? bookId : "1"));
});

test("GET /books/:id?genre=a&genre=b is a normal page and sends no alert (regression: .trim is not a function)", async () => {
  for (const q of ["genre=a&genre=b", "genre[]=a", "genre[a]=b", "genre="]) {
    const res = await fetch(`${pub.base}/books/${bookId}?${q}`, { headers: { "x-forwarded-for": `${freshIp()}, 172.70.0.1` } });
    assert.equal(res.status, 200, q);
    assert.match(await res.text(), /Fuzz Book/);
  }
});

test("no admin GET route answers 5xx to hostile numbers, repeated parameters or brackets", async () => {
  process.env.DATABASE_URL = pub.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  const { pool } = require("../../src/db");
  try {
    const admin = await createAccount(pool, { email: `fuzz-admin-${Date.now()}@example.test`, displayName: "Fuzz Admin" });
    await pool.query("UPDATE users SET is_admin = true WHERE id = $1", [admin.id]);
    const jar = makeCookieJar();
    const res = await loginOverHttp(pub.base, jar, admin, { "x-forwarded-for": "198.51.100.1, 172.70.0.1" });
    assert.equal(res.status, 302);
    await fuzz(pub.base, adminRoutes, jar.header(), "admin");
    await fuzz(pub.base, adminRoutes, jar.header(), "admin strings", (r) => stringUrlsFor(r, r.includes("/inventory/:id") ? bookId : "1"));
  } finally {
    await pool.end();
  }
});
