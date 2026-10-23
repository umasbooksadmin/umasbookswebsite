// public/ui.js: the one copy of the browser helpers (escaping, money, cover attributes, the two book-card layouts) that
// public/page-books.js (Browse), public/favorites-page.js, public/page-events.js and assets/blog.js used to carry
// copies of. The golden cards in test/fixtures/ui-cards.golden.json were captured from the code those pages ran BEFORE the
// copies were merged (and compared with it on 168 inputs), so a change to a card is a deliberate edit of that file.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { formatEuro } = require("../../src/lib/money");
const { coverSrcset: serverCoverSrcset } = require("../../src/lib/imageVariants");

const ROOT = path.join(__dirname, "..", "..");
const UI_SRC = fs.readFileSync(path.join(ROOT, "public", "ui.js"), "utf8");
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "ui-cards.golden.json"), "utf8"));
const DICT = {
  en: { "bk.nocover": "No cover", "bk.fav.add": "Add {t} to favorites" },
  fr: { "bk.nocover": "Pas de couverture", "bk.fav.add": "Ajouter {t} aux favoris" },
};

// ui.js as a browser runs it: a global document (<html lang>), window.PAGE_I18N and window.UmasFrHref (assets/site.js).
function loadUi(lang, { frHref } = {}) {
  const ctx = { document: { documentElement: { lang } }, window: { PAGE_I18N: DICT, UmasFrHref: frHref }, Intl, Number, String, isFinite };
  vm.runInNewContext(UI_SRC, ctx);
  return ctx.window.UmasUI;
}

const HASH = "ab".repeat(32);
const FULL = { id: 12, title: "Le Petit Prince", author: "Antoine de Saint-Exupéry", price: 7.5, coverUrl: `/img/${HASH}.jpg`, url: "/books/12", inStockCount: 2 };
const BARE = { id: 13, title: "L'Étranger <b>", author: "", price: null, coverUrl: null, url: "/books/13", inStockCount: 0 };

test("esc: the five characters, null and undefined are empty, numbers and 0 print", () => {
  const { esc } = loadUi("en");
  assert.equal(esc(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(0), "0");
  assert.equal(esc(12), "12");
  assert.equal(esc("ça va"), "ça va");
});

test("every caller that had its own esc() got the same output, so they all use this one", () => {
  // events (page-events.js) and the blog (assets/blog.js) had the null-check form; Browse too; the old Favorites form
  // (`s || ""`) differed only for 0 / false, which no title, address or author ever is.
  for (const f of ["public/page-books.js", "public/favorites-page.js", "public/page-events.js", "assets/blog.js"]) {
    const src = fs.readFileSync(path.join(ROOT, f.startsWith("assets") ? ".." : "", f), "utf8");
    assert.doesNotMatch(src, /function esc\(/, `${f} must use UmasUI.esc, not its own copy`);
    assert.doesNotMatch(src, /'&': '&amp;'|"&": "&amp;"/, `${f} has no escape table of its own`);
  }
});

test("euro: the same text as lib/money.js formatEuro in both languages, '' for anything that is not a number", () => {
  for (const lang of ["en", "fr"]) {
    const { euro } = loadUi(lang);
    for (const n of [0, 1.5, 7.5, 12.5, 1234.5, 99999.99, "7", "9.99"]) assert.equal(euro(n), formatEuro(n, lang), `${lang} ${n}`);
    for (const bad of [undefined, NaN, Infinity, "abc"]) assert.equal(euro(bad), "", `${lang} ${bad}`);
  }
  assert.equal(loadUi("en").euro(12.5), "€12.50");
  assert.equal(loadUi("fr").euro(12.5), "12,50 €");
});

test("lang: from <html lang>, anything starting with fr is French", () => {
  assert.equal(loadUi("fr").lang(), "fr");
  assert.equal(loadUi("fr-FR").lang(), "fr");
  assert.equal(loadUi("en").lang(), "en");
  assert.equal(loadUi("").lang(), "en");
});

test("coverSrcset / coverAttrs: the 300 / 450 / 600 copies for a stored cover, nothing for any other address, the same as the server", () => {
  const { coverSrcset, coverAttrs } = loadUi("en");
  const stored = `/img/${HASH}.jpg`;
  assert.equal(coverSrcset(stored), `/img/${HASH}-w300.jpg 300w, /img/${HASH}-w450.jpg 450w, ${stored} 600w`);
  assert.equal(coverAttrs(stored, "(max-width: 700px) 45vw, 200px"), ` srcset="/img/${HASH}-w300.jpg 300w, /img/${HASH}-w450.jpg 450w, ${stored} 600w" sizes="(max-width: 700px) 45vw, 200px"`);
  for (const other of ["/img/short.jpg", "https://covers.example/x.jpg", `/img/${"AB".repeat(32)}.jpg`, "", null, undefined]) {
    assert.equal(coverSrcset(other), "", String(other));
    assert.equal(coverAttrs(other, "S"), "", String(other));
  }
  // Mirrors lib/imageVariants.js (the server's version, used by the EJS views)
  for (const u of [stored, `/img/${"0".repeat(64)}.jpg`, "/img/x.jpg", null, "/assets/img/hero-left.png"]) {
    assert.equal(coverSrcset(u), serverCoverSrcset(u) || "", String(u));
  }
});

test("the Browse card (New In carousel, genre and search grid) is exactly what Browse drew before, in English and French", () => {
  for (const lang of ["en", "fr"]) {
    const ui = loadUi(lang);
    assert.equal(ui.bookCardHtml(FULL, true), GOLDEN[`browse_full_${lang}`], `${lang} with cover, author, price and heart`);
    assert.equal(ui.bookCardHtml(BARE, false), GOLDEN[`browse_bare_${lang}`], `${lang} no cover, no author, no price, no heart`);
  }
});

test("the Browse card links to the French address under /fr/ (window.UmasFrHref) and escapes it", () => {
  const ui = loadUi("fr", { frHref: (u) => "/fr" + u });
  assert.match(ui.bookCardHtml(FULL, false), /<a href="\/fr\/books\/12">/);
  assert.match(ui.bookCardHtml({ ...FULL, url: '/books/1"><x' }, false), /href="\/fr\/books\/1&quot;&gt;&lt;x"/);
});

test("the Favorites card is exactly what the Favorites page drew before, in English and French", () => {
  for (const lang of ["en", "fr"]) {
    const ui = loadUi(lang);
    assert.equal(ui.favoriteCardHtml(FULL), GOLDEN[`fav_full_${lang}`], `${lang} in stock, with cover`);
    assert.equal(ui.favoriteCardHtml(BARE), GOLDEN[`fav_bare_${lang}`], `${lang} unavailable, no cover (the French label has a curly apostrophe)`);
  }
  assert.match(loadUi("fr").favoriteCardHtml(BARE), /aria-label="Ajouter L’Étranger &lt;b&gt; aux favoris"/);
});

// ---- the card on the server (views/marketing/collection.ejs) has the same structure as the one the browser draws ----

// Every opening tag as "tag.class.class[attr,attr]" (attribute NAMES only, sorted). The server template has EJS inside:
// remove the <% %> tags, which leaves the markup of every branch of its ifs, so it is compared with the union of the
// browser cards for every branch (cover or none, author, price, heart).
function shapes(html) {
  const out = new Set();
  for (const m of html.matchAll(/<([a-z][a-z0-9]*)\b((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*\/?>/gi)) {
    const attrs = [...m[2].replace(/="[^"]*"/g, "=").matchAll(/\s([a-z-]+)/gi)].map((a) => a[1]).filter((a) => !["class", "aria-hidden"].includes(a));
    const cls = (/\sclass="([^"]*)"/.exec(m[2]) || [null, ""])[1].split(/\s+/).filter(Boolean).sort();
    out.add(`${m[1]}${cls.map((c) => "." + c).join("")}[${attrs.sort().join(",")}]`);
  }
  return out;
}

test("collection.ejs and the Browse card have the same markup structure: same tags, classes and attributes", () => {
  const ejs = fs.readFileSync(path.join(ROOT, "views", "marketing", "collection.ejs"), "utf8");
  const start = ejs.indexOf('<div class="bk-book">');
  const end = ejs.indexOf("<% }) %>", start);
  assert.ok(start > 0 && end > start, "the card is still in collection.ejs");
  // `\n` and attribute values containing EJS (<%= b.id %>) become plain text inside the quotes
  const server = shapes(ejs.slice(start, end).replace(/<%[\s\S]*?%>/g, ""));
  const ui = loadUi("en");
  const browser = new Set([
    ...shapes(ui.bookCardHtml(FULL, true)),
    ...shapes(ui.bookCardHtml(BARE, true)),
    ...shapes(ui.bookCardHtml({ ...FULL, author: "", price: null }, true)),
  ]);
  assert.deepEqual([...server].sort(), [...browser].sort(), "the server card and the browser card differ: change both together");
  assert.ok(server.has("div.bk-book[]") && server.has("button.favorite-toggle[aria-label,aria-pressed,data-book-id,type]"), "the shapes were really read");
});
