// Phone layout: the CSS and markup rules that stop a page from being wider than the screen. These are source
// checks (no browser, no database): the browser checks are the e2e steps G82 and A102 and the developer tool
// scripts/phone-overflow-audit.js. If someone removes one of these rules the page widens again on a phone.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const APP = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(APP, ...p), "utf8");
const { loadSheet } = require("../helpers/css");

const style = loadSheet("public/style.css");
const header = loadSheet("public/site-header.css");
const site = loadSheet("assets/site.css");
const blog = loadSheet("assets/blog.css");
const events = loadSheet("assets/events.css");
const books = loadSheet("assets/books.css");
const admin = loadSheet("public/admin.css");
const hyphenates = (sheet, sel) => {
  const r = sheet.getRule(sel);
  assert.ok(r, `${sel} has a rule`);
  assert.equal(r.hyphens, "auto", `${sel} hyphenates`);
  assert.equal(r["hyphenate-limit-chars"], "9 4 3", `${sel} hyphenation limit`);
};
const wraps = (sheet, sel) => assert.equal(sheet.getDecl(sel, "overflow-wrap"), "anywhere", `${sel} wraps anywhere`);

test("app pages: long unbroken words wrap (overflow-wrap) and grid/flex items may shrink", () => {
  assert.equal(style.getDecl("body", "overflow-wrap"), "break-word", "body break-word");
  for (const sel of ["h1", "h2", "h3", "h4", "h5", "h6", "p", "li"]) wraps(style, sel);
  wraps(style, ".book-card-title");
  hyphenates(style, ".book-card-title"); // titles and card text wrap and hyphenate
  assert.equal(style.getDecl(".book-detail-grid", "grid-template-columns"), "240px minmax(0, 1fr)", "book page grid can shrink");
  assert.equal(style.getDecl(".book-detail-grid > *", "min-width"), "0", "book page grid items min-width 0");
  assert.equal(style.getDecl(".order-row", "flex-wrap"), "wrap", "the reservation row wraps");
  const pill = style.getRule(".order-row .status-pill");
  assert.equal(pill["max-width"], "100%", "the status pill may wrap");
  assert.equal(pill["white-space"], "normal", "the status pill may wrap");
});

test("French headings keep manual hyphens but may break a string too long for any line", () => {
  for (const sel of [":lang(fr) h1", ":lang(fr) h2", ":lang(fr) h3"]) {
    assert.equal(header.getDecl(sel, "hyphens"), "manual", sel);
    assert.equal(header.getDecl(sel, "overflow-wrap"), "anywhere", sel);
  }
});

test("marketing pages: the same wrapping rules, each in the sheet that owns the class, and the shrinkable grids", () => {
  assert.equal(site.getDecl("body", "overflow-wrap"), "break-word");
  // one owner per class: the wrapping of .wn-*, .blog-*, .ev-* and .bk-* is declared next to the rest of their styles
  for (const sel of [".wn-text", ".wn-title", ".wn-excerpt", ".wn-tag", ".blog-title", ".blog-excerpt", ".blog-card-body"]) wraps(blog, sel);
  for (const sel of [".ev-title", ".ev-meta", ".ev-desc"]) wraps(events, sel);
  for (const sel of [".bk-book .t", ".bk-book .a", ".bk-book .p", ".bk-results-head h2", ".bk-covernote", ".bk-band-item h3", ".bk-band-item p"]) wraps(books, sel);
  for (const sel of [".wn-title", ".wn-excerpt", ".blog-title", ".blog-excerpt"]) hyphenates(blog, sel);
  for (const sel of [".ev-title", ".ev-desc"]) hyphenates(events, sel);
  for (const sel of [".bk-book .t", ".bk-book .a"]) hyphenates(books, sel);
  for (const [sheet, sel] of [[blog, ".wn-slide > *"], [blog, ".blog-grid > *"], [blog, ".blog-card-link > *"], [events, ".ev-item > *"], [books, ".bk-grid > *"], [books, ".bk-results > *"]]) {
    assert.equal(sheet.getDecl(sel, "min-width"), "0", `${sel} may shrink below its longest word`);
  }
  assert.equal(blog.getDecl(".wn-slide", "grid-template-columns"), "minmax(0, 1.35fr) minmax(0, 1fr)");
  assert.equal(events.getDecl(".ev-item", "grid-template-columns"), "104px minmax(0, 1fr) auto");
});

test("Browse Books: the genre and collection carousels scroll inside their own box, with whole items and no page overflow", () => {
  const track = books.getRule(".bk-track");
  assert.equal(track.flex, "1", "the track fills the row");
  assert.equal(track["min-width"], "0", "the track can be narrower than its items");
  assert.equal(track["overflow-x"], "auto", "the track scrolls inside its box");
  assert.equal(track["scroll-snap-type"], "x mandatory", "whole items");
  assert.equal(books.getDecl(".bk-tiles > *", "--per", { at: "" }), "2", "two items per view on the narrowest track");
  assert.equal(books.getDecl(".bk-tiles > *", "--per", { at: "@container (min-width: 298px)" }), "3", "three per view fit a 375px phone");
  assert.equal(books.getDecl(".bk-carousel .arrow", "display", { at: "@media (max-width: 620px) and (pointer: coarse)" }), "none", "arrows hidden on phones: swipe");
});

test("member and volunteer calendars become a list below 480px", () => {
  const AGENDA = { at: "@media (max-width: 480px)" };
  assert.equal(style.getDecl(".calendar-agenda", "display", AGENDA), "block", "agenda display block");
  assert.equal(style.getDecl(".calendar-agenda .calendar-weekday", "display", AGENDA), "none", "weekday header row hidden");
  assert.equal(style.getDecl(".calendar-agenda .calendar-pill summary", "min-height", AGENDA), "44px", "44px tap target");
  for (const view of ["meetings", "volunteer"]) {
    const ejs = read("views", `${view}.ejs`);
    assert.match(ejs, /class="calendar-grid calendar-agenda"/, `${view}: grid has the agenda class`);
    assert.match(ejs, /class="calendar-day-weekday"/, `${view}: each day names its weekday`);
  }
});

test("admin: tables scroll in their box with a shadow, a swipe hint and a sticky first column", () => {
  const ANY = { at: "*" };
  const bg = admin.getDecl(".table-scroll", "background", ANY);
  assert.match(bg, /local/, "edge shadows on .table-scroll: scroll with the content");
  assert.match(bg, /radial-gradient/, "edge shadows on .table-scroll: the shadow itself");
  assert.equal(admin.getDecl(".table-scroll-hint.is-needed", "display", ANY), "block", "hint shown when needed");
  for (const sel of [".table-sticky-first th:first-child", ".table-sticky-first td:first-child"]) {
    assert.equal(admin.getDecl(sel, "position", ANY), "sticky", "sticky first column");
    assert.equal(admin.getDecl(sel, "left", ANY), "0", "sticky first column");
  }
  for (const sel of [".admin-main table", ".admin-main table *"]) assert.equal(admin.getDecl(sel, "overflow-wrap"), "break-word", "table cells keep their column widths on a computer");
  for (const sel of [".admin-main td", ".admin-main td *"]) assert.equal(admin.getDecl(sel, "overflow-wrap", { at: "@media (max-width: 900px)" }), "anywhere", "table cells wrap anywhere on a phone");
  for (const sel of [".admin-main td .status-pill", ".admin-main td .btn"]) {
    assert.equal(admin.getDecl(sel, "white-space", ANY), "nowrap", "pills and buttons in a cell stay whole");
    assert.equal(admin.getDecl(sel, "overflow-wrap", ANY), "normal", "pills and buttons in a cell stay whole");
  }
  assert.equal(admin.getDecl(".admin-main td", "min-width", ANY), "5.5rem", "a cell keeps a minimum width");
  const text = admin.list.find((r) => r.at === "" && r.selectors.some((sel) => sel.startsWith(".admin-main :where(") && /\bdiv\b/.test(sel)));
  assert.ok(text, "admin text wraps: a :where(... div ...) rule exists");
  assert.equal(text.decls.find((d) => d.prop === "overflow-wrap").value, "anywhere", "admin text wraps");
  assert.match(read("views", "partials", "admin_footer.ejs"), /<script src="<%= assetUrl\('\/table-scroll\.js'\) %>"><\/script>/, "the swipe-hint script is loaded on admin pages");
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
