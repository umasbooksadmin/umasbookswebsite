// Phone layout: the CSS and markup rules that stop a page from being wider than the screen. These are source
// checks (no browser, no database): the browser checks are the e2e steps G82 and A102 and the developer tool
// scripts/phone-overflow-audit.js. If someone removes one of these rules the page widens again on a phone.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const APP = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(APP, ...p), "utf8");
const readSite = (...p) => fs.readFileSync(path.join(APP, "..", ...p), "utf8");
// squeeze whitespace so a rule can be matched however it is laid out
const flat = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\s+/g, " ");
const has = (css, re, note = "") => assert.ok(re.test(flat(css)), `CSS rule missing: ${note || re}`);

test("app pages: long unbroken words wrap (overflow-wrap) and grid/flex items may shrink", () => {
  const css = read("public", "style.css");
  has(css, /body \{ overflow-wrap: break-word; \}/, "body break-word");
  has(css, /h1, h2, h3, h4, h5, h6, p, li[^{]*\{ overflow-wrap: anywhere; \}/, "text elements wrap anywhere");
  has(css, /\.book-card-title[^{]*\{ overflow-wrap: anywhere; hyphens: auto; hyphenate-limit-chars: 9 4 3; \}/, "titles and card text wrap and hyphenate");
  has(css, /\.book-detail-grid \{ grid-template-columns: 240px minmax\(0, 1fr\); \}/, "book page grid can shrink");
  has(css, /\.book-detail-grid > \*[^{]*\{ min-width: 0; \}/, "book page grid items min-width 0");
  has(css, /\.order-row \{ flex-wrap: wrap;/, "the reservation row wraps");
  has(css, /\.order-row \.status-pill \{ max-width: 100%; white-space: normal;/, "the status pill may wrap");
});

test("French headings keep manual hyphens but may break a string too long for any line", () => {
  const css = read("public", "site-header.css");
  has(css, /:lang\(fr\) h1, :lang\(fr\) h2, :lang\(fr\) h3 \{ hyphens: manual; overflow-wrap: anywhere;/, "fr headings");
});

test("marketing pages: the same wrapping rules in assets/site.css, and the shrinkable grids", () => {
  const site = readSite("assets", "site.css");
  has(site, /body \{ overflow-wrap: break-word; \}/);
  has(site, /\.wn-text, \.wn-title[^{]*\.ev-title[^{]*\.blog-title[^{]*\.bk-book \.t[^{]*\{ overflow-wrap: anywhere; \}/);
  has(readSite("assets", "blog.css"), /\.wn-slide \{[^}]*grid-template-columns: minmax\(0, 1\.35fr\) minmax\(0, 1fr\);/);
  has(readSite("assets", "events.css"), /\.ev-item \{[^}]*grid-template-columns: 104px minmax\(0, 1fr\) auto;/);
});

test("Browse Books: the genre row scrolls inside its own box with a fade on the right edge", () => {
  const css = readSite("assets", "books.css");
  has(css, /\.bk-genres \{ align-items: stretch; min-width: 0; position: relative; \}/, "the column flex container stretches the row");
  has(css, /\.bk-genre-list \{ min-width: 0; max-width: calc\(100% \+ 64px\);/, "the row can be narrower than its chips");
  has(css, /\.bk-genres::after \{[^}]*pointer-events: none;[^}]*linear-gradient\(to left/, "right-edge fade cue");
  has(css, /\.bk-genre-list \{[^}]*overflow-x: auto;/, "the row scrolls");
});

test("member and volunteer calendars become a list below 480px", () => {
  const css = read("public", "style.css");
  has(css, /@media \(max-width: 480px\) \{ \.calendar-agenda \{ display: block; \}/, "agenda display block");
  has(css, /\.calendar-agenda \.calendar-weekday[^{]*\{ display: none; \}/, "weekday header row hidden");
  has(css, /\.calendar-agenda \.calendar-pill summary \{[^}]*min-height: 44px;/, "44px tap target");
  for (const view of ["meetings", "volunteer"]) {
    const ejs = read("views", `${view}.ejs`);
    assert.match(ejs, /class="calendar-grid calendar-agenda"/, `${view}: grid has the agenda class`);
    assert.match(ejs, /class="calendar-day-weekday"/, `${view}: each day names its weekday`);
  }
});

test("admin: tables scroll in their box with a shadow, a swipe hint and a sticky first column", () => {
  const css = read("public", "admin.css");
  has(css, /\.table-scroll \{[^}]*local,[^}]*radial-gradient[^}]*\}/, "edge shadows on .table-scroll");
  has(css, /\.table-scroll-hint\.is-needed \{ display: block; \}/, "hint shown when needed");
  has(css, /\.table-sticky-first th:first-child, \.table-sticky-first td:first-child \{[^}]*position: sticky; left: 0;/, "sticky first column");
  has(css, /\.admin-main table, \.admin-main table \* \{ overflow-wrap: break-word; \}/, "table cells keep their column widths on a computer");
  has(css, /@media \(max-width: 900px\) \{ \.admin-main td, \.admin-main td \* \{ overflow-wrap: anywhere; \}/, "table cells wrap anywhere on a phone");
  has(css, /\.admin-main td \.status-pill, \.admin-main td \.btn \{ white-space: nowrap; overflow-wrap: normal; \}/, "pills and buttons in a cell stay whole");
  has(css, /\.admin-main td \{ min-width: 5\.5rem; \}/, "a cell keeps a minimum width");
  has(css, /\.admin-main :where\([^)]*div[^)]*\) \{ overflow-wrap: anywhere; \}/, "admin text wraps");
  assert.match(read("views", "partials", "admin_footer.ejs"), /<script src="\/table-scroll\.js"><\/script>/, "the swipe-hint script is loaded on admin pages");
  const js = read("public", "table-scroll.js");
  assert.match(js, /Swipe sideways to see all columns/);
  assert.match(js, /Faites glisser sur le côté pour voir toutes les colonnes/, "French hint");
  for (const f of ["members", "blog", "announcements"]) assert.match(read("views", "admin", `${f}.ejs`), /table-sticky-first/, `${f}: sticky first column`);
  assert.match(read("views", "admin", "reports", "show.ejs"), /table-sticky-first/, "reports: sticky first column");
});

test("every .table-scroll box in the admin views is a plain wrapper the swipe-hint script can find", () => {
  const dir = path.join(APP, "views", "admin");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(dir).filter((f) => f.endsWith(".ejs") && /class="table-scroll"/.test(fs.readFileSync(f, "utf8")));
  assert.ok(files.length > 10, `found ${files.length} views with a table-scroll box`);
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, "utf8"), /class="table-scroll"[^>]*style="[^"]*overflow/, `${path.relative(APP, f)}: no inline overflow override on a table-scroll box`);
});
