// Admin on a phone (static checks of the stylesheet, the scripts and the views; the real-browser checks are the
// e2e steps A112-A115): fields are 16px (iOS zooms the page when a smaller field gets focus), the drawer menu
// behaves like a dialog, the scan/add page keeps the ISBN box in the first screen, the Save bar is compact.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const css = read("public", "admin.css");
const scanCss = read("public", "scan-intake.css");
const appJs = read("public", "app.js");

// The body of the first @media block whose query contains `query`.
function mediaBlock(source, query) {
  const i = source.indexOf(`@media ${query} {`);
  assert.ok(i >= 0, `no @media ${query}`);
  const open = source.indexOf("{", i);
  let depth = 0;
  for (let k = open; k < source.length; k++) {
    if (source[k] === "{") depth++;
    if (source[k] === "}" && --depth === 0) return source.slice(open + 1, k);
  }
  throw new Error("unbalanced");
}

test("fields are 16px on phones and touch screens, 44px tall up to 767px", () => {
  const touch = mediaBlock(css, "(max-width: 767px), (pointer: coarse)");
  assert.match(touch, /\.admin-main select,\s*\.admin-main textarea \{ font-size: 16px; \}/);
  assert.match(touch, /input:not\(\[type=checkbox\]\)/, "check boxes keep their size");
  const narrow = mediaBlock(css, "(max-width: 767px)");
  assert.match(narrow, /\.admin-main select \{ min-height: 44px; \}/);
});

test("no admin field rule below 767px sets a font size under 16px that the 16px rule would not beat", () => {
  // The 16px rule has a selector with many :not()s, so it wins over the plain class rules of filters and forms.
  const small = [...css.matchAll(/([^{}]*(?:input|select|textarea)[^{}]*)\{([^}]*)\}/g)]
    .filter((m) => /font-size:\s*(1[0-5](\.\d+)?|[0-9](\.\d+)?)px/.test(m[2]))
    .map((m) => m[1].trim());
  for (const sel of small) {
    // every such rule is a (0,x,x) rule: it must be lower than the 16px rule's specificity, i.e. have fewer than 5 class/attribute/pseudo parts
    const parts = (sel.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) || []).length;
    assert.ok(parts < 6, `a small-font rule with a very specific selector would beat the 16px rule: ${sel}`);
  }
  assert.ok(small.length > 0);
});

test("pricing rules: each number field has a name and, on a phone, a label above it", () => {
  const view = read("views", "admin", "pricing", "settings.ejs");
  const used = [...view.matchAll(/num\('([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(used.length >= 19, `expected 19 rule fields, found ${used.length}`);
  const labelled = [...view.matchAll(/^\s+"([a-z_]+)": "/gm)].map((m) => m[1]);
  for (const col of used) assert.ok(labelled.includes(col), `pricing field ${col} has no label text`);
  assert.match(view, /aria-label="\$\{ruleLabels\[col\]\}"/);
  const phone = mediaBlock(css, "(max-width: 600px)");
  assert.match(phone, /\.rule-field-label \{ display: block;/);
  assert.match(phone, /\.rule-field input \{ display: block; width: 100%; \}/);
  assert.match(css, /\.rule-field-label \{ display: none; \}/, "desktop keeps the numbers inside the sentence");
});

test("accounting mapping: a card per rule under 600px", () => {
  const view = read("views", "admin", "reports", "accounting_mapping.ejs");
  assert.match(view, /class="report-table map-table"/);
  assert.equal((view.match(/data-label="/g) || []).length, 3);
  assert.doesNotMatch(view, /style="width:/, "field widths live in the stylesheet so the phone layout can make them full width");
  assert.match(css, /\.map-table td\[data-label\]::before \{ content: attr\(data-label\)/);
});

test("drawer menu: 44px links, scroll lock, focus moved in, trapped, Escape returns it", () => {
  const drawer = mediaBlock(css, "(max-width: 900px)");
  assert.match(css, /html\.is-admin-nav-open, html\.is-admin-nav-open body \{ overflow: hidden; \}/);
  const phone = [...css.matchAll(/@media \(max-width: 900px\) \{([\s\S]*?)\n\}\n/g)].map((m) => m[1]).join("\n") + drawer;
  assert.match(phone, /\.admin-nav a, \.admin-nav-group a, \.admin-sidebar \.admin-view-site \{ min-height: 44px;/);
  assert.match(phone, /\.admin-nav-close \{[^}]*height: 44px/);
  assert.match(appJs, /setAttribute\("inert", ""\)/, "the page behind the drawer is inert");
  assert.match(appJs, /e\.key === "Escape"[\s\S]{0,80}returnFocus: true/);
  assert.match(appJs, /e\.shiftKey && active === firstEl/);
  assert.match(appJs, /is-admin-nav-open/);
  assert.match(appJs, /toggle\.setAttribute\("aria-expanded"/);
  const header = read("views", "partials", "admin_header.ejs");
  assert.match(header, /data-toggle-admin-nav aria-label="Open menu" aria-expanded="false" aria-controls="admin-sidebar"/);
  assert.match(header, /<aside class="admin-sidebar" id="admin-sidebar">/);
});

test("scan, add and till pages: no global search and no Back link on a phone, small title", () => {
  const header = read("views", "partials", "admin_header.ejs");
  assert.match(header, /admin-topbar<%= locals\.compactTop \? ' is-compact' : '' %>/);
  for (const f of [["inventory", "new.ejs"], ["inventory", "scan.ejs"], ["till", "index.ejs"]]) {
    assert.match(read("views", "admin", ...f), /compactTop: true/, f.join("/"));
  }
  assert.match(css, /\.admin-topbar\.is-compact \.admin-search, \.admin-topbar\.is-compact \.admin-back-link \{ display: none; \}/);
});

test("Save bar on the add page: full width, at most 56px, clears the home indicator", () => {
  const bar = mediaBlock(scanCss, "(max-width: 900px)");
  const m = bar.match(/\[data-scan-actions\] \{ padding: (\d+)px 0 calc\((\d+)px \+ env\(safe-area-inset-bottom, 0px\)\)/);
  assert.ok(m, "padding with the safe-area inset");
  const btn = bar.match(/\.scan-actions \.btn, \.scan-intake \.scan-save-view \{ min-height: (\d+)px/);
  assert.ok(btn);
  assert.ok(Number(m[1]) + Number(m[2]) + Number(btn[1]) + 1 <= 56, "5 + 5 + 44 + 1px border");
  assert.match(bar, /\.scan-intake \.scan-actions \{ flex: 1 1 100%; width: 100%;/);
  assert.match(scanCss, /\.scan-status:empty \{ position: absolute;/, "an empty status line leaves no gap");
});

test("add page: the 'My ISBN has an X' toggle switches the box to the letter keyboard", () => {
  const view = read("views", "admin", "inventory", "new.ejs");
  assert.match(view, /<button type="button" class="scan-x-toggle" data-isbn-x aria-pressed="false"/);
  assert.match(view, /inputmode="numeric"/, "the number pad stays the default");
  const js = read("public", "scan-intake.js");
  assert.match(js, /setAttribute\("inputmode", on \? "text" : "numeric"\)/);
  assert.match(scanCss, /@media \(pointer: coarse\) \{ \.scan-x-toggle \{ display: inline-flex;/);
});

test("inventory landing: equal-width action tiles, two per row on a phone", () => {
  assert.match(read("views", "admin", "inventory", "index.ejs"), /<p class="inv-actions"/);
  const phone = mediaBlock(css, "(max-width: 640px)");
  assert.match(css, /\.inv-actions \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.ok(phone.length > 0);
});

test("request-a-book: the ISBN box uses the letter keyboard (an ISBN-10 can end in X)", () => {
  const view = read("views", "request_book.ejs");
  assert.match(view, /id="rb-isbn" name="isbn" type="text" inputmode="text" autocapitalize="characters"/);
});
