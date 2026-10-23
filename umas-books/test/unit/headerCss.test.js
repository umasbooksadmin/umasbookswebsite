// Static checks of the front-end CSS the second review asked for: the compact
// phone header, the tap-target sizes (WCAG 2.2, 2.5.8: at least 24x24) and the
// footer without stray separators. The pixel measurements are in the PR; these
// keep the rules from being deleted by accident. The sheets are parsed (test/helpers/css.js), so the
// checks hold whatever the order or spacing of the declarations.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSheet } = require("../helpers/css");

const header = loadSheet("public/site-header.css");
const blog = loadSheet("assets/blog.css");
const books = loadSheet("assets/books.css");
const site = loadSheet("assets/site.css");
const style = loadSheet("public/style.css");

const COARSE = { at: "@media (pointer: coarse)" };
const PHONE_MENU = { at: "@media (max-width: 640px), (max-height: 500px) and (max-width: 1000px)" };
const PHONE_FOOTER = { at: "@media (max-width: 640px)" };

test("language toggle: at least 32x32 with a mouse, 44x44 on a touch screen (any width)", () => {
  assert.equal(header.getDecl("header.mkt-header .langtoggle button", "min-width"), "32px");
  assert.equal(header.getDecl("header.mkt-header .langtoggle button", "min-height"), "32px");
  assert.equal(header.getDecl("header.mkt-header .langtoggle button", "min-width", COARSE), "44px");
  assert.equal(header.getDecl("header.mkt-header .langtoggle button", "min-height", COARSE), "44px");
});

test("phone header: the Menu button shows only at 640px and below; from 641px the summary is hidden and the links always show", () => {
  assert.equal(header.getDecl("header.mkt-header .h-menu-btn", "display"), "none");
  const wide = header.getRule("header.mkt-header .h-menu::details-content");
  assert.equal(wide["content-visibility"], "visible");
  assert.equal(wide.display, "contents");
  assert.equal(header.getDecl("header.mkt-header", "padding-bottom", PHONE_MENU), "0");
  const btn = header.getRule("header.mkt-header .h-menu-btn", PHONE_MENU);
  assert.equal(btn.display, "inline-flex");
  assert.equal(btn["min-height"], "44px");
  assert.equal(header.getDecl("header.mkt-header .h-menu:not([open])::details-content", "content-visibility", PHONE_MENU), "hidden");
  assert.equal(header.getDecl("header.mkt-header .h-tools", "display", PHONE_MENU), "contents", "icons and the language toggle share one row with the logo");
  const sideways = header.list.filter((r) => r.at === PHONE_MENU.at).flatMap((r) => r.decls).filter((d) => d.prop === "overflow-x" && /^(auto|scroll)$/.test(d.value));
  assert.deepEqual(sideways, [], "the menu never scrolls sideways");
});

test("preview banner: one clipped line on phones with a More toggle; the toggle does not exist from 641px", () => {
  assert.equal(header.getDecl(".preview-banner details.pb-d", "display"), "none");
  const phone = { at: "@media (max-width: 640px)" };
  const text = header.getRule(".preview-banner .pb-text", phone);
  assert.equal(text["white-space"], "nowrap");
  assert.equal(text["text-overflow"], "ellipsis");
  assert.equal(header.getDecl(".preview-banner details[open] ~ .pb-text", "white-space", phone), "normal");
});

test("tap targets: carousel dots are 24x24 buttons, footer links and in-page links are taller than 24px", () => {
  const dot = blog.getRule(".wn-dot");
  assert.equal(dot.width, "24px");
  assert.equal(dot.height, "24px");
  assert.equal(dot["background-clip"], "content-box");
  assert.equal(header.getDecl("footer.mkt-footer li a", "display"), "inline-block");
  assert.equal(header.getDecl("footer.mkt-footer li a", "padding"), "6px 0");
  // links inside paragraphs, lists and cells: the marketing base sheet and the app base sheet each carry the rule
  for (const [name, sheet] of [["site.css", site], ["style.css", style]]) {
    for (const where of ["p", "li", "td", "label", "dd"]) {
      assert.equal(sheet.getDecl(`main ${where} a:not(.btn)`, "padding-block"), "4px", `${name}: main ${where} a`);
    }
  }
  assert.equal(books.getDecl(".bk-link-btn", "min-height"), "28px");
});

test("footer: no vertical separators below 641px (they wrapped into stray bars), a gap instead", () => {
  assert.equal(header.getDecl("footer.mkt-footer ul", "gap", PHONE_FOOTER), "2px 18px");
  const first = header.getRule("footer.mkt-footer li:first-child", PHONE_FOOTER);
  assert.equal(first["border-left"], "0");
  assert.equal(first.padding, "0");
});

test("browse page genre and collection tiles: equal-width carousel items that wrap their names, whole items per view", () => {
  const tile = books.getRule(".bk-tiles > *");
  assert.equal(tile.flex, "0 0 calc((100cqw - (var(--per) - 1) * var(--gap)) / var(--per))");
  assert.equal(tile["min-width"], "0");
  assert.equal(tile["scroll-snap-align"], "start");
  assert.equal(books.getDecl(".bk-tiles .bk-genre", "overflow-wrap"), "anywhere");
  const chip = books.getRule(".bk-genre .chip");
  assert.equal(chip.width, "50px", "genre pictures keep their size");
  assert.equal(chip.height, "50px", "genre pictures keep their size");
});
