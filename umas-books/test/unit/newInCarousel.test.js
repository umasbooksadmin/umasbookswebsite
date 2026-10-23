// The New In carousel and "See All New In" on Browse Books: the CSS and script rules checked from source (the browser
// checks are e2e steps G91 and G92), and the New In definition (lib/latestArrivals.js newIn) with a fake database.
// If a rule is deleted the carousel clips cards again: titles cut to two lines, a card half-visible after an arrow click,
// the last card stuck half-cut, or "See All" showing only 24 books beside a carousel.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const latest = require("../../src/lib/latestArrivals");
const { newIn, NEW_IN_DAYS, NEW_IN_MIN } = latest;
const booksRoute = fs.readFileSync(path.join(__dirname, "..", "..", "src", "routes", "books.js"), "utf8");
const lib = fs.readFileSync(path.join(__dirname, "..", "..", "src", "lib", "latestArrivals.js"), "utf8");

const ROOT = path.join(__dirname, "..", "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const flat = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\s+/g, " ");
const { loadSheet } = require("../helpers/css");
const books = loadSheet("assets/books.css");
const bookText = read("assets", "books.css");
const js = read("umas-books", "public", "page-books.js");
const ejs = read("umas-books", "views", "marketing", "books.ejs");

test("card text is never cut: no line-clamp or ellipsis on the New In titles and authors, long words wrap", () => {
  assert.doesNotMatch(flat(bookText), /line-clamp/, "no line-clamp anywhere in books.css");
  assert.equal(books.getDecl(".bk-track .bk-book .a", "text-overflow", { at: "*" }), undefined, "authors are not ellipsized");
  assert.notEqual(books.getDecl(".bk-track .bk-book .a", "white-space", { at: "*" }), "nowrap", "authors wrap");
  for (const sel of [".bk-track .bk-book .t", ".bk-track .bk-book .a"]) assert.equal(books.getDecl(sel, "overflow-wrap"), "anywhere", sel);
});

test("the track shows a whole number of cards, every card is a snap point, and there is room after the last one", () => {
  const track = books.getRule(".bk-track");
  assert.equal(track["scroll-snap-type"], "x mandatory");
  assert.equal(track["container-type"], "inline-size");
  assert.equal(track["scroll-padding-inline"], "6px", "scroll-padding keeps the first card and its outline inside the box");
  const card = books.getRule(".bk-track .bk-book");
  assert.equal(card.flex, "0 0 calc((100cqw - (var(--per) - 1) * var(--gap)) / var(--per))");
  assert.equal(card["scroll-snap-align"], "start");
  assert.equal(books.getDecl(".bk-track::after", "flex"), "0 0 var(--bk-end, 0px)", "end room so the last page can start at the left edge");
  for (const w of [440, 640, 880, 1120]) assert.ok(books.hasRule(".bk-track .bk-book", { at: `@container (min-width: ${w}px)` }), `${w}px step`);
  assert.doesNotMatch(String(card.flex), /^0 0 1[0-9]{2}px/, "no fixed card width");
});

test("the arrows are 44px, have a focus outline, are disabled at the ends and are not hidden on a mouse-driven narrow window", () => {
  assert.equal(books.getDecl(".bk-carousel .arrow", "width"), "44px");
  assert.equal(books.getDecl(".bk-carousel .arrow", "height"), "44px");
  assert.match(books.getDecl(".bk-carousel .arrow:focus-visible", "outline"), /^3px solid/);
  assert.ok(books.hasRule(".bk-carousel .arrow:disabled"));
  assert.equal(books.getDecl(".bk-carousel .arrow", "display", { at: "@media (max-width: 620px) and (pointer: coarse)" }), "none");
  assert.equal(books.getDecl(".bk-carousel .arrow", "display", { at: "@media (max-width: 620px)" }), undefined, "arrows are not hidden on a mouse-driven narrow window");
});

test("the arrows scroll to a measured card edge (not 80% of the width) from where the last click was heading, and keys work", () => {
  assert.doesNotMatch(js, /clientWidth \* 0\.8/);
  assert.match(js, /track\.scrollTo\(\{ left: stopAt\(cards, i\)/);
  assert.match(js, /var from = heading != null \? heading : nearest\(cards\)/, "rapid clicks add up");
  assert.match(js, /nextBtn\.disabled = /);
  assert.match(js, /prevBtn\.disabled = /);
  assert.match(js, /e\.key !== 'ArrowRight' && e\.key !== 'ArrowLeft'/);
  assert.match(js, /new ResizeObserver/, "a resize or zoom re-aligns");
});

test("the carousel is only on the plain Browse view: hidden for a search, a genre or See All, and sent hidden by the server", () => {
  assert.match(js, /newSection\.hidden = !!\(state\.q \|\| state\.genre \|\| state\.isNew\)/);
  assert.match(ejs, /<section class="bk-new"[^>]*newInHidden[^>]*>/);
  assert.ok(books.hasRule(".bk-new[hidden]"));
});

test("See All New In pages through /api/books/new-in with Show more and no count, 24 at a time, not a capped search", () => {
  assert.doesNotMatch(js, /latest-arrivals\?days=0&limit=24/);
  assert.match(js, /\/new-in\?offset=' \+ offset \+ '&limit=24/);
  assert.match(js, /cache\[url\] = data/);
  for (const key of ["bk.more", "bk.results.new"]) {
    assert.equal((ejs.match(new RegExp(`"${key.replace(".", "\\.")}":`, "g")) || []).length, 2, `${key} in English and French`);
  }
});

test("the carousel loads New In in batches (no all=1, no 12-book limit), the page and the API stay small, and no book is hidden", () => {
  assert.doesNotMatch(js, /new-in\?all=1/, "the carousel never asks for everything at once");
  assert.match(js, /var NEW_IN_BATCH = 60/);
  assert.match(js, /'\/new-in\?offset=' \+ offset \+ '&limit=' \+ NEW_IN_BATCH/);
  assert.match(js, /getJSON\(newInBatchUrl\(0\)/, "first batch: the newest 60");
  assert.match(js, /makeCarousel\(track, [^\n]*'\.bk-book', \{\s*hasMore:/, "only the New In carousel has a loadMore hook");
  assert.match(js, /makeCarousel\(genreList, [^\n]*'\.bk-genre'\);/, "the genres carousel is unchanged");
  assert.match(js, /nextBtn\.disabled = hasMore\(\) \? false :/, "Next is never greyed out while more batches remain");
  assert.doesNotMatch(booksRoute, /req\.query\.all/, "the unbounded all=1 mode is gone");
  assert.match(booksRoute, /newInPage\(pool,/);
  assert.equal(latest.NEW_IN_MAX, undefined, "no maximum on the list itself (batches are only how it is delivered)");
  assert.doesNotMatch(read("umas-books", "src", "app.js"), /newIn\(pool, \{ limit: null \}\)/, "the no-JavaScript list is a fixed handful, not the whole list");
  assert.match(read("umas-books", "src", "app.js"), /newInPage\(pool, \{ offset: 0, limit: 36 \}\)/);
});

test("newIn orders by the timestamp the copy was added (created_at DESC, then copy id DESC), never by acquired_at", () => {
  const sql = lib.slice(lib.indexOf("async function newIn"));
  assert.match(sql, /MAX\(c\.created_at\) AS newest_copy_at/);
  assert.match(sql, /row_number\(\) OVER \(ORDER BY p\.newest_copy_at DESC, p\.newest_copy_id DESC\)/);
  assert.match(sql, /ORDER BY r\.rn/);
  assert.doesNotMatch(sql, /acquired_at/, "acquired_at is only a date");
});

test("newIn: returns the page the database sent with the total and a next offset, and the total even for an empty page", async () => {
  assert.deepEqual([NEW_IN_DAYS, NEW_IN_MIN], [60, 40]);
  const seen = [];
  const pool = (total, ids) => ({ query: async (sql, params) => { seen.push(params); return { rows: ids.length ? ids.map((id) => ({ total, id })) : [{ total, id: null }] }; } });
  let r = await newIn(pool(300, Array.from({ length: 24 }, (_, i) => i + 1)), { offset: 0, limit: 24 });
  assert.deepEqual([r.total, r.rows.length, r.nextOffset], [300, 24, 24], "300 is not capped at 200");
  assert.deepEqual(seen[0], [60, 40, 0, 24]);
  r = await newIn(pool(300, Array.from({ length: 12 }, (_, i) => i + 1)), { offset: 288, limit: 24 });
  assert.deepEqual([r.total, r.rows.length, r.nextOffset], [300, 12, null]);
  r = await newIn(pool(300, Array.from({ length: 300 }, (_, i) => i + 1)), { limit: null });
  assert.deepEqual([r.rows.length, r.nextOffset], [300, null]);
  assert.equal(seen[2][3], null, "no limit is sent to the database");
  r = await newIn(pool(40, []), { offset: 90, limit: 24 });
  assert.deepEqual([r.total, r.rows.length, r.nextOffset], [40, 0, null]);
  r = await newIn(pool(0, []), {});
  assert.deepEqual([r.total, r.rows.length, r.nextOffset], [0, 0, null]);
});

test("genre and search results page like See All New In: paged=1, 24 at a time, Show more, no count line", () => {
  assert.match(js, /baseUrl \+ '&paged=1&offset=' \+ offset \+ '&limit=24'/);
  assert.doesNotMatch(js, /countEl|bk-results-count|bk\.new\.count/, "no book count anywhere on the Browse page");
  assert.doesNotMatch(ejs, /bk-results-count|bk\.new\.count/);
  assert.match(booksRoute, /req\.query\.paged === "1"/);
});

test("newInPage: batches of the one cached list: clamps limit and offset, same order across batches, one query for many requests", async () => {
  const { newInPage, NEW_IN_MAX_LIMIT, NEW_IN_MAX_OFFSET } = latest;
  assert.equal(process.env.NODE_ENV === "test", false, "this unit test runs with the cache on");
  const total = 250;
  let queries = 0;
  const pool = { query: async () => { queries++; return { rows: Array.from({ length: total }, (_, i) => ({ total, id: total - i })) }; } };
  const ids = [];
  let next = 0;
  for (let guard = 0; next != null && guard < 10; guard++) {
    const page = await newInPage(pool, { offset: next, limit: 60 });
    assert.equal(page.total, total);
    assert.ok(page.rows.length <= 60);
    ids.push(...page.rows.map((r) => r.id));
    next = page.nextOffset;
  }
  assert.deepEqual(ids, Array.from({ length: total }, (_, i) => total - i), "no gap, no duplicate, same order; boundary at 60 / 120 / 180 / 240");
  assert.equal(queries, 1, "five batches, one database query");
  assert.equal((await newInPage(pool, { limit: 1e9 })).rows.length, NEW_IN_MAX_LIMIT, "limit is clamped to 100");
  assert.equal((await newInPage(pool, { limit: -5 })).rows.length, 1);
  assert.equal((await newInPage(pool, { limit: "abc" })).rows.length, 24, "garbage limit = default");
  for (const off of [1e22, NEW_IN_MAX_OFFSET + 1, 2 ** 53, Infinity, total, total + 1]) {
    const p = await newInPage(pool, { offset: off, limit: 24 });
    assert.deepEqual([p.rows.length, p.nextOffset, p.total], [0, null, total], `offset ${off} is an empty batch`);
  }
  assert.equal((await newInPage(pool, { offset: -3, limit: 5 })).rows[0].id, total, "negative offset = start");
  assert.equal((await newInPage(pool, { offset: "x", limit: 5 })).rows[0].id, total, "garbage offset = start");
  assert.equal(queries, 1);
  latest.clearBrowseCaches(pool);
  await newInPage(pool, {});
  assert.equal(queries, 2, "clearBrowseCaches forgets the list");
});
