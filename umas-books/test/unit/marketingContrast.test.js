// WCAG AA (4.5:1) for the two marketing colour pairs a production review
// flagged, plus the 320px layout rules that stop events.html scrolling
// sideways. CSS is checked from source: the values are what matter.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ASSETS = path.join(__dirname, "..", "..", "..", "assets");
const css = (f) => fs.readFileSync(path.join(ASSETS, f), "utf8");

function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const CREAM = css("site.css").match(/--cream:\s*(#[0-9a-f]{6})/i)[1];

test("programs.css: the drop-in title colour reads at 4.5:1 on the cream background", () => {
  const colour = css("programs.css").match(/\.pg-dropin \.pg-title\s*\{\s*color:\s*(#[0-9a-f]{6})/i)[1];
  assert.ok(ratio(colour, CREAM) >= 4.5, `${colour} on ${CREAM} is ${ratio(colour, CREAM).toFixed(2)}:1`);
});

test("programs.css: white text on the gold button reads at 4.5:1", () => {
  const colour = css("programs.css").match(/\.pg-btn\.gold\s*\{\s*background:\s*(#[0-9a-f]{6})/i)[1];
  assert.ok(ratio("#ffffff", colour) >= 4.5, `white on ${colour} is ${ratio("#ffffff", colour).toFixed(2)}:1`);
});

test("events.css lets the schedule buttons wrap inside a 320px viewport", () => {
  const src = css("events.css");
  assert.match(src, /\.ev-more \.h-btn \{ max-width: 100%; \}/);
  assert.match(src, /@media \(max-width: 400px\)[^}]*\{[^}]*white-space: normal/s);
});

test("the phone nav is a Menu whose open panel stacks the links in a column (nothing scrolls off-screen)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "public", "site-header.css"), "utf8");
  const mobile = src.slice(src.indexOf("@media (max-width: 640px)"), src.indexOf("/* ---------- Footer"));
  assert.match(mobile, /\.h-menu-links \{[^}]*flex-direction: column/s);
  assert.doesNotMatch(mobile, /overflow-x:\s*auto/);
});
