/* global document, window, getComputedStyle */
// The collection page's book list is the Browse genre results (maintainer decision 2026-10-26): the same markup and classes, the same grid
// CSS, the first 24 books in the HTML and "Show more" for the next 24 from GET /api/collections/:slug/books. Real app, throwaway database:
//   - the HTML: the shared results markup, 24 cards, a (hidden-until-script) Show more button only when more than 24 books exist
//   - the API: paging continuity in the page's order, clamping (never a 500), 404 for unpublished / unknown, EN and FR, public cache headers
//   - the French words the script draws match the Browse page's
//   - the collection stylesheet adds no rule of its own for the shared list classes (one owner per class: assets/books.css)
//   - in headless Chrome (skipped when there is none): the computed grid, card and button styles equal the Browse genre results at 320, 375, 768 and
//     1280 px, Show more adds the next 24 and moves focus to the first new book, the page never scrolls sideways, one book looks natural

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");
const { loadSheet } = require("../helpers/css");

const PORT = 6483;
let app;
let pool;
let browser;
let skipReason = null;
const slugs = {};

async function newShelf(slug, count, { published = true } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO curated_collections (slug, title_en, description_en, title_fr, description_fr, curation_prompt, published)
     VALUES ($1, 'Results Shelf', 'Gentle reads.', 'Étagère résultats', 'Des lectures douces.', 'x', $2) RETURNING id`,
    [slug, published]
  );
  const cid = rows[0].id;
  if (count) {
    // book n is shown at position n; every other title has a longer subtitle so cards differ in height; every 7th has no cover
    await pool.query(
      `WITH b AS (
         INSERT INTO books (title, authors, categories, categories_fr, binding, description, description_fr)
         SELECT ${"'" + slug + " Book '"} || lpad(g::text, 3, '0') || CASE WHEN g % 5 = 0 THEN ' with a much longer subtitle on a narrow card' ELSE '' END,
                'Author ' || g, 'Fiction', 'Fiction', 'trade', 'x', 'x'
         FROM generate_series(1, $1::int) g RETURNING id, title),
       c AS (INSERT INTO book_copies (book_id, condition, price, status) SELECT id, 'good', 5, 'in_stock' FROM b RETURNING 1)
       INSERT INTO curated_collection_books (collection_id, book_id, status, position)
       SELECT $2, id, 'approved', substring(title from 'Book ([0-9]+)')::int FROM b`,
      [count, cid]
    );
  }
  slugs[slug] = cid;
  return slug;
}

before(async () => {
  try {
    browser = await require("puppeteer").launch({ headless: true, args: ["--no-sandbox"] });
  } catch (err) {
    skipReason = `no headless Chrome available: ${String(err.message).split("\n")[0]}`;
  }
  app = await startTestApp({ port: PORT, isolated: true, env: { ANTHROPIC_API_KEY: "", ANON_SESSION_LIMIT: "100000" } });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  await newShelf("many-books", 60);
  await newShelf("exactly-24", 24);
  await newShelf("twenty-five", 25);
  await newShelf("one-book", 1);
  await newShelf("hidden-shelf", 30, { published: false });
});

after(async () => {
  if (browser) await browser.close();
  if (pool) await pool.end();
  if (app) await app.stop();
});

const get = (p) => fetch(`${app.base}${p}`);
const html = async (p) => (await get(p)).text();
const cards = (t) => (t.match(/<div class="bk-book">/g) || []).length;
const ids = (t) => [...t.matchAll(/<div class="bk-book">[\s\S]*?<a href="\/(?:fr\/)?books\/(\d+)"/g)].map((m) => Number(m[1]));
const api = async (slug, q = "") => { const r = await get(`/api/collections/${slug}/books${q}`); return { r, j: await r.json().catch(() => null) }; };
const orderedIds = async (slug) => (await pool.query(
  `SELECT b.id FROM curated_collection_books cb JOIN books b ON b.id = cb.book_id WHERE cb.collection_id = $1 ORDER BY cb.position, b.title_sort, b.id`, [slugs[slug]]
)).rows.map((r) => r.id);

// ---------- the HTML ----------

test("the page carries the Browse results markup: section.bk-results, div.bk-grid, .bk-more-row, .bk-covernote, the sr-only status line", async () => {
  for (const prefix of ["", "/fr"]) {
    const t = await html(`${prefix}/collections/many-books`);
    assert.match(t, /<section class="bk-results" id="bk-results" aria-labelledby="col-books-title" data-collection="many-books" data-next-offset="24">/);
    assert.match(t, /<div class="bk-grid" id="bk-results-grid"><div class="col-item"><div class="bk-book">/, "each card is the shared card inside a .col-item (its genre and why lines under it)");
    assert.match(t, /<div class="bk-more-row"><button type="button" class="btn btn-outline" id="bk-more" data-i18n="bk\.more" hidden>(Show more|Voir plus)<\/button><\/div>/);
    assert.match(t, /<p class="bk-covernote">/);
    assert.match(t, /<p class="bk-sr" id="bk-status" role="status" aria-live="polite"><\/p>/);
    assert.match(t, /<script src="\/ui\.js[^"]*"><\/script>\s*<script src="\/cart-add\.js[^"]*"><\/script>\s*<script src="\/page-collection\.js[^"]*"><\/script>/);
    assert.ok(!/class="[^"]*\bcol-books\b/.test(t), "no collection-only wrapper class for the list");
  }
  assert.match(await html("/fr/collections/many-books"), /hidden>Voir plus<\/button>/);
});

test("the first 24 books are in the HTML, in the admin's order, and the Show more button exists only when more than 24 books do", async () => {
  const t = await html("/collections/many-books");
  assert.equal(cards(t), 24);
  assert.deepEqual(ids(t), (await orderedIds("many-books")).slice(0, 24));
  assert.match(t, /data-next-offset="24"/);
  assert.equal(cards(await html("/collections/twenty-five")), 24);
  assert.match(await html("/collections/twenty-five"), /data-next-offset="24"/);
  for (const slug of ["exactly-24", "one-book"]) {
    const s = await html(`/collections/${slug}`);
    assert.equal(cards(s), slug === "one-book" ? 1 : 24);
    assert.ok(!s.includes("data-next-offset"), `${slug}: nothing more to load`);
    assert.ok(s.includes('id="bk-more"') && /id="bk-more"[^>]* hidden>/.test(s), `${slug}: the button is in the page but hidden, the script never shows it`);
  }
});

test("a card on the page and its twin in the API response carry the same book data (EN and FR)", async () => {
  const { j } = await api("many-books", "?offset=0&limit=3");
  const en = await html("/collections/many-books");
  const fr = await html("/fr/collections/many-books");
  for (const b of j.books) {
    assert.match(en, new RegExp(`<a href="/books/${b.id}">`));
    assert.match(fr, new RegExp(`<a href="/fr/books/${b.id}">`));
    assert.ok(en.includes(b.title.replace(/&/g, "&amp;")));
  }
});

test("an empty collection keeps its message and has no list, button or status script work to do", async () => {
  const slug = await newShelf("empty-shelf", 0);
  const t = await html(`/collections/${slug}`);
  assert.match(t, /<div class="col-empty" role="status">[\s\S]*found a new home/);
  assert.ok(!t.includes('id="bk-more"') && !t.includes('class="bk-grid"'));
});

test("the words page-collection.js draws are the Browse page's words, in both languages", async () => {
  const dict = (t) => JSON.parse(/<script type="application\/json" id="page-i18n-data">([\s\S]*?)<\/script>/.exec(t)[1].replace(/\\u003c/g, "<"));
  for (const prefix of ["", "/fr"]) {
    const browse = dict(await html(`${prefix}/books.html`));
    const col = dict(await html(`${prefix}/collections/many-books`));
    for (const lang of ["en", "fr"]) {
      assert.ok(Object.keys(col[lang]).length >= 7);
      for (const [k, v] of Object.entries(col[lang])) assert.equal(v, browse[lang][k], `${prefix || "/"} ${lang} ${k}`);
    }
  }
});

// ---------- the API ----------

test("API: pages continue where the page stops, in the page's order, each book once, nextOffset null at the end", async () => {
  const want = await orderedIds("many-books");
  const first = ids(await html("/collections/many-books"));
  let offset = 24;
  const got = [...first];
  let guard = 0;
  while (offset != null && guard++ < 10) {
    const { r, j } = await api("many-books", `?offset=${offset}&limit=24`);
    assert.equal(r.status, 200);
    assert.equal(j.total, 60);
    got.push(...j.books.map((b) => b.id));
    offset = j.nextOffset;
    if (offset != null) assert.equal(offset, got.length);
  }
  assert.deepEqual(got, want);
  // default limit is 24 and the first page of the API is the page's own 24
  const d = await api("many-books");
  assert.equal(d.j.books.length, 24);
  assert.deepEqual(d.j.books.map((b) => b.id), first);
  assert.equal(d.j.nextOffset, 24);
});

test("API: same JSON shape as /api/books/new-in and search (bookJson) plus genre and why, public cache and CORS headers, FR shares the data", async () => {
  const { r, j } = await api("many-books", "?offset=0&limit=1");
  assert.deepEqual(Object.keys(j), ["total", "nextOffset", "books"]);
  assert.deepEqual(Object.keys(j.books[0]), ["id", "title", "author", "coverUrl", "price", "buy", "url", "genre", "why"]);
  const ni = await (await get("/api/books/new-in?limit=1")).json();
  assert.deepEqual(Object.keys(j.books[0]).slice(0, 6), Object.keys(ni.books[0]));
  assert.equal(r.headers.get("cache-control"), "public, max-age=60, s-maxage=60");
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.equal(r.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal(typeof j.books[0].price, "number");
  assert.match(j.books[0].url, /\/books\/\d+$/);
  const fr = await (await get("/fr/api/collections/many-books/books?offset=0&limit=1")).json().catch(() => null);
  if (fr) assert.deepEqual(fr, j); // a /fr/ address, when the app answers one, is the same data (the card's link is made in the browser)
});

test("API: the last page, a page past the end, and hostile numbers answer 200 with a clamped or empty page, never a 500", async () => {
  const last = await api("many-books", "?offset=48&limit=24");
  assert.equal(last.j.books.length, 12);
  assert.equal(last.j.nextOffset, null);
  const exact = await api("exactly-24", "?offset=0&limit=24");
  assert.equal(exact.j.nextOffset, null);
  const past = await api("many-books", "?offset=60");
  assert.deepEqual([past.r.status, past.j.books.length, past.j.nextOffset, past.j.total], [200, 0, null, 60]);
  for (const q of ["?offset=1e22", "?offset=99999999999999999999999&limit=1000000000", "?limit=1e9", "?offset=-5&limit=-5", "?offset=abc&limit=abc", "?offset[]=1&limit[]=2", "?offset=1&offset=2", "?limit=0", "?offset=2147483648", "?offset=%00&limit=%00"]) {
    const { r, j } = await api("many-books", q);
    assert.equal(r.status, 200, q);
    assert.ok(Array.isArray(j.books) && j.books.length <= 48, `${q}: at most 48 books`);
  }
  assert.equal((await api("many-books", "?limit=1000000000")).j.books.length, 48, "limit is clamped to 48");
  assert.equal((await api("many-books", "?limit=-5")).j.books.length, 1, "a negative limit is 1");
  assert.deepEqual((await api("many-books", "?offset=1e22")).j.books, (await api("many-books", "?offset=0")).j.books, "garbage means the first page");
  const huge = await api("many-books", "?offset=99999999999999999999999");
  assert.deepEqual(huge.j.books, [], "a huge number is clamped, which is past the end");
});

test("API: an unpublished, unknown or malformed collection is a 404 (never cached), like the page", async () => {
  for (const slug of ["hidden-shelf", "no-such-shelf", "Bad_Slug", "a".repeat(200)]) {
    const { r } = await api(slug);
    assert.equal(r.status, 404, slug);
    assert.equal(r.headers.get("cache-control"), "no-store");
  }
  assert.equal((await get("/collections/hidden-shelf")).status, 404);
});

test("API: a book sold since the page was drawn leaves the next page (live stock), and an unpublished collection stops answering", async () => {
  const slug = await newShelf("live-shelf", 30);
  const before = (await api(slug, "?offset=24")).j;
  assert.equal(before.books.length, 6);
  await pool.query("UPDATE book_copies SET status = 'sold' WHERE book_id = $1", [before.books[0].id]);
  const after2 = (await api(slug, "?offset=24")).j;
  assert.equal(after2.total, 29);
  assert.ok(!after2.books.some((b) => b.id === before.books[0].id));
  await pool.query("UPDATE curated_collections SET published = FALSE WHERE slug = $1", [slug]);
  assert.equal((await api(slug)).r.status, 404);
});

// ---------- one owner per class ----------

test("assets/collections.css has no rule for the shared list (.bk-results, .bk-grid, .bk-book, .bk-more-row, .bk-covernote, .bk-sr): assets/books.css owns them", () => {
  const css = loadSheet("assets/collections.css");
  const own = [];
  css.root.walkRules((rule) => { for (const sel of rule.selectors) if (/\.bk-(results|grid|book|more-row|covernote|sr)\b|\.col-books\b/.test(sel)) own.push(sel); });
  assert.deepEqual(own, []);
});

// ---------- in a real browser ----------

async function withPage(t, fn, { width = 1280, js = true } = {}) {
  if (skipReason) return t.skip(skipReason);
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height: 900 });
    await page.setJavaScriptEnabled(js);
    await fn(page);
  } finally {
    await page.close();
  }
}

// What the eye sees of the list: columns, gaps, card boxes and the type in the first card, read from the computed styles.
const look = () => {
  const px = (n) => Math.round(n * 10) / 10;
  const grid = document.querySelector(".bk-grid");
  const card = grid.querySelector(".bk-book");
  const g = getComputedStyle(grid);
  const sec = getComputedStyle(grid.parentElement);
  const c = (sel) => { const el = card.querySelector(sel); const s = getComputedStyle(el); return { fs: s.fontSize, lh: s.lineHeight, mt: s.marginTop, color: s.color, ff: s.fontFamily, w: px(el.getBoundingClientRect().width), ar: s.aspectRatio, of: s.objectFit, bs: s.boxShadow }; };
  const heart = card.querySelector(".favorite-toggle");
  const hs = getComputedStyle(heart);
  const more = document.querySelector(".bk-more-row .btn");
  const ms = getComputedStyle(more);
  const note = document.querySelector(".bk-covernote");
  const ns = getComputedStyle(note);
  return {
    cols: g.gridTemplateColumns.split(" ").length, colGap: g.columnGap, rowGap: g.rowGap,
    sec: [sec.paddingTop, sec.paddingBottom, sec.paddingLeft],
    card: { w: px(card.getBoundingClientRect().width) }, cover: c(".cover"), t: c(".t"), a: c(".a"), p: c(".p"),
    heart: { w: hs.width, h: hs.height, top: hs.top, right: hs.right, bg: hs.backgroundColor, pos: hs.position },
    more: { mh: ms.minHeight, font: ms.fontSize, pad: ms.padding, border: ms.border },
    note: { fs: ns.fontSize, mt: ns.marginTop, op: ns.opacity },
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  };
};

test("the list looks exactly like the Browse genre results: grid, gaps, card, type, heart, button, note, at 320, 375, 768 and 1280 px", async (t) => {
  for (const width of [320, 375, 768, 1280]) {
    await withPage(t, async (page) => {
      await page.goto(`${app.base}/books.html?genre=fiction`, { waitUntil: "networkidle0" });
      await page.waitForSelector("#bk-results-grid .bk-book");
      await page.waitForSelector("#bk-more:not([hidden])");
      const genre = await page.evaluate(look);
      await page.goto(`${app.base}/collections/many-books`, { waitUntil: "networkidle0" });
      await page.waitForSelector("#bk-more:not([hidden])");
      const col = await page.evaluate(look);
      assert.deepEqual(col, genre, `${width} px: the collection list differs from the genre results`);
      assert.ok(col.overflow <= 0, `${width} px: the page scrolls sideways by ${col.overflow}px`);
    }, { width });
  }
});

test("Show more adds the next 24 with the Browse behaviour: focus on the first new book, the status line, the button gone after the last page", async (t) => {
  await withPage(t, async (page) => {
    await page.goto(`${app.base}/collections/many-books`, { waitUntil: "networkidle0" });
    const count = () => page.$$eval(".bk-grid .bk-book", (e) => e.length);
    assert.equal(await count(), 24);
    assert.equal(await page.$eval("#bk-more", (b) => b.hidden), false, "the script shows the button");
    await page.focus("#bk-more");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".bk-grid .bk-book").length === 48, { timeout: 8000 });
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelectorAll(".bk-grid .bk-book > a")[24]), true, "focus is on the 25th book");
    assert.equal(await page.$eval("#bk-more", (b) => b.hidden), false, "more remain");
    await page.waitForFunction(() => /More books added/.test(document.getElementById("bk-status").textContent), { timeout: 3000 });
    assert.equal(await page.$eval("#bk-status", (s) => /\d/.test(s.textContent)), false, "no count is announced");
    await page.click("#bk-more");
    await page.waitForFunction(() => document.querySelectorAll(".bk-grid .bk-book").length === 60, { timeout: 8000 });
    assert.equal(await page.$eval("#bk-more", (b) => b.hidden), true, "the last page hides the button");
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelectorAll(".bk-grid .bk-book > a")[48]), true, "focus is on the 49th book");
    const idsOnPage = await page.$$eval(".bk-grid .bk-book > a", (a) => a.map((x) => x.getAttribute("href").replace(/^.*\/books\//, "")));
    assert.equal(new Set(idsOnPage).size, 60, "each book once");
    assert.deepEqual(idsOnPage.map(Number), await orderedIds("many-books"));
    // the cards the script drew have the same elements and classes as the cards the server drew
    const shapes = await page.$$eval(".bk-grid .bk-book", (els) => els.map((el) => [...el.querySelectorAll("*")].map((n) => n.tagName + "." + String(n.className.baseVal ?? n.className)).join(" ")));
    for (const i of [24, 47, 59]) assert.ok(shapes.slice(0, 24).includes(shapes[i]), `card ${i + 1} drawn by the script matches the shape of a card the server drew`);
  });
});

test("French: Voir plus, curly apostrophes on the next cards, French links", async (t) => {
  await withPage(t, async (page) => {
    await pool.query("UPDATE books SET title = 'L''Étrange ' || title WHERE title LIKE 'many-books Book 030%'");
    await page.goto(`${app.base}/fr/collections/many-books`, { waitUntil: "networkidle0" });
    assert.equal(await page.$eval("#bk-more", (b) => b.textContent.trim()), "Voir plus");
    await page.click("#bk-more");
    await page.waitForFunction(() => document.querySelectorAll(".bk-grid .bk-book").length === 48, { timeout: 8000 });
    const hrefs = await page.$$eval(".bk-grid .bk-book > a", (a) => a.map((x) => x.getAttribute("href")));
    assert.ok(hrefs.every((h) => /\/fr\/books\/\d+$/.test(h)), "every card links to the French book page");
    const titles = await page.$$eval(".bk-grid .t", (e) => e.map((x) => x.textContent));
    assert.ok(titles.some((x) => x.startsWith("L’Étrange many-books Book 030")), "the title drawn by the script has a curly apostrophe, like the server's cards");
    assert.ok(!titles.some((x) => x.includes("'")));
    await page.waitForFunction(() => document.getElementById("bk-status").textContent === "Livres ajoutés aux résultats.", { timeout: 3000 });
  });
});

test("one book: a single card in the grid, no button, the page does not scroll sideways; and without JavaScript the first 24 books and no dead button", async (t) => {
  await withPage(t, async (page) => {
    await page.goto(`${app.base}/collections/one-book`, { waitUntil: "networkidle0" });
    assert.equal(await page.$$eval(".bk-grid .bk-book", (e) => e.length), 1);
    assert.equal(await page.$eval("#bk-more", (b) => b.hidden), true);
    const one = await page.evaluate(() => ({ w: document.querySelector(".bk-book").getBoundingClientRect().width, over: document.documentElement.scrollWidth - window.innerWidth }));
    assert.ok(one.w > 100 && one.over <= 0, JSON.stringify(one));
  }, { width: 375 });
  await withPage(t, async (page) => {
    await page.goto(`${app.base}/collections/many-books`, { waitUntil: "load" });
    assert.equal(await page.$$eval(".bk-grid .bk-book", (e) => e.length), 24, "without JavaScript: the first 24 books");
    assert.equal(await page.$eval("#bk-more", (b) => b.hidden), true, "and no button that would do nothing");
  }, { js: false });
});
