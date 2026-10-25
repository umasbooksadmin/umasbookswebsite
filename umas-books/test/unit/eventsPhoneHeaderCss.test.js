// Public Events page on phones: the red kicker line and its rule are hidden, the title stays visible.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadSheet } = require("../helpers/css");

const fcal = loadSheet("public/floral-calendar.css");
const PHONE = "@media (max-width: 700px)";

test("on phones the Events page hides the kicker line (and its rule inside it)", () => {
  assert.equal(fcal.getDecl(".fcal-hero-events .fcal-kicker", "display", { at: PHONE }), "none");
});
test("the kicker is not hidden at tablet/desktop widths, and the sessions page is not affected", () => {
  assert.equal(fcal.getDecl(".fcal-kicker", "display"), undefined);
  assert.equal(fcal.getDecl(".fcal-hero-events .fcal-kicker", "display"), undefined, "no top-level rule hides it");
  assert.equal(fcal.getDecl(".fcal-kicker", "display", { at: PHONE }), undefined, "only the events-scoped selector hides it");
  const sessions = fs.readFileSync(path.join(__dirname, "..", "..", "views", "sessions.ejs"), "utf8");
  assert.ok(!sessions.includes("fcal-hero-events"));
});
test("the title is never hidden or visually hidden, at any width", () => {
  const rules = fcal.list.filter((r) => r.selectors.some((s) => /fcal-title/.test(s)));
  for (const r of rules)
    for (const d of r.decls) {
      assert.notEqual(d.value, "none", `${r.at}: ${d.prop}`);
      assert.ok(!["clip", "position"].includes(d.prop) || d.value !== "absolute", "title not taken out of flow");
    }
});
test("events.ejs marks its hero with fcal-hero-events and keeps the h1", () => {
  const v = fs.readFileSync(path.join(__dirname, "..", "..", "views", "events.ejs"), "utf8");
  assert.match(v, /<section class="fcal-hero fcal-hero-events">/);
  assert.match(v, /<h1 class="fcal-title">/);
});
