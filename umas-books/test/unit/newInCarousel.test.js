// The New In carousel and "See All New In" on Browse Books: the CSS and script rules checked from source (the browser
// checks are e2e steps G91 and G92), and the New In definition (lib/latestArrivals.js newIn) with a fake database.
// If a rule is deleted the carousel clips cards again: titles cut to two lines, a card half-visible after an arrow click,
// the last card stuck half-cut, or "See All" showing only 24 books beside a carousel.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { newIn, NEW_IN_DAYS, NEW_IN_MIN, NEW_IN_MAX } = require("../../src/lib/latestArrivals");

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

test("See All New In pages through /api/books/new-in with a count and Show more, 24 at a time, not a capped search", () => {
  assert.doesNotMatch(js, /latest-arrivals\?days=0&limit=24/);
  assert.match(js, /\/new-in\?offset=' \+ offset \+ '&limit=24/);
  assert.match(js, /cache\[url\] = data/);
  for (const key of ["bk.new.count", "bk.new.count1", "bk.more", "bk.results.new"]) {
    assert.equal((ejs.match(new RegExp(`"${key.replace(".", "\\.")}":`, "g")) || []).length, 2, `${key} in English and French`);
  }
});

test("newIn: last 60 days, at least the 40 newest, at most 200, paged with a total and a next offset", async () => {
  assert.deepEqual([NEW_IN_DAYS, NEW_IN_MIN, NEW_IN_MAX], [60, 40, 200]);
  const day = 86400000;
  const mk = (n, ageDays) => Array.from({ length: n }, (_, i) => ({ id: i + 1, newest_copy_at: new Date(Date.now() - (ageDays + i / 1000) * day) }));
  const poolOf = (rows) => ({ query: async (_sql, params) => ({ rows: rows.slice(0, params[0]) }) });
  // 10 recent + 100 old: the 40 newest
  let r = await newIn(poolOf([...mk(10, 1), ...mk(100, 90)]), { offset: 0, limit: 24 });
  assert.deepEqual([r.total, r.rows.length, r.nextOffset], [40, 24, 24]);
  r = await newIn(poolOf([...mk(10, 1), ...mk(100, 90)]), { offset: 24, limit: 24 });
  assert.deepEqual([r.total, r.rows.length, r.nextOffset], [40, 16, null]);
  // 150 recent: all 150, not 24
  r = await newIn(poolOf(mk(150, 5)), { offset: 120, limit: 48 });
  assert.deepEqual([r.total, r.rows.length, r.nextOffset], [150, 30, null]);
  // 300 recent: capped at 200
  r = await newIn(poolOf(mk(300, 5)), { offset: 0, limit: 48 });
  assert.equal(r.total, 200);
  // fewer than 40 books in the shop: all of them
  r = await newIn(poolOf(mk(7, 200)), {});
  assert.deepEqual([r.total, r.rows.length], [7, 7]);
});
