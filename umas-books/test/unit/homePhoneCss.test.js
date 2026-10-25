// Home page on a phone starts at "What's New": everything between the header and that section (hero artwork, rule,
// tagline, the four cards) is hidden, the page's one <h1> stays in the page but visually hidden, and nothing is hidden
// above the phone breakpoint (tablets and desktops keep today's layout). Checked from the CSS and the template source.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadSheet } = require("../helpers/css");

const home = loadSheet("assets/home.css");
// the same query as the header's Menu (public/site-header.css): the cards' links are in the Menu whenever the cards are hidden
const PHONE = "@media (max-width: 640px), (max-height: 500px) and (max-width: 1000px)";
const header = loadSheet("public/site-header.css");

test("home phone: the breakpoint is the one where the header turns into the Menu", () => {
  assert.ok(header.atRules("media").includes(PHONE), "site-header.css still has the phone Menu query");
  assert.ok(home.atRules("media").includes(PHONE), "home.css uses that same query");
});

test("home phone: hero artwork, rule, tagline and the four cards are not shown", () => {
  for (const sel of [".h-hero .art", ".h-hero .rule", ".h-hero .tagline", ".h-cards"]) {
    assert.equal(home.getDecl(sel, "display", { at: PHONE }), "none", `${sel} is display:none on a phone`);
  }
});

test("home phone: the hero (which holds the h1) is visually hidden with the clip pattern, not display:none", () => {
  const r = home.getRule(".h-hero", { at: PHONE });
  assert.ok(r, ".h-hero has a phone rule");
  assert.equal(r.position, "absolute");
  assert.equal(r.width, "1px");
  assert.equal(r.height, "1px");
  assert.equal(r.overflow, "hidden");
  assert.equal(r.clip, "rect(0 0 0 0)");
  assert.notEqual(r.display, "none", "display:none would drop the h1 from the accessibility tree");
});

test("home phone: nothing is hidden outside the phone query", () => {
  for (const sel of [".h-hero", ".h-hero .art", ".h-hero .rule", ".h-hero .tagline", ".h-cards"]) {
    assert.notEqual(home.getDecl(sel, "display"), "none", `${sel} is shown at the top level`);
    for (const at of home.atRules("media")) {
      if (at === PHONE) continue;
      assert.notEqual(home.getDecl(sel, "display", { at }), "none", `${sel} is not hidden in ${at}`);
    }
  }
  assert.equal(home.getDecl(".h-hero", "position"), "relative", "the hero is a normal block above the phone breakpoint");
});

test("home page markup: one h1, inside the hero, before the What's New section", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "views", "marketing", "index.ejs"), "utf8");
  assert.equal((src.match(/<h1[\s>]/g) || []).length, 1, "exactly one h1");
  const hero = src.slice(src.indexOf('<section class="h-hero">'), src.indexOf("</section>", src.indexOf('<section class="h-hero">')));
  assert.match(hero, /<h1[\s>]/, "the h1 is inside .h-hero (the visually hidden block)");
  assert.ok(src.indexOf('<section class="wn"') > src.indexOf('<section class="h-cards">'), "What's New follows the cards");
});
