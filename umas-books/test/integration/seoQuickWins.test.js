// Review D, PR D1: crawler-facing quick wins on the LIVE output (robots.txt, canonicals, descriptions, book titles,
// noindex favorites, /favicon.ico, home JSON-LD, og:image:alt, cache headers) and proof that PREVIEW output
// (Disallow: /, empty sitemaps, noindex) is exactly what it was.
//
// Ports 7811 (live) and 7812 (preview) are reserved for this file.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { startTestApp } = require("../helpers/testApp");
const legal = require("../../src/lib/legal");
const { bookPageTitle, TITLE_BRAND } = require("../../src/lib/bookSeo");

const SITE = "https://umasbooks.org";
const LIVE_PORT = 7811;
const PREVIEW_PORT = 7812;

let live, preview, db, emmaId, noAuthorId, longId, vowelId;

before(async () => {
  const env = { APP_BASE_URL: SITE };
  live = await startTestApp({ port: LIVE_PORT, isolated: true, env: { ...env, PREVIEW_MODE: "" } });
  preview = await startTestApp({ port: PREVIEW_PORT, isolated: true, env: { ...env, PREVIEW_MODE: "true" } });
  db = new Client({ connectionString: live.databaseUrl });
  await db.connect();
  const mk = async (title, authors) => {
    const { rows } = await db.query("INSERT INTO books (title, authors) VALUES ($1, $2) RETURNING id", [title, authors]);
    await db.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 5, 'very_good')", [rows[0].id]);
    return rows[0].id;
  };
  emmaId = await mk("Emma", "Jane Austen");
  noAuthorId = await mk("Anonymous Tales", "");
  longId = await mk("A Remarkably Long Title About Many Different Things That Goes On And On For Far Too Long", "Somebody");
  vowelId = await mk("Roman", "Agatha Christie");
});

after(async () => {
  await db.end();
  await live.stop();
  await preview.stop();
});

const get = (app, p, headers) => fetch(`${app.base}${p}`, { headers, redirect: "manual" });
const html = async (app, p, headers) => (await get(app, p, headers)).text();
const FR = { cookie: "umasbooks_lang=fr" };
const unesc = (s) => s.replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const meta = (h, attr, name) => { const m = h.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`)); return m ? unesc(m[1]) : undefined; };
const titleOf = (h) => unesc((h.match(/<title>([^<]*)<\/title>/) || [])[1] || "");
const canonicalOf = (h) => (h.match(/<link rel="canonical" href="([^"]*)"/) || [])[1];

// Google's rule: the longest matching Allow/Disallow pattern wins; a tie goes to Allow. Prefix patterns only (no wildcards used here).
function robotsAllows(body, urlPath) {
  let best = { len: -1, allow: true };
  for (const line of body.split("\n")) {
    const m = line.match(/^(Allow|Disallow):\s*(\S*)$/);
    if (!m || !m[2]) continue;
    if (!urlPath.startsWith(m[2])) continue;
    const allow = m[1] === "Allow";
    if (m[2].length > best.len || (m[2].length === best.len && allow)) best = { len: m[2].length, allow };
  }
  return best.allow;
}

test("D1 robots.txt: public JSON that fills the blog and shelves is crawlable, private /api/ stays blocked, sitemap on the apex", async () => {
  const body = await (await get(live, "/robots.txt")).text();
  for (const p of ["/api/blog/posts", "/api/blog/posts/some-slug", "/api/books/new-in", "/api/books/search?q=emma", "/api/events/upcoming"]) {
    assert.equal(robotsAllows(body, p), true, `${p} must be allowed`);
  }
  for (const p of ["/api/books/by-ids?ids=1,2", "/api/csrf-token", "/api/session", "/api/cart/count", "/api/favorites/toggle", "/admin", "/account", "/cart", "/login", "/signup"]) {
    assert.equal(robotsAllows(body, p), false, `${p} must stay blocked`);
  }
  assert.equal(robotsAllows(body, "/"), true);
  // Allow lines come before the broad Disallow for crawlers that read top-down.
  const lines = body.split("\n");
  assert.ok(lines.indexOf("Allow: /api/blog/") < lines.indexOf("Disallow: /api/"));
  assert.ok(lines.indexOf("Allow: /api/books") < lines.indexOf("Disallow: /api/"));
  assert.ok(lines.includes("Sitemap: https://umasbooks.org/sitemap.xml"), "canonical apex host from APP_BASE_URL");
});

test("D1 preview: robots.txt, sitemaps and noindex are exactly as before", async () => {
  const robots = await get(preview, "/robots.txt");
  assert.equal(await robots.text(), "User-agent: *\nDisallow: /\n");
  assert.equal(robots.headers.get("cache-control"), "no-cache");
  for (const p of ["/sitemap.xml", "/sitemap-pages.xml", "/sitemap-books-1.xml"]) {
    const r = await get(preview, p);
    assert.equal(r.status, 200, p);
    assert.equal(await r.text(), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n`, p);
  }
  for (const p of ["/", "/events", "/favorites", "/contact", `/books/${emmaId}`]) {
    const r = await get(preview, p);
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow", p);
    assert.equal(meta(await r.text(), "name", "robots"), "noindex, nofollow", p);
  }
});

test("D10 events, sessions, contact and request-a-book have their own description (EN and FR, 120-160 characters)", async () => {
  const seen = new Set();
  const dflt = [ "Uma's Books & Adventures — a community English bookshop in Albi, France: pre-loved English books, English programs and events." ];
  for (const headers of [undefined, FR]) {
    const lang = headers ? "fr" : "en";
    for (const p of ["/events", "/sessions", "/contact", "/request-a-book"]) {
      const h = await html(live, p, headers);
      const d = meta(h, "name", "description");
      assert.ok(d, `${lang} ${p}: description`);
      assert.ok(d.length >= 120 && d.length <= 160, `${lang} ${p}: ${d.length} characters`);
      assert.ok(!dflt.includes(d) && !/^Uma’s Books & Adventures — une librairie associative anglophone à Albi : livres anglais/.test(d), `${lang} ${p}: not the site default`);
      assert.equal(meta(h, "property", "og:description"), d);
      assert.ok(!seen.has(d), `${lang} ${p}: unique`);
      seen.add(d);
    }
  }
});

test("D15 book page title: 'Title by Author — brand', French 'de', no author, long titles", async () => {
  const BRAND = "Uma's Books and Adventures";
  assert.equal(TITLE_BRAND, BRAND);
  assert.equal(titleOf(await html(live, `/books/${emmaId}`)), `Emma by Jane Austen — ${BRAND}`);
  // French pages curl every apostrophe (lib/frenchTypography.js), the brand's included, as on the rest of the French site.
  const BRAND_FR = BRAND.replace("'", "’");
  assert.equal(titleOf(await html(live, `/books/${emmaId}`, FR)), `Emma de Jane Austen — ${BRAND_FR}`);
  assert.equal(titleOf(await html(live, `/books/${vowelId}`, FR)), `Roman d’Agatha Christie — ${BRAND_FR}`);
  assert.equal(titleOf(await html(live, `/books/${noAuthorId}`)), `Anonymous Tales — ${BRAND}`);
  const long = await html(live, `/books/${longId}`);
  const t = titleOf(long);
  assert.ok(t.endsWith(` — ${BRAND}`));
  assert.ok(t.length <= 60 + 3 + BRAND.length, `title length ${t.length}`);
  assert.match(t, /^A Remarkably Long Title About Many Different Things…|^A Remarkably Long Title[^—]*… — /);
  assert.match(long, /<h1[^>]*>\s*A Remarkably Long Title About Many Different Things That Goes On And On For Far Too Long\s*<\/h1>/, "full title stays in the h1");
});

test("D15 bookPageTitle (unit): author dropped before the title is clipped, whitespace tidied, brand untouched", () => {
  const B = ` — ${TITLE_BRAND}`;
  assert.equal(bookPageTitle({ title: "  Emma ", authors: " Jane   Austen " }, "en"), `Emma by Jane Austen${B}`);
  assert.equal(bookPageTitle({ title: "Emma", authors: null }, "fr"), `Emma${B}`);
  // title fits alone but not with the author: the author goes, the title is not clipped
  const t50 = "T".repeat(25) + " " + "U".repeat(24);
  assert.equal(bookPageTitle({ title: t50, authors: "Long Authorname Here" }, "en"), t50 + B);
  const clipped = bookPageTitle({ title: "word ".repeat(30), authors: "X" }, "en");
  assert.ok(clipped.endsWith(`…${B}`) && clipped.length <= 60 + B.length);
  assert.equal(bookPageTitle({ title: "Hugo", authors: "Éric Roi" }, "fr"), `Hugo d’Éric Roi${B}`);
});

test("D16 canonicals: one normalised address whatever the case, trailing slash, query or /fr/ prefix", async () => {
  for (const p of ["/events", "/Events", "/EVENTS", "/events/", "/events?month=2026-11", "/Events/?view=week"]) {
    const r = await get(live, p);
    assert.equal(r.status, 200, p);
    const h = await r.text();
    assert.equal(canonicalOf(h), `${SITE}/events`, `${p}: canonical`);
    assert.equal(meta(h, "property", "og:url"), `${SITE}/events`, `${p}: og:url`);
    assert.ok(h.includes(`<link rel="alternate" hreflang="fr" href="${SITE}/fr/events">`), `${p}: hreflang fr`);
  }
  for (const p of ["/fr/events", "/fr/events/", "/fr/events/?month=2026-11"]) {
    const r = await get(live, p);
    assert.equal(r.status, 200, p);
    const h = await r.text();
    assert.equal(canonicalOf(h), `${SITE}/fr/events`, `${p}: canonical`);
    assert.ok(h.includes(`<link rel="alternate" hreflang="en" href="${SITE}/events">`), `${p}: hreflang en`);
  }
  assert.equal(canonicalOf(await html(live, `/books/${emmaId}`)), `${SITE}/books/${emmaId}`);
  assert.equal(canonicalOf(await html(live, "/fr/books/" + emmaId + "/")), `${SITE}/fr/books/${emmaId}`);
  assert.equal(canonicalOf(await html(live, "/")), `${SITE}/`);
  assert.equal(canonicalOf(await html(live, "/fr/")), `${SITE}/fr/`);
});

test("D17 favorites is per-user: noindex, follow, no canonical/hreflang, not in the sitemap", async () => {
  for (const headers of [undefined, FR]) {
    const h = await html(live, "/favorites", headers);
    assert.equal(meta(h, "name", "robots"), "noindex, follow");
    assert.doesNotMatch(h, /rel="canonical"|hreflang/);
  }
  const sm = await (await get(live, "/sitemap-pages.xml")).text();
  assert.doesNotMatch(sm, /favorites/);
  assert.match(sm, /<loc>https:\/\/umasbooks\.org\/events<\/loc>/);
  // other pages are unaffected, and other noindex pages keep their plain "noindex"
  assert.equal(meta(await html(live, "/login"), "name", "robots"), "noindex");
  assert.equal(meta(await html(live, "/events"), "name", "robots"), undefined);
});

test("D18 /favicon.ico answers 200 with the 32px icon and a long cache", async () => {
  const r = await get(live, "/favicon.ico");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.equal(r.headers.get("cache-control"), "public, max-age=2592000");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.getSetCookie().length, 0, "no session for an icon");
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.ok(bytes.equals(fs.readFileSync(path.join(__dirname, "..", "..", "public", "favicon-32x32.png"))));
  assert.equal((await get(preview, "/favicon.ico")).status, 200);
});

test("D12 home JSON-LD: valid Bookstore with telephone, sameAs and logo read from legal.js", async () => {
  for (const headers of [undefined, FR]) {
    const h = await html(live, headers ? "/fr/" : "/", headers);
    const blocks = [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.equal(blocks.length, 1);
    const ld = JSON.parse(blocks[0][1]);
    assert.equal(ld["@context"], "https://schema.org");
    assert.equal(ld["@type"], "Bookstore");
    assert.equal(ld.address["@type"], "PostalAddress");
    assert.equal(ld.openingHoursSpecification[0]["@type"], "OpeningHoursSpecification");
    assert.equal(ld.telephone, legal.SHOP_PHONE_TEL.replace(/^tel:/, ""));
    assert.match(ld.telephone, /^\+[1-9]\d{6,14}$/, "E.164");
    assert.deepEqual(ld.sameAs, Object.values(legal.SOCIAL_LINKS).filter(Boolean));
    assert.equal(ld.logo, `${SITE}/logo.png`);
    assert.equal(ld.image, `${SITE}/assets/img/logo-stamp-1280x720.png`);
    assert.equal(ld.url, headers ? `${SITE}/fr/` : `${SITE}/`);
    assert.equal(ld.geo, undefined);
    assert.equal(ld.priceRange, undefined);
    const logo = await get(live, "/logo.png");
    assert.equal(logo.status, 200, "the logo URL resolves");
  }
});

test("D32 og:image:alt on the default image (EN/FR); no apple-mobile-web-app-capable", async () => {
  for (const p of ["/events", `/books/${emmaId}`, "/", "/events.html"]) {
    const en = await html(live, p);
    const fr = await html(live, p, FR);
    assert.match(meta(en, "property", "og:image:alt"), /community English bookshop in Albi/, p);
    assert.match(meta(fr, "property", "og:image:alt"), /librairie associative anglophone/, p);
    assert.doesNotMatch(en, /apple-mobile-web-app-capable/, p);
  }
});

test("D20 cache headers: ?v=<hash> is immutable for a year, a bare URL keeps 7 days, content-addressed images are immutable", async () => {
  const IMM = "public, max-age=31536000, immutable";
  const WEEK = "public, max-age=604800";
  const cc = async (p, headers) => (await get(live, p, headers)).headers.get("cache-control");
  for (const p of ["/style.css", "/site-header.css", "/app.js", "/assets/site.css", "/assets/img/hero-left.png", "/logo.png"]) {
    assert.equal(await cc(`${p}?v=0123456789`), IMM, `${p}?v=`);
    assert.equal(await cc(p), WEEK, `${p} bare`);
  }
  assert.equal(await cc("/style.css?v=zzz"), WEEK, "a non-hash v= does not count");
  assert.equal(await cc("/logo.png?v="), WEEK);
  // /img/<sha256>: the name is the content hash, immutable on every response (304 shown: no stored image needed)
  const hash = "a".repeat(64);
  const r = await get(live, `/img/${hash}.jpg`, { "if-none-match": `"${hash}"` });
  assert.equal(r.status, 304);
  assert.equal(r.headers.get("cache-control"), IMM);
});

test("D20 every stylesheet and script a customer page links carries ?v=; only icons, fonts and decorative images are bare", async () => {
  const pages = ["/", "/events", "/sessions", "/contact", "/request-a-book", "/favorites", "/login", "/books.html", "/about.html", "/events.html", "/membership.html", `/books/${emmaId}`, "/fr/"];
  const bare = new Set();
  for (const p of pages) {
    const h = await html(live, p);
    for (const m of h.matchAll(/<(?:link rel="stylesheet"|script)\b[^>]*?(?:href|src)="(\/[^"]+)"/g)) {
      if (!/[?&]v=[0-9a-f]{6,}/.test(m[1])) bare.add(`${p} ${m[1]}`);
    }
  }
  assert.deepEqual([...bare], []);
});
