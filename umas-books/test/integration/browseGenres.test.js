// The Browse Books genre buttons are drawn by the server from the managed genres (Admin > Genres, table managed_genres;
// src/lib/browseGenres.js); public/page-books.js only reads them back. The seeded data must give the page exactly what it
// had when the buttons were a fixed list: test/fixtures/browseGenres.golden.json is that list (14 buttons, order, slug,
// topic, colours, icon, English and French label). Book genres are English on both sites since 2026-10-28: on /fr/ the
// genre buttons show the English label (marked lang="en"); only the All Genres button is French. Adding, hiding and renaming a managed genre changes the page.
//
// Port 6491 is reserved for this file.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { startTestApp } = require("../helpers/testApp");
const golden = require("../fixtures/browseGenres.golden.json");

const PORT = 6491;
let app;
let db;
before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  db = new Client({ connectionString: app.databaseUrl, ssl: false });
  await db.connect();
});
after(async () => { await db.end(); app.stop(); });

const q = async (sql, params) => (await db.query(sql, params)).rows;
const page = async (lang, path = "/books.html") => (await fetch(`${app.base}${path}`, { headers: { cookie: `umasbooks_lang=${lang}` } })).text();
const listOf = (html) => html.match(/<div class="bk-track bk-tiles" id="bk-genre-list"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/section>/)[1];
const buttonsOf = (html) => listOf(html).match(/<button type="button" class="bk-genre"[\s\S]*?<\/button>/g);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// The button exactly as the page drew it when the list was fixed.
const expectedButton = (g, i, label) =>
  `<button type="button" class="bk-genre" data-index="${i}" data-slug="${g.slug}" data-topic="${esc(g.topic)}"><span class="chip" style="background:${g.bg};color:${g.fg}"><svg ${golden.iconAttrs} aria-hidden="true">${g.svg}</svg></span><span data-i18n="g.${g.slug}">${esc(label)}</span></button>`;
const labelsOf = (html) => [...listOf(html).matchAll(/<span data-i18n="g\.[a-z0-9-]+"(?: lang="en")?>([^<]*)<\/span>/g)].map((m) => m[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'"));

test("the seeded genre buttons are identical to the fixed list the page had before (English)", async () => {
  const buttons = buttonsOf(await page("en"));
  assert.equal(buttons.length, golden.genres.length);
  golden.genres.forEach((g, i) => assert.equal(buttons[i], expectedButton(g, i, g.en), g.slug));
  assert.deepEqual(golden.genres.map((g) => g.slug), ["fiction", "children", "ya", "nonfiction", "classics", "mystery", "romance", "biography", "health", "arts", "travel", "food", "home", "all"]);
  assert.equal(golden.genres[golden.genres.length - 1].topic, "", "All Genres runs the empty topic: every book");
});

test("French: the same buttons with the ENGLISH genre labels marked lang=en; All Genres stays French (page and /fr/ path)", async () => {
  for (const path of ["/books.html", "/fr/books.html"]) {
    const html = await page("fr", path);
    // (the French page's typography makes the apostrophe the curly one, in English text too)
    assert.deepEqual(labelsOf(html).map((l) => l.replace(/\u2019/g, "'")), golden.genres.map((g) => (g.slug === "all" ? g.fr : g.en)), path);
    for (const g of golden.genres) {
      const span = listOf(html).match(new RegExp(`<span data-i18n="g\\.${g.slug}"[^>]*>`))[0];
      assert.equal(span.includes(' lang="en"'), g.slug !== "all", `${path} ${g.slug}: lang mark`);
    }
    buttonsOf(html).forEach((b, i) => assert.ok(b.startsWith(`<button type="button" class="bk-genre" data-index="${i}" data-slug="${golden.genres[i].slug}"`)));
  }
});

test("the English labels are the ones the page had", async () => {
  assert.deepEqual(labelsOf(await page("en")), ["Fiction", "Children's Books", "Young Adult", "Non-Fiction", "Classics", "Mystery & Thriller", "Romance", "Biography & Memoir", "Health & Wellness", "Arts & Crafts", "Travel", "Food & Drink", "Home & Garden", "All Genres"]);
});

test("the old ?genre= links still select the right genre: every old slug is a button the page script can find", async () => {
  const html = await page("en", "/books.html?genre=children");
  const slugs = buttonsOf(html).map((b) => b.match(/data-slug="([^"]+)"/)[1]);
  for (const g of golden.genres) assert.ok(slugs.includes(g.slug), `?genre=${g.slug}`);
  assert.equal(buttonsOf(html)[1].match(/data-topic="([^"]*)"/)[1], "juvenile,child,picture book,baby", "the search the button runs is unchanged");
  const js = await (await fetch(`${app.base}/page-books.js`)).text();
  assert.ok(js.includes("SLUGS.indexOf(state.genre)"), "the page script selects the button by slug");
});

test("a new managed genre shows as a button with the generic icon, its name as label and as search word; the same English name on /fr/", async () => {
  await q("INSERT INTO managed_genres (name_en, sort_order, browse_slug, browse_order, colour, icon) VALUES ('Gardening', 40, 'gardening', 40, 'moss', 'book')");
  const en = buttonsOf(await page("en"));
  assert.equal(en.length, golden.genres.length + 1);
  const added = en.find((b) => b.includes('data-slug="gardening"'));
  assert.ok(added.includes('data-topic="Gardening"'), "a genre with no search words searches its own name");
  assert.ok(added.includes('<span data-i18n="g.gardening">Gardening</span>'));
  assert.ok(added.includes("background:#e0ebdc;color:#43523a"), "colour moss");
  assert.ok(added.includes("M6 4.5h11"), "the generic book icon");
  assert.ok(en[en.length - 1].includes('data-slug="all"'), "All Genres stays last");
  assert.ok(buttonsOf(await page("fr")).find((b) => b.includes('data-slug="gardening"')).includes(' lang="en">Gardening</span>'), "a stored French name is not used");
  // the page's data-index is the position in the list, so the script's SLUGS array lines up
  en.forEach((b, i) => assert.ok(b.includes(`data-index="${i}"`)));
});

test("a genre with ZERO books can be hidden and shown; hiding removes its button", async () => {
  assert.equal((await q("SELECT count(*)::int AS n FROM books"))[0].n, 0, "no book at all in this database");
  await q("UPDATE managed_genres SET show_on_browse = false WHERE browse_slug = 'travel'");
  assert.ok(!buttonsOf(await page("en")).some((b) => b.includes('data-slug="travel"')));
  assert.ok(!(await page("en", "/books.html?genre=travel")).includes('data-slug="travel"'));
  await q("UPDATE managed_genres SET show_on_browse = true WHERE browse_slug = 'travel'");
  assert.ok(buttonsOf(await page("en")).some((b) => b.includes('data-slug="travel"')));
});

test("the button order follows the Browse position; a button label can be changed", async () => {
  await q("UPDATE managed_genres SET browse_order = 0 WHERE browse_slug = 'home'");
  assert.ok(buttonsOf(await page("en"))[0].includes('data-slug="home"'));
  await q("UPDATE managed_genres SET browse_order = 13 WHERE browse_slug = 'home'");
  await q("UPDATE managed_genres SET browse_label_en = 'Kids & Co' WHERE browse_slug = 'children'");
  assert.ok((await page("en")).includes('<span data-i18n="g.children">Kids &amp; Co</span>'));
  await q("UPDATE managed_genres SET browse_label_en = $1 WHERE browse_slug = 'children'", ["Children's Books"]);
});

test("a book labelled with a managed genre is found by its button's search (topic), after Update all books", async () => {
  const [b] = await q("INSERT INTO books (title, categories) VALUES ('Garden book', 'Gardening') RETURNING id");
  await q("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', 5)", [b.id]);
  const res = await (await fetch(`${app.base}/api/books/search?q=&topic=${encodeURIComponent("Gardening")}`)).json();
  assert.deepEqual(res.map((x) => x.title), ["Garden book"]);
});

test("the sitemap and the language alternates do not depend on the genres", async () => {
  const before = await (await fetch(`${app.base}/sitemap-pages.xml`)).text();
  const head = (html) => html.match(/<link rel="alternate"[^>]*>/g);
  const headBefore = head(await page("en"));
  await q("INSERT INTO managed_genres (name_en, sort_order, browse_slug, browse_order) VALUES ('Sitemap test', 41, 'sitemap-test', 41)");
  const after1 = await (await fetch(`${app.base}/sitemap-pages.xml`)).text();
  assert.equal(after1, before);
  assert.ok(!after1.includes("genre="));
  assert.deepEqual(head(await page("en")), headBefore);
  await q("DELETE FROM managed_genres WHERE browse_slug = 'sitemap-test'");
});

test("the shared browser scripts load before the page script on Browse and on the pages that draw cards", async () => {
  const order = (html, names) => names.map((n) => html.indexOf(`/${n}.js`));
  const books = await page("en");
  const i = order(books, ["books-state", "ui", "carousel", "page-books"]);
  assert.ok(i.every((x) => x > 0) && [...i].sort((a, b) => a - b).join() === i.join(), `Browse script order ${i}`);
  const events = await (await fetch(`${app.base}/events.html`)).text();
  assert.ok(events.indexOf("/ui.js") > 0 && events.indexOf("/ui.js") < events.indexOf("/page-events.js"));
  const home = await (await fetch(`${app.base}/`)).text();
  assert.ok(home.indexOf("/ui.js") > 0 && home.indexOf("/ui.js") < home.indexOf("/blog.js"), "assets/blog.js needs ui.js first");
  const fav = await (await fetch(`${app.base}/favorites`)).text();
  assert.ok(fav.indexOf("/ui.js") > 0 && fav.indexOf("/ui.js") < fav.indexOf("/favorites-page.js"));
  const login = await (await fetch(`${app.base}/login`)).text();
  assert.ok(!login.includes("/ui.js"), "pages that draw no cards do not load it");
  const js = await fetch(`${app.base}/ui.js`);
  assert.equal(js.status, 200);
});
