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
const css = flat(read("assets", "books.css"));
const js = read("umas-books", "public", "page-books.js");
const ejs = read("umas-books", "views", "marketing", "books.ejs");

test("card text is never cut: no line-clamp or ellipsis on the New In titles and authors, long words wrap", () => {
  assert.doesNotMatch(css, /line-clamp/, "no line-clamp anywhere in books.css");
  assert.doesNotMatch(css, /\.bk-track \.bk-book \.a \{[^}]*text-overflow/, "authors are not ellipsized");
  assert.doesNotMatch(css, /\.bk-track \.bk-book \.a \{[^}]*white-space: nowrap/, "authors wrap");
  assert.match(css, /\.bk-track \.bk-book \.t, \.bk-track \.bk-book \.a \{[^}]*overflow-wrap: anywhere/);
});

test("the track shows a whole number of cards, every card is a snap point, and there is room after the last one", () => {
  assert.match(css, /\.bk-track \{[^}]*scroll-snap-type: x mandatory[^}]*container-type: inline-size/);
  assert.match(css, /\.bk-track \{[^}]*scroll-padding-inline: 6px/, "scroll-padding keeps the first card and its outline inside the box");
  assert.match(css, /\.bk-track \.bk-book \{[^}]*flex: 0 0 calc\(\(100cqw - \(var\(--per\) - 1\) \* var\(--gap\)\) \/ var\(--per\)\)[^}]*scroll-snap-align: start/);
  assert.match(css, /\.bk-track::after \{[^}]*flex: 0 0 var\(--bk-end, 0px\)/, "end room so the last page can start at the left edge");
  for (const w of [440, 640, 880, 1120]) assert.match(css, new RegExp(`@container \\(min-width: ${w}px\\)`), `${w}px step`);
  assert.doesNotMatch(css, /\.bk-track \.bk-book \{[^}]*flex: 0 0 1[0-9]{2}px/, "no fixed card width");
});

test("the arrows are 44px, have a focus outline, are disabled at the ends and are not hidden on a mouse-driven narrow window", () => {
  assert.match(css, /\.bk-carousel \.arrow \{[^}]*width: 44px; height: 44px/);
  assert.match(css, /\.bk-carousel \.arrow:focus-visible \{[^}]*outline: 3px solid/);
  assert.match(css, /\.bk-carousel \.arrow:disabled/);
  assert.match(css, /@media \(max-width: 620px\) and \(pointer: coarse\) \{ \.bk-carousel \.arrow \{ display: none/);
  assert.doesNotMatch(css, /@media \(max-width: 620px\) \{[^}]*\.bk-carousel \.arrow \{ display: none/);
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
  assert.match(css, /\.bk-new\[hidden\]/);
});

test("See All New In pages through /api/books/new-in with Show more and no count, 24 at a time, not a capped search", () => {
  assert.doesNotMatch(js, /latest-arrivals\?days=0&limit=24/);
  assert.match(js, /\/new-in\?offset=' \+ offset \+ '&limit=24/);
  assert.match(js, /cache\[url\] = data/);
  for (const key of ["bk.more", "bk.results.new"]) {
    assert.equal((ejs.match(new RegExp(`"${key.replace(".", "\\.")}":`, "g")) || []).length, 2, `${key} in English and French`);
  }
});

test("the carousel asks for the WHOLE New In list in one request (no 12-book limit) and the API has no cap", () => {
  assert.match(js, /getJSON\(API \+ '\/new-in\?all=1'/, "the carousel fetches everything at once");
  assert.doesNotMatch(js, /new-in\?offset=0&limit=12/);
  assert.match(booksRoute, /req\.query\.all === "1"/);
  assert.equal(latest.NEW_IN_MAX, undefined, "no maximum any more");
  assert.doesNotMatch(lib, /NEW_IN_MAX|max = /);
  assert.match(read("umas-books", "src", "index.js"), /newIn\(pool, \{ limit: null \}\)/, "the no-JavaScript list holds every new book too");
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
