// French has its own addresses: the SAME public pages under /fr/ (/fr/, /fr/books.html, /fr/books/12,
// /fr/visit.html, /fr/privacy-policy.html, ...), rendered in French whatever the cookie or
// Accept-Language say, so a search engine (which sends neither) can index them. Unprefixed addresses
// stay English-first but keep honouring the language cookie / Accept-Language (no redirect), with the
// canonical link and hreflang alternates pointing at the language-specific address. Forms, /api/ and the
// private areas exist once, unprefixed. See src/lib/frUrls.js and docs/runbook.md ("Search engines").
//
// Port 4881 is reserved for this file.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");
const { conditionLabel } = require("../../src/lib/inventory");

const PORT = 4881;
const SITE = "https://books.example.test";
let app;
let bookId;
before(async () => {
  app = await startTestApp({ port: PORT, isolated: true, env: { APP_BASE_URL: SITE } });
  const c = new Client({ connectionString: app.databaseUrl });
  await c.connect();
  try {
    const { rows } = await c.query("INSERT INTO books (title, authors, binding, description, description_fr) VALUES ('Urls Book', 'Urls Author', 'trade', 'An English blurb.', 'Un résumé en français.') RETURNING id");
    bookId = rows[0].id;
    await c.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 7, 'very_good')", [bookId]);
  } finally {
    await c.end();
  }
});
after(() => app.stop());

const get = (path, headers = {}, init = {}) => fetch(app.base + path, { redirect: "manual", headers, ...init });
const text = async (path, headers) => (await get(path, headers)).text();
const FR_PAGES = ["/fr/", "/fr/books.html", "/fr/visit.html", "/fr/privacy-policy.html", "/fr/terms-of-sale.html", "/fr/mentions-legales.html", "/fr/about.html", "/fr/immersion.html", "/fr/events.html", "/fr/membership.html", "/fr/contact", "/fr/events", "/fr/sessions", "/fr/request-a-book"];

test("/fr/ pages are French with no cookie and no Accept-Language, and whatever the English headers say", async () => {
  for (const p of [...FR_PAGES, `/fr/books/${bookId}`]) {
    for (const headers of [{}, { "accept-language": "en-GB,en;q=0.9" }, { cookie: "umasbooks_lang=en", "accept-language": "en" }]) {
      const res = await get(p, headers);
      assert.equal(res.status, 200, `${p} ${JSON.stringify(headers)}`);
      const html = await res.text();
      assert.match(html, /<html lang="fr"/, `${p}: lang=fr`);
      assert.match(html, /<meta property="og:locale" content="fr_FR">/, `${p}: og:locale`);
      assert.match(html, /<meta property="og:locale:alternate" content="en_GB">/, `${p}: og:locale:alternate`);
      assert.ok(html.includes(`<link rel="canonical" href="${SITE}${p}">`), `${p}: canonical is itself`);
      const vary = String(res.headers.get("vary")).toLowerCase();
      assert.ok(vary.includes("accept-language") && vary.includes("cookie"), `${p}: Vary`);
    }
  }
});

test("the French home page and a legal page really are French text at /fr/", async () => {
  const home = await text("/fr/");
  assert.match(home, /Parcourir les livres/);
  assert.match(home, /librairie communautaire/);
  const legal = await text("/fr/privacy-policy.html");
  assert.match(legal, /Politique de confidentialité/);
  assert.doesNotMatch(legal.replace(/<script[\s\S]*?<\/script>/g, ""), /\b(We never sell|Your rights|This page explains)\b/);
});

test("book page at /fr/books/:id: French chrome, labels and description; its JSON-LD names the French address", async () => {
  const html = await text(`/fr/books/${bookId}`);
  assert.match(html, /<html lang="fr"/);
  assert.ok(html.includes(conditionLabel("very_good", "fr")), "French condition label");
  assert.ok(!html.includes(conditionLabel("very_good", "en")) || conditionLabel("very_good", "en") === conditionLabel("very_good", "fr"));
  assert.ok(html.includes("Un résumé en français."), "French description");
  assert.match(html, /Ajouter au panier|Ajouter/, "French add-to-cart");
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([^]*?)<\/script>/)[1]);
  assert.equal(ld.url, `${SITE}/fr/books/${bookId}`);
  const en = await text(`/books/${bookId}`);
  assert.ok(en.includes(conditionLabel("very_good", "en")));
  assert.ok(JSON.parse(en.match(/<script type="application\/ld\+json">([^]*?)<\/script>/)[1]).url === `${SITE}/books/${bookId}`);
});

test("the home page JSON-LD carries inLanguage and the language's own URL", async () => {
  const ld = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">([^]*?)<\/script>/)[1]);
  assert.deepEqual([ld(await text("/fr/")).inLanguage, ld(await text("/fr/")).url], ["fr", `${SITE}/fr/`]);
  assert.deepEqual([ld(await text("/")).inLanguage, ld(await text("/")).url], ["en", `${SITE}/`]);
});

test("unprefixed pages: Accept-Language or the cookie still give French in place (no redirect), with canonical and hreflang right", async () => {
  for (const [p, fr] of [["/", "/fr/"], ["/books.html", "/fr/books.html"], ["/contact", "/fr/contact"], [`/books/${bookId}`, `/fr/books/${bookId}`]]) {
    for (const headers of [{ "accept-language": "fr-FR,fr;q=0.9" }, { cookie: "umasbooks_lang=fr" }]) {
      const res = await get(p, headers);
      assert.equal(res.status, 200, `${p}: no redirect`);
      const html = await res.text();
      assert.match(html, /<html lang="fr"/, p);
      assert.ok(html.includes(`<link rel="canonical" href="${SITE}${fr}">`), `${p}: canonical is the French address`);
      assert.ok(html.includes(`<link rel="alternate" hreflang="en" href="${SITE}${p}">`), p);
      assert.ok(html.includes(`<link rel="alternate" hreflang="fr" href="${SITE}${fr}">`), p);
      assert.ok(html.includes(`<link rel="alternate" hreflang="x-default" href="${SITE}${p}">`), p);
    }
    const en = await text(p, { "accept-language": "en" });
    assert.match(en, /<html lang="en"/);
    assert.ok(en.includes(`<link rel="canonical" href="${SITE}${p}">`), `${p}: English canonical`);
  }
  // Pages that are not public pages (cart, login) have no /fr/ twin: no hreflang pair, no canonical to /fr/.
  assert.doesNotMatch(await text("/cart", { cookie: "umasbooks_lang=fr" }), /\/fr\//);
});

test("a /fr/ visit by a person writes the language cookie; a crawler, or someone already French, gets none", async () => {
  const human = await get("/fr/books.html", { "user-agent": "Mozilla/5.0 (iPhone)" });
  const set = human.headers.getSetCookie().find((c) => c.startsWith("umasbooks_lang="));
  assert.ok(set && /^umasbooks_lang=fr;/.test(set) && /Path=\//.test(set) && /SameSite=Lax/.test(set) && /Max-Age=31536000/.test(set), set);
  assert.ok(!/HttpOnly/i.test(set), "assets/site.js reads and writes it");
  for (const ua of ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Mozilla/5.0 (compatible; bingbot/2.0)"]) {
    const res = await get("/fr/books.html", { "user-agent": ua });
    assert.equal(res.status, 200);
    assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith("umasbooks_lang=")), `${ua}: no cookie`);
  }
  const again = await get("/fr/books.html", { cookie: "umasbooks_lang=fr" });
  assert.ok(!again.headers.getSetCookie().some((c) => c.startsWith("umasbooks_lang=")));
  // A visit to an English address writes nothing.
  assert.ok(!(await get("/books.html")).headers.getSetCookie().some((c) => c.startsWith("umasbooks_lang=")));
  // The cookie turns the person French everywhere: the cart and the login page.
  const cookie = set.split(";")[0];
  assert.match(await text("/cart", { cookie }), /<html lang="fr"/);
  assert.match(await text("/login", { cookie }), /<html lang="fr"/);
});

test("/fr -> /fr/ ; extensionless /fr/about -> /fr/about.html ; HEAD works ; the query string survives", async () => {
  let res = await get("/fr");
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "/fr/");
  res = await get("/fr?x=1");
  assert.equal(res.headers.get("location"), "/fr/?x=1");
  res = await get("/fr/books?genre=fiction");
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "/fr/books.html?genre=fiction");
  res = await get("/fr/books.html", {}, { method: "HEAD" });
  assert.equal(res.status, 200);
  // The unprefixed redirect is language-independent (a cache may keep it).
  res = await get("/books", { cookie: "umasbooks_lang=fr" });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "/books.html");
});

test("only the public pages exist under /fr/: everything else is a French 404 (admin, cart, login, account, api, typos)", async () => {
  for (const p of ["/fr/admin", "/fr/admin/inventory", "/fr/cart", "/fr/login", "/fr/signup", "/fr/account", "/fr/dashboard", "/fr/api/session", "/fr/api/books/search?q=a", "/fr/forum", "/fr/volunteer", "/fr/no-such-page", "/fr/fr/", "/fr/favorites", "/frx"]) {
    const res = await get(p);
    assert.equal(res.status, 404, p);
    const html = await res.text();
    if (p !== "/frx") assert.match(html, /<html lang="fr"/, `${p}: the 404 is French`);
  }
  assert.equal((await get("/fr/books/999999")).status, 404);
  assert.match(await text("/fr/books/999999"), /<html lang="fr"/);
  // And no POST is answered under /fr/.
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const post = await fetch(app.base + "/fr/contact", { method: "POST", redirect: "manual", headers: { cookie: jar.header(), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ _csrf: token, name: "A" }).toString() });
  assert.equal(post.status, 404);
});

// ---- the links on a /fr/ page stay on /fr/

const PRIVATE_OK = /^\/(login|logout|signup|account|cart|dashboard|favorites|admin|forgot-password|my-requests|forum|charity|meetings|announcements|api|events\/\d+\/ics|assets|img|site\.webmanifest|favicon|apple-touch)/;
const hrefs = (html) => [...html.replace(/<script[\s\S]*?<\/script>/g, "").matchAll(/<a\b(?:"[^"]*"|'[^']*'|[^>"'])*>/g)].map((m) => ({ tag: m[0], href: (m[0].match(/\shref="([^"]*)"/) || [])[1] })).filter((x) => x.href !== undefined);

test("crawl 20+ /fr/ pages: no internal link to an unprefixed public page (allow-list: the language toggle)", async () => {
  const seen = new Set();
  const queue = ["/fr/"];
  const problems = [];
  while (queue.length && seen.size < 40) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    const res = await get(p);
    assert.equal(res.status, 200, p);
    const html = await res.text();
    for (const { tag, href } of hrefs(html)) {
      if (/^(https?:|mailto:|tel:|#)/.test(href)) continue;
      const url = new URL(href, `http://x${p}`);
      if (/\sdata-lang=/.test(tag)) continue; // the toggle points at the other language on purpose
      if (url.pathname.startsWith("/fr/") || url.pathname === "/fr") { queue.push(url.pathname + url.search); continue; }
      if (PRIVATE_OK.test(url.pathname)) continue;
      problems.push(`${p} -> ${href}`);
    }
  }
  assert.ok(seen.size >= 20, `only ${seen.size} pages crawled`);
  assert.deepEqual(problems, [], "links from /fr/ pages must stay under /fr/ (or be a private page)");
});

test("every image, stylesheet and script on a /fr/ page loads (no relative address broken by the prefix)", async () => {
  const missing = [];
  const checked = new Set();
  for (const p of [...FR_PAGES, `/fr/books/${bookId}`]) {
    const html = await text(p);
    for (const m of html.matchAll(/<(?:img|script|link)\b[^>]*?\s(?:src|href)="([^"#]+)"/g)) {
      if (/^(https?:|mailto:|tel:|data:)/.test(m[1])) continue;
      if (/<link\b[^>]*rel="(canonical|alternate)"/.test(m[0])) continue;
      const url = new URL(m[1], `http://x${p}`).pathname + new URL(m[1], `http://x${p}`).search;
      if (checked.has(url)) continue;
      checked.add(url);
      const res = await get(url, {}, { method: "HEAD" });
      if (res.status !== 200) missing.push(`${p}: ${m[1]} -> ${url} (${res.status})`);
    }
  }
  assert.ok(checked.size > 15);
  assert.deepEqual(missing, []);
});

test("forms on /fr/ pages post to the normal (unprefixed) URL", async () => {
  for (const p of ["/fr/contact", "/fr/request-a-book", "/fr/pre-registration.html", "/fr/volunteer.html", "/fr/membership.html"]) {
    const html = (await text(p)).replace(/<script[\s\S]*?<\/script>/g, "");
    for (const m of html.matchAll(/<form\b[^>]*\saction="([^"]*)"/g)) assert.ok(!m[1].startsWith("/fr"), `${p}: form action ${m[1]}`);
  }
});

// ---- the language toggle

const toggle = (html) => [...html.matchAll(/<a href="([^"]*)" data-lang="(en|fr)"[^>]*>(EN|FR)<\/a>/g)].map((m) => ({ lang: m[2], href: m[1] }));

test("the toggle links to the equivalent address in the other language (query string kept)", async () => {
  for (const [en, fr] of [["/", "/fr/"], ["/books.html?genre=fiction", "/fr/books.html?genre=fiction"], ["/visit.html", "/fr/visit.html"], ["/contact", "/fr/contact"], [`/books/${bookId}`, `/fr/books/${bookId}`], ["/sessions?type=dropin", "/fr/sessions?type=dropin"]]) {
    for (const [path, headers] of [[en, {}], [fr, {}], [en, { cookie: "umasbooks_lang=fr" }]]) {
      const html = await text(path, headers);
      assert.deepEqual(toggle(html), [{ lang: "en", href: en }, { lang: "fr", href: fr }], `${path} ${JSON.stringify(headers)}`);
      const french = path === fr || headers.cookie;
      assert.match(html, french ? /data-lang="fr" lang="fr" hreflang="fr" class="is-active" aria-current="true">FR</ : /data-lang="en" lang="en" hreflang="en" class="is-active" aria-current="true">EN</, path);
    }
  }
});

test("a French 404 under /fr/ has a toggle that still works (EN leads home)", async () => {
  assert.deepEqual(toggle(await (await get("/fr/no-such-page")).text()), [{ lang: "en", href: "/" }, { lang: "fr", href: "/fr/" }]);
  assert.deepEqual(toggle(await (await get("/fr/admin")).text()), [{ lang: "en", href: "/" }, { lang: "fr", href: "/fr/" }]);
});

test("pages with no French address keep the two buttons (they store the choice and reload)", async () => {
  for (const p of ["/cart", "/login", "/signup", "/favorites"]) {
    const html = await text(p);
    assert.deepEqual(toggle(html), [], p);
    assert.match(html, /<button type="button" data-lang="fr"/, p);
  }
});

// ---- the answer to a form follows the language

async function postContact(headers, fields) {
  const jar = makeCookieJar();
  const csrfHeaders = { ...headers };
  const token = await fetchCsrfToken(app.base, jar, csrfHeaders);
  const res = await fetch(app.base + "/contact", {
    method: "POST", redirect: "manual",
    headers: { ...headers, cookie: [jar.header(), headers.cookie].filter(Boolean).join("; "), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: token, ...fields }).toString(),
  });
  jar.capture(res);
  return { res, jar };
}

test("a form posted from a French page is answered French: the redirect lands on the /fr/ twin and the message is French", async () => {
  // The /fr/ visit set the cookie (as a browser keeps it); the form posts to the unprefixed URL.
  const visit = await get("/fr/contact", { "user-agent": "Mozilla/5.0" });
  const cookie = visit.headers.getSetCookie().find((c) => c.startsWith("umasbooks_lang=")).split(";")[0];
  const { res, jar } = await postContact({ cookie }, { name: "", email: "x", topic: "General question", message: "" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/fr/contact");
  const page = await fetch(app.base + res.headers.get("location"), { headers: { cookie: [jar.header(), cookie].join("; ") } });
  assert.match(await page.text(), /Veuillez indiquer votre nom/);
  // Accept-Language French on the unprefixed form is French too.
  const alt = await postContact({ "accept-language": "fr" }, { name: "", email: "x", message: "" });
  assert.equal(alt.res.headers.get("location"), "/fr/contact");
  // English stays on the unprefixed address.
  const en = await postContact({ cookie: "umasbooks_lang=en" }, { name: "", email: "x", message: "" });
  assert.equal(en.res.headers.get("location"), "/contact");
  const plain = await postContact({}, { name: "", email: "x", message: "" });
  assert.equal(plain.res.headers.get("location"), "/contact");
});

test("a redirect to a private page is not prefixed, even for a French visitor", async () => {
  const res = await get("/cart/checkout", { cookie: "umasbooks_lang=fr" });
  if (res.status >= 300 && res.status < 400) assert.ok(!res.headers.get("location").startsWith("/fr/login") && !res.headers.get("location").startsWith("/fr/cart"), res.headers.get("location"));
});

test("robots.txt is unchanged and does not block /fr/", async () => {
  const body = await text("/robots.txt");
  assert.doesNotMatch(body, /\/fr/);
  assert.match(body, /^Allow: \/$/m);
});
