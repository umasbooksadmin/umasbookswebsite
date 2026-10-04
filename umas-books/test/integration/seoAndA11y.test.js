// Production-review fixes: robots.txt / sitemap.xml, per-page SEO metadata on
// the marketing pages, and the markup-level accessibility fixes (alert/status
// roles, autocomplete tokens, iframe title).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");
const MARKETING_PAGES = require("../../src/lib/marketingPages");

const PORT = 3611;
// Set before the app boots (startTestApp passes process.env through): the
// SEO URLs must come from this, never from the request's Host header.
const SITE = "https://books.example.test";
process.env.APP_BASE_URL = SITE;

let app;
let pool;
const stamp = Date.now();
let inStockId;
let soldId;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const mk = async (title, status) => {
    const { rows } = await pool.query("INSERT INTO books (title) VALUES ($1) RETURNING id", [title]);
    await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, $2, 5)", [rows[0].id, status]);
    return rows[0].id;
  };
  inStockId = await mk(`Sitemap in stock ${stamp}`, "in_stock");
  soldId = await mk(`Sitemap sold ${stamp}`, "sold");
});

after(async () => {
  await pool.query("DELETE FROM books WHERE id = ANY($1)", [[inStockId, soldId]]);
  await pool.end();
  app.stop();
});

const get = (p, opts) => fetch(`${app.base}${p}`, opts);

test("robots.txt allows crawling, blocks private areas, and points at the sitemap", async () => {
  const res = await get("/robots.txt");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/plain/);
  assert.equal(res.headers.getSetCookie().length, 0, "no session for crawlers");
  const body = await res.text();
  assert.match(body, /^User-agent: \*$/m);
  assert.match(body, /^Allow: \/$/m);
  for (const p of ["/admin", "/account", "/cart", "/login", "/signup", "/api/"]) {
    assert.ok(body.split("\n").includes(`Disallow: ${p}`), `Disallow: ${p}`);
  }
  assert.match(body, new RegExp(`^Sitemap: ${SITE}/sitemap\\.xml$`, "m"));
});

test("robots.txt and sitemap.xml ignore a spoofed Host header", async () => {
  const res = await get("/robots.txt", { headers: { "x-forwarded-host": "evil.test" } });
  assert.doesNotMatch(await res.text(), /evil\.test/);
});

test("sitemap.xml lists marketing pages, /sessions, /events and in-stock books only", async () => {
  const res = await get("/sitemap.xml");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^application\/xml/);
  assert.match(res.headers.get("cache-control"), /max-age=3600/);
  assert.equal(res.headers.getSetCookie().length, 0, "no session for crawlers");
  const xml = await res.text();
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  for (const p of ["/", ...MARKETING_PAGES.map((f) => "/" + f), "/sessions", "/events"]) {
    assert.ok(locs.includes(SITE + p), `sitemap lists ${p}`);
  }
  assert.ok(locs.includes(`${SITE}/books/${inStockId}`), "in-stock book is listed");
  assert.ok(!locs.includes(`${SITE}/books/${soldId}`), "a book with no in-stock copy is not");
  assert.ok(locs.every((l) => l.startsWith(SITE + "/")), "every URL is absolute on the configured base");
  assert.ok(!locs.some((l) => /\/(admin|account|cart|login|signup|api)(\/|$)/.test(l)));
});

test("sitemap.xml is cached for an hour (a book added afterwards is not listed yet)", async () => {
  await get("/sitemap.xml");
  const lateId = await (async () => {
    const { rows } = await pool.query("INSERT INTO books (title) VALUES ($1) RETURNING id", [`Sitemap late ${stamp}`]);
    await pool.query("INSERT INTO book_copies (book_id, status) VALUES ($1, 'in_stock')", [rows[0].id]);
    return rows[0].id;
  })();
  try {
    assert.ok(!(await (await get("/sitemap.xml")).text()).includes(`/books/${lateId}<`));
  } finally {
    await pool.query("DELETE FROM books WHERE id = $1", [lateId]);
  }
});

const PAGES = ["/", ...MARKETING_PAGES.map((f) => "/" + f)];

function meta(html, attr, name) {
  const m = html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`));
  return m ? m[1] : null;
}

test("every marketing page has canonical, Open Graph, Twitter and favicon tags, and a unique description", async () => {
  const descriptions = new Map();
  for (const p of PAGES) {
    const res = await get(p);
    assert.equal(res.status, 200, p);
    const html = await res.text();
    assert.ok(html.includes(`<link rel="canonical" href="${SITE}${p}">`), `${p} canonical`);
    const description = meta(html, "name", "description");
    assert.ok(description && description.length > 40, `${p} has a real meta description`);
    assert.ok(!descriptions.has(description), `${p} description duplicates ${descriptions.get(description)}`);
    descriptions.set(description, p);
    assert.equal(meta(html, "property", "og:description"), description, `${p} og:description`);
    assert.equal(meta(html, "name", "twitter:description"), description, `${p} twitter:description`);
    const title = html.match(/<title>([^<]*)<\/title>/)[1];
    assert.equal(meta(html, "property", "og:title"), title, `${p} og:title`);
    assert.equal(meta(html, "name", "twitter:title"), title, `${p} twitter:title`);
    assert.equal(meta(html, "property", "og:type"), "website");
    assert.equal(meta(html, "property", "og:url"), SITE + p, `${p} og:url`);
    assert.equal(meta(html, "property", "og:image"), `${SITE}/assets/img/logo-stamp-1280x720.png`);
    assert.equal(meta(html, "property", "og:locale"), "en_GB");
    assert.equal(meta(html, "name", "twitter:card"), "summary_large_image");
    assert.match(html, /<link rel="icon" type="image\/png" sizes="32x32" href="\/favicon-32x32\.png">/, `${p} favicon`);
    assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/);
  }
});

test("the home page carries Bookstore JSON-LD built from facts on the site; other pages do not", async () => {
  const html = await (await get("/")).text();
  const m = html.match(/<script type="application\/ld\+json">([^]*?)<\/script>/);
  assert.ok(m, "JSON-LD block present");
  const data = JSON.parse(m[1]);
  assert.equal(data["@type"], "Bookstore");
  assert.equal(data.name, "Uma's Books & Adventures");
  assert.equal(data.url, `${SITE}/`);
  assert.equal(data.address.addressLocality, "Albi");
  assert.equal(data.address.postalCode, "81000");
  assert.equal(data.address.streetAddress, "Rue Peyrolière");
  assert.doesNotMatch(await (await get("/about.html")).text(), /application\/ld\+json/);
});

test("the HelloAsso iframe has a title", async () => {
  const html = await (await get("/membership.html")).text();
  assert.match(html, /<iframe id="haWidget" title="HelloAsso membership form"/);
});

test("login, signup and password forms carry autocomplete tokens", async () => {
  const tag = (html, id) => html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))[0];
  const login = await (await get("/login")).text();
  assert.match(tag(login, "email"), /autocomplete="username"/);
  assert.match(tag(login, "password"), /autocomplete="current-password"/);
  assert.match(login, /data-toggle-password="password" aria-label="Show password" aria-pressed="false"/);

  const signup = await (await get("/signup")).text();
  assert.match(tag(signup, "displayName"), /autocomplete="name"/);
  assert.match(tag(signup, "email"), /autocomplete="email"/);
  assert.ok(!/id="password"/.test(signup), "signup asks for no password (it is chosen after the email is confirmed)");

  const forgot = await (await get("/forgot-password")).text();
  assert.match(tag(forgot, "email"), /autocomplete="email"/);
});

test("an error message on the login form is announced (role=alert)", async () => {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await get("/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: new URLSearchParams({ _csrf: token, email: `nobody-${stamp}@example.test`, password: "wrong-password-1" }),
  });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /<div role="alert" class="error-box">Incorrect email or password\./);
});

test("every .error-box / .notice-box in the app views declares a live-region role", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const offenders = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "marketing") walk(full); continue; }
      if (!full.endsWith(".ejs")) continue;
      const src = fs.readFileSync(full, "utf8");
      for (const m of src.matchAll(/<[a-z0-9]+\b[^>]*class="[^"]*\b(error-box|notice-box)\b[^"]*"[^>]*>/g)) {
        const want = m[1] === "error-box" ? 'role="alert"' : 'role="status"';
        if (!m[0].includes(want)) offenders.push(`${path.relative(process.cwd(), full)}: ${m[0].slice(0, 60)}`);
      }
    }
  })(path.join(__dirname, "..", "..", "views"));
  assert.deepEqual(offenders, []);
});
