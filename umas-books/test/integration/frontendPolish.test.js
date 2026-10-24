// Front-end polish: page metadata + JSON-LD, manifest, caching of static files,
// the empty calendar message, the no-JavaScript list, French typography.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");

const PORT = 4231;
const SITE = "https://books.example.test";
process.env.APP_BASE_URL = SITE;

let app;
let pool;
let bookId;
const stamp = Date.now();

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const { rows } = await pool.query(
    "INSERT INTO books (title, authors, description, cover_url) VALUES ($1, 'Jane Austen', 'A comedy of manners.', '/img/cover-x') RETURNING id",
    [`Polish & "Pride" ${stamp}`]
  );
  bookId = rows[0].id;
  await pool.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 4.5, 'very_good'), ($1, 'in_stock', 9, 'new')", [bookId]);
});

after(async () => {
  await pool.query("DELETE FROM books WHERE id = $1", [bookId]);
  await pool.end();
  app.stop();
});

const get = (p, headers) => fetch(`${app.base}${p}`, { headers });
const meta = (html, attr, name) => (html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`)) || [])[1];

test("book page: description, canonical without the query, og/twitter tags, public title", async () => {
  const html = await (await get(`/books/${bookId}?genre=Fiction`)).text();
  assert.match(html, /<title>Polish &amp; &#34;Pride&#34; \d+ by Jane Austen — Uma&#39;s Books and Adventures<\/title>/);
  assert.doesNotMatch(html, /<title>[^<]*Members/);
  assert.equal(meta(html, "name", "description"), "A comedy of manners.");
  assert.match(html, new RegExp(`<link rel="canonical" href="${SITE}/books/${bookId}">`));
  assert.equal(meta(html, "property", "og:url"), `${SITE}/books/${bookId}`);
  assert.equal(meta(html, "property", "og:type"), "book");
  assert.equal(meta(html, "property", "og:image"), `${SITE}/img/cover-x`);
  assert.equal(meta(html, "property", "og:locale"), "en_GB");
  assert.equal(meta(html, "name", "twitter:card"), "summary");
  assert.ok(meta(html, "property", "og:title").startsWith("Polish"));
});

test("book page JSON-LD is valid JSON with Book + Offers", async () => {
  const html = await (await get(`/books/${bookId}`)).text();
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(m, "JSON-LD present");
  const ld = JSON.parse(m[1]);
  assert.equal(ld["@type"], "Book");
  assert.ok(ld.name.startsWith("Polish"));
  const prices = ld.offers.map((o) => `${o.price} ${o.priceCurrency} ${o.itemCondition.split("/").pop()} ${o.availability.split("/").pop()}`).sort();
  assert.deepEqual(prices, ["4.50 EUR UsedCondition InStock", "9.00 EUR NewCondition InStock"]);
});

test("French book page: og:locale fr_FR, French title suffix, favorites button names the book", async () => {
  const html = await (await get(`/books/${bookId}`, { cookie: "umasbooks_lang=fr" })).text();
  assert.equal(meta(html, "property", "og:locale"), "fr_FR");
  assert.match(html, /<html lang="fr">/);
  assert.match(html, /aria-label="Ajouter Polish[^"]* aux favoris"/);
  const en = await (await get(`/books/${bookId}`)).text();
  assert.match(en, /aria-label="Add Polish[^"]* to favorites"/);
});

test("private pages are noindex and have no canonical/og tags; the 404 page too", async () => {
  for (const p of ["/login", "/cart", "/no-such-page-xyz"]) {
    const html = await (await get(p)).text();
    assert.match(html, /<meta name="robots" content="noindex">/, p);
    assert.doesNotMatch(html, /rel="canonical"|og:title/, p);
  }
});

test("the manifest is public-facing: name, start_url, theme colour matching the page", async () => {
  const man = await (await get("/site.webmanifest")).json();
  assert.equal(man.name, "Uma's Books");
  assert.equal(man.start_url, "/");
  const html = await (await get("/login")).text();
  assert.equal(meta(html, "name", "theme-color"), man.theme_color);
});

test("static files: 7 days by default, immutable for a year with ?v=, versioned URLs in pages", async () => {
  const plain = await get("/assets/img/hero-left.png");
  assert.equal(plain.headers.get("cache-control"), "public, max-age=604800");
  const v = await get("/assets/img/hero-left.png?v=abc1234567");
  assert.match(v.headers.get("cache-control"), /max-age=31536000, immutable/);
  assert.equal((await get("/logo.png")).headers.get("cache-control"), "public, max-age=604800");
  const html = await (await get(`/books/${bookId}`)).text();
  assert.match(html, /href="\/style\.css\?v=[0-9a-f]{10}"/);
  assert.match(html, /<picture><source srcset="\/assets\/img\/logo-wordmark-framed\.webp\?v=[0-9a-f]{10}" type="image\/webp">/);
  // a dynamic page never becomes immutable because of a ?v=
  assert.doesNotMatch((await get(`/books/${bookId}?v=abc1234567`)).headers.get("cache-control") || "", /immutable/);
});

test("an empty month and an empty week say so, with a link to the next one", async () => {
  const month = await (await get("/events?month=2031-03")).text();
  assert.match(month, /<p class="fcal-empty" role="status">No events this month: <a href="\/events\?month=2031-04">see next month ›<\/a><\/p>/);
  const week = await (await get("/events?view=week&week=2031-03-03")).text();
  assert.match(week, /No events this week: <a href="\/events\?view=week&amp;week=[^"]+">see next week ›/);
  const fr = await (await get("/events?month=2031-03", { cookie: "umasbooks_lang=fr" })).text();
  assert.match(fr, /Aucun événement ce mois-ci\u00a0: <a[^>]*>voir le mois suivant ›/);
  const sessions = await (await get("/sessions?month=2031-03")).text();
  assert.match(sessions, /No sessions this month:/);
});

test("books.html has a <noscript> list of the newest books and a language hint", async () => {
  const html = await (await get("/books.html")).text();
  const ns = html.match(/<noscript>\s*<section class="bk-noscript"[\s\S]*?<\/noscript>/);
  assert.ok(ns, "noscript list");
  assert.match(ns[0], new RegExp(`<a href="/books/${bookId}">Polish &amp; &#34;Pride&#34; \\d+</a> — Jane Austen`));
  assert.match(ns[0], /€4\.50/);
  assert.match(html, /<noscript><span class="h-noscript">JavaScript is needed to change language<\/span><\/noscript>/);
  const fr = await (await get("/books.html", { cookie: "umasbooks_lang=fr" })).text();
  assert.match(fr, /JavaScript est nécessaire pour changer de langue/);
  assert.match(fr, /La recherche et la navigation par genre nécessitent JavaScript/);
});

test("the back link is a real link (home) that JavaScript upgrades to history.back()", async () => {
  const html = await (await get("/login")).text();
  assert.match(html, /<a href="\/" class="site-back-link">/);
});

test("French pages get no-break spaces and curly apostrophes in text only", async () => {
  const html = await (await get("/contact", { cookie: "umasbooks_lang=fr" })).text();
  assert.match(html, /Votre e-mail/);
  assert.match(html, /Merci\u00a0!|Une question sur les livres/);
  assert.doesNotMatch(html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]*>/g, ""), /[a-zé] [?!:;]/);
  const login = await (await get("/signup", { cookie: "umasbooks_lang=fr" })).text();
  assert.match(login, /Vous avez déjà un compte\u00a0\?/);
});

test("sitemap lists /contact and /request-a-book (not in preview)", async () => {
  const xml = await (await get("/sitemap-pages.xml")).text();
  assert.ok(xml.includes(`<loc>${SITE}/contact</loc>`));
  assert.ok(xml.includes(`<loc>${SITE}/request-a-book</loc>`));
});
