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
  assert.match(loadUi("fr").favoriteCardHtml(BARE), /<span class="fav-name">Ajouter <span lang="en">L’Étranger &lt;b&gt;<\/span> aux favoris<\/span>/);
});

// ---- the card on the server (views/marketing/partials/book_card.ejs, used by views/marketing/collection.ejs) is the browser card ----

// The partial as the server renders it (the helpers res.locals carries), in a page language, the way renderMarketing finishes a French page.
function serverCard(b, lang) {
  const ejs = require("ejs");
  const { bookText, favName } = require("../../src/lib/bookText");
  const { formatEuro } = require("../../src/lib/money");
  const { frenchTypography } = require("../../src/lib/frenchTypography");
  const file = path.join(ROOT, "views", "marketing", "partials", "book_card.ejs");
  const html = ejs.render(fs.readFileSync(file, "utf8"), {
    b, lang, tr: (en, fr) => (lang === "fr" ? fr : en), eur: (n) => formatEuro(n, lang), coverSrcset: serverCoverSrcset,
    bookText: (t, l) => bookText(t, lang, l), favName: (t, l) => favName(t, lang, l),
  }, { filename: file, views: [path.join(ROOT, "views")] });
  return lang === "fr" ? frenchTypography(html) : html;
}
// What the two renderers may differ in, and nothing else: EJS writes " as &#34; (the same character), and the server's heart svg is aria-hidden
// (it is decorative; the browser's is not marked, the button has its own name). A French page's curly apostrophe in a title (frenchTypography, on
// the whole server page) is a straight one in the browser card: public/page-collection.js curls the apostrophes of the cards it adds, so the page is
// consistent; Browse leaves its titles as they are.
const sameHtml = (html) => html.replace(/&#34;/g, "&quot;").replace(/<svg ([^>]*) aria-hidden="true">/g, "<svg $1>").replace(/&#39;/g, "’").trim();

test("collection.ejs's card (book_card.ejs) and the Browse card (ui.js bookCardHtml) are the same HTML, byte for byte, in English and French", () => {
  const cases = [
    { id: 12, title: "Le Petit Prince", authors: "Antoine de Saint-Exupéry", cover_url: `/img/${HASH}.jpg`, min_price: 7.5 },                 // everything
    { id: 13, title: "Bare Book <b>", authors: "", cover_url: null, min_price: null },                                                     // no cover, author, price
    { id: 14, title: "Quotes \"and\" & ampersands", authors: "A & B", cover_url: "/img/x.jpg", min_price: 0 },                             // escaping, a cover with no variants, a price of 0
    { id: 15, title: "L'Étranger", authors: "Albert Camus", cover_url: null, min_price: 12 },                                              // an apostrophe (curly in French)
  ];
  for (const lang of ["en", "fr"]) {
    const ui = loadUi(lang);
    for (const b of cases) {
      const browser = ui.bookCardHtml({ id: b.id, title: b.title, author: b.authors, price: b.min_price, coverUrl: b.cover_url, url: `/books/${b.id}` }, true);
      assert.equal(sameHtml(serverCard(b, lang)), sameHtml(browser), `${lang} book ${b.id}: the server card and the browser card differ: change both together`);
    }
  }
});
