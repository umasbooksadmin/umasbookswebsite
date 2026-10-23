// Admin pages must link their stylesheets and scripts through assetUrl(): the files are cached for 7 days, so a bare
// "/admin.css" kept showing an OLD stylesheet (the new search filters stacked one under another) until the cache expired.
// Also: the filter row is a plain <div> grid (a <fieldset> ignores flex/grid in Safari).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const VIEWS = path.join(__dirname, "..", "..", "views");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

test("no view links a local stylesheet or script without assetUrl()", () => {
  const bad = [];
  for (const f of walk(VIEWS).filter((x) => x.endsWith(".ejs"))) {
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/<(?:script src|link rel="stylesheet" href)="(\/[^"]*\.(?:js|css))"/g)) bad.push(`${path.relative(VIEWS, f)}: ${m[1]}`);
  }
  assert.deepEqual(bad, []);
});

test("inventory filter row: a div grid with six equal columns on a wide form, never a fieldset", () => {
  const view = fs.readFileSync(path.join(VIEWS, "admin", "inventory", "index.ejs"), "utf8");
  assert.match(view, /<div class="inv-filters">/);
  assert.doesNotMatch(view, /<fieldset[^>]*inv-filters|<fieldset[^>]*>\s*<div class="inv-filters"/);
  const css = fs.readFileSync(path.join(__dirname, "..", "..", "public", "admin.css"), "utf8");
  assert.match(css, /\.inv-filters \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@container \(min-width: 740px\) \{ \.inv-filters \{ grid-template-columns: repeat\(6, minmax\(0, 1fr\)\)/);
});
