// The error summary of a refused form is focused by script (public/app.js) and has tabindex="-1". The generic rule
// `[tabindex="-1"]:focus-visible { outline: none }` used to hide its ring; a more specific later rule must give it the
// site's focus ring (WCAG 2.4.7), and nothing may remove it again.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSheet } = require("../helpers/css");

const style = loadSheet("umas-books/public/style.css");

test("the focused error summary has the site's two-tone focus ring, and beats the tabindex=-1 reset", () => {
  for (const sel of [".error-box[data-form-errors]:focus", ".error-box[data-form-errors]:focus-visible"]) {
    assert.equal(style.getDecl(sel, "outline"), "2px solid #1a1a1a", sel);
    assert.equal(style.getDecl(sel, "box-shadow"), "0 0 0 2px #fff", sel);
  }
  const text = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "..", "public", "style.css"), "utf8");
  assert.ok(text.indexOf(".error-box[data-form-errors]:focus") > text.indexOf('[tabindex="-1"]:focus-visible { outline: none'), "the error-summary rule comes after the reset (equal-or-lower specificity loses by order)");
  // specificity: [tabindex] 0,2,0 vs .error-box[data-form-errors]:focus 0,3,0
});
