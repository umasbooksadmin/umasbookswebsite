// WCAG AA (4.5:1) for the two marketing colour pairs a production review
// flagged, plus the 320px layout rules that stop events.html scrolling
// sideways. CSS is checked from source: the values are what matter.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadSheet, resolveVars } = require("../helpers/css");

function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const tokens = loadSheet("assets/site.css").tokens();
const CREAM = tokens["--cream"];
// the colour a declaration really paints, whether it is written as a hex or as a token
const colourOf = (sheet, selector, prop) => {
  const value = resolveVars(sheet.getDecl(selector, prop), tokens);
  assert.match(value, /^#[0-9a-f]{6}$/i, `${selector} ${prop} is a plain colour`);
  return value;
};

test("programs.css: the drop-in title colour reads at 4.5:1 on the cream background", () => {
  const colour = colourOf(loadSheet("assets/programs.css"), ".pg-dropin .pg-title", "color");
  assert.ok(ratio(colour, CREAM) >= 4.5, `${colour} on ${CREAM} is ${ratio(colour, CREAM).toFixed(2)}:1`);
});

test("programs.css: white text on the gold button reads at 4.5:1", () => {
  const colour = colourOf(loadSheet("assets/programs.css"), ".pg-btn.gold", "background");
  assert.ok(ratio("#ffffff", colour) >= 4.5, `white on ${colour} is ${ratio("#ffffff", colour).toFixed(2)}:1`);
});

test("events.css lets the schedule buttons wrap inside a 320px viewport", () => {
  const events = loadSheet("assets/events.css");
  assert.equal(events.getDecl(".ev-more .h-btn", "max-width"), "100%");
  const narrow = events.list.filter((r) => r.at === "@media (max-width: 400px)");
  assert.ok(narrow.some((r) => r.decls.some((d) => d.prop === "white-space" && d.value === "normal")), "a rule under 400px sets white-space: normal");
});

test("the phone nav is a Menu whose open panel stacks the links in a column (nothing scrolls off-screen)", () => {
  const header = loadSheet("public/site-header.css");
  assert.equal(header.getDecl("header.mkt-header .h-menu-links", "flex-direction", { at: "@media (max-width: 640px), (max-height: 500px) and (max-width: 1000px)" }), "column");
  const sideways = header.list.filter((r) => r.at.includes("640px")).flatMap((r) => r.decls).filter((d) => d.prop === "overflow-x" && d.value === "auto");
  assert.deepEqual(sideways, []);
});
