// The /fr/ address rules (src/lib/frUrls.js) and the copy of them in assets/site.js.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { isPublicPath, splitFr, localize, seoLinks, switchHrefs, prefixLinks } = require("../../src/lib/frUrls");
const MARKETING_PAGES = require("../../src/lib/marketingPages");

test("which paths have a French twin", () => {
  for (const p of ["/", "/books.html", "/books", "/visit.html", "/about", "/privacy-policy.html", "/contact", "/events", "/sessions", "/request-a-book", "/books/12", "/books/12/", "/volunteer.html"]) assert.equal(isPublicPath(p), true, p);
  for (const p of ["/volunteer", "/admin", "/admin/inventory", "/cart", "/login", "/signup", "/account", "/dashboard", "/api/books/search", "/books/abc", "/events/3/ics", "/fr/", "/favorites", "/healthz", "/robots.txt", "/books.html/x", "/img/abc.jpg", ""]) assert.equal(isPublicPath(p), false, p);
  for (const f of MARKETING_PAGES) assert.equal(isPublicPath("/" + f), true, f);
});

test("splitFr and localize", () => {
  assert.deepEqual(splitFr("/fr"), { prefixed: true, rest: "/" });
  assert.deepEqual(splitFr("/fr/"), { prefixed: true, rest: "/" });
  assert.deepEqual(splitFr("/fr/books.html?genre=a#x"), { prefixed: true, rest: "/books.html?genre=a#x" });
  assert.deepEqual(splitFr("/frx"), { prefixed: false, rest: "/frx" });
  assert.deepEqual(splitFr("/books.html"), { prefixed: false, rest: "/books.html" });
  assert.equal(localize("/"), "/fr/");
  assert.equal(localize("/?a=1"), "/fr/?a=1");
  assert.equal(localize("/books/12"), "/fr/books/12");
  assert.equal(localize("/sessions?type=dropin#x"), "/fr/sessions?type=dropin#x");
  for (const same of ["/cart", "/login?returnTo=%2Fbooks%2F1", "/fr/books.html", "//evil.test/books.html", "https://x.test/books.html", "books.html", "/api/books/search", "/volunteer"]) assert.equal(localize(same), same, same);
});

test("seoLinks: canonical in the page's language, en/fr/x-default alternates; other pages canonical only", () => {
  const fr = seoLinks("https://x.org/", "/books.html", "fr");
  assert.equal(fr.canonical, "https://x.org/fr/books.html");
  assert.deepEqual(fr.alternates, [
    { hreflang: "en", href: "https://x.org/books.html" },
    { hreflang: "fr", href: "https://x.org/fr/books.html" },
    { hreflang: "x-default", href: "https://x.org/books.html" },
  ]);
  assert.equal(seoLinks("https://x.org", "/", "en").canonical, "https://x.org/");
  assert.equal(seoLinks("https://x.org", "/", "fr").canonical, "https://x.org/fr/");
  assert.deepEqual(seoLinks("https://x.org", "/cart", "fr"), { canonical: "https://x.org/cart", alternates: [{ hreflang: "x-default", href: "https://x.org/cart" }] });
  assert.deepEqual(seoLinks("", "/", "en"), { canonical: "", alternates: [] });
});

test("switchHrefs", () => {
  assert.deepEqual(switchHrefs("/"), { en: "/", fr: "/fr/" });
  assert.deepEqual(switchHrefs("/books.html?genre=x"), { en: "/books.html?genre=x", fr: "/fr/books.html?genre=x" });
  assert.equal(switchHrefs("/cart"), null);
});

test("prefixLinks touches only <a href> to public pages: not forms, assets, the toggle, scripts or private pages", () => {
  const html = [
    '<a class="x" href="/books/3">a</a>', '<a href="/login">l</a>', '<a data-lang="en" href="/visit.html">e</a>', '<a href="/visit.html" data-lang="en">e</a>',
    '<a href="/">h</a>', '<script>var s = \'<a href="/contact">\';</script>', '<a href="/contact?topic=feedback">c</a>', '<a href="/volunteer">v</a>',
    '<form action="/contact"></form>', '<link rel="stylesheet" href="/books.html">', '<a href="visit.html">rel</a>', '<a href="https://x.test/contact">abs</a>', '<a href="/fr/contact">done</a>',
  ].join("");
  const out = prefixLinks(html);
  for (const expected of ['href="/fr/books/3"', 'href="/login"', '<a data-lang="en" href="/visit.html">', '<a href="/visit.html" data-lang="en">', 'href="/fr/">h', "'<a href=\"/contact\">'", 'href="/fr/contact?topic=feedback"', 'href="/volunteer"', 'action="/contact"', '<link rel="stylesheet" href="/books.html">', 'href="visit.html"', 'href="https://x.test/contact"', 'href="/fr/contact">done']) {
    assert.ok(out.includes(expected), expected + "\n" + out);
  }
});

test("assets/site.js decides the same public paths as the server (it writes links in the browser)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "..", "assets", "site.js"), "utf8");
  const window = { document: { addEventListener() {}, cookie: "" } };
  const location = { protocol: "https:", origin: "https://x.org", pathname: "/fr/" };
  vm.runInNewContext(src, { window, document: window.document, navigator: { language: "en" }, location });
  const frHref = window.__umasFrHref;
  const paths = ["/", ...MARKETING_PAGES.flatMap((f) => ["/" + f, "/" + f.replace(/\.html$/, "")]), "/contact", "/events", "/sessions", "/request-a-book", "/request-a-book/sent", "/books/12", "/books/12/", "/volunteer", "/cart", "/login", "/admin", "/account", "/books/x", "/api/books", "/events/3/ics", "/fr/", "/favorites", "/healthz"];
  for (const p of paths) {
    for (const tail of ["", "?a=1", "#x"]) assert.equal(frHref(p + tail), localize(p + tail), p + tail);
  }
  assert.equal(frHref("https://x.org/events?month=2026-10"), "/fr/events?month=2026-10", "this site's absolute address counts");
  assert.equal(frHref("https://other.test/events"), "https://other.test/events");
  assert.equal(frHref("//other.test/events"), "//other.test/events");
  assert.equal(window.UmasFrHref("/books/3"), "/fr/books/3", "on a /fr/ page");
  location.pathname = "/books.html";
  assert.equal(window.UmasFrHref("/books/3"), "/books/3", "on an English page");
  // The starting language on a /fr/ address is French whatever was stored.
  assert.equal(window.__umasResolveInitialLang("en", "en", "en", "en", "/fr/visit.html"), "fr");
  assert.equal(window.__umasResolveInitialLang("en", "en", "en", "en", "/visit.html"), "en");
});
