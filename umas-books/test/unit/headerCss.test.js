// Static checks of the front-end CSS the second review asked for: the compact
// phone header, the tap-target sizes (WCAG 2.2, 2.5.8: at least 24x24) and the
// footer without stray separators. The pixel measurements are in the PR; these
// keep the rules from being deleted by accident.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", "..", ...p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const header = read("public", "site-header.css");
const blog = read("..", "assets", "blog.css");
const books = read("..", "assets", "books.css");
const block = (css, query) => { const i = css.indexOf(query); assert.ok(i >= 0, `${query} block exists`); let d = 0, j = css.indexOf("{", i); const start = j; for (; j < css.length; j++) { if (css[j] === "{") d++; if (css[j] === "}" && --d === 0) break; } return css.slice(start, j); };

test("language toggle: at least 32x32 with a mouse, 44x44 on a touch screen (any width)", () => {
  assert.match(header, /\.langtoggle button \{[^}]*min-width: 32px; min-height: 32px/);
  assert.match(block(header, "@media (pointer: coarse)"), /\.langtoggle button \{ min-width: 44px; min-height: 44px; \}/);
});

test("phone header: the Menu button shows only at 640px and below; from 641px the summary is hidden and the links always show", () => {
  assert.match(header, /header\.mkt-header \.h-menu-btn \{ display: none; \}/);
  assert.match(header, /header\.mkt-header \.h-menu::details-content \{ content-visibility: visible; display: contents; \}/);
  const phone = block(header, "@media (max-width: 640px), (max-height: 500px) and (max-width: 1000px) {\n  header.mkt-header { padding-bottom: 0; }");
  assert.match(phone, /\.h-menu-btn \{[^}]*display: inline-flex[^}]*min-height: 44px/);
  assert.match(phone, /\.h-menu:not\(\[open\]\)::details-content \{ content-visibility: hidden; \}/);
  assert.match(phone, /\.h-tools \{ display: contents; \}/, "icons and the language toggle share one row with the logo");
  assert.doesNotMatch(phone, /overflow-x:\s*(auto|scroll)/, "the menu never scrolls sideways");
});

test("preview banner: one clipped line on phones with a More toggle; the toggle does not exist from 641px", () => {
  assert.match(header, /\.preview-banner details\.pb-d \{ display: none; \}/);
  const phone = block(header, "@media (max-width: 640px) {\n  .preview-banner");
  const text = phone.match(/\.pb-text \{([^}]*)\}/)[1];
  assert.match(text, /white-space: nowrap/);
  assert.match(text, /text-overflow: ellipsis/);
  assert.match(phone, /details\[open\] ~ \.pb-text \{ white-space: normal/);
});

test("tap targets: carousel dots are 24x24 buttons, footer links and in-page links are taller than 24px", () => {
  assert.match(blog, /\.wn-dot \{[^}]*width: 24px; height: 24px[^}]*background-clip: content-box/);
  assert.match(header, /footer\.mkt-footer li a \{ display: inline-block; padding: 6px 0; \}/);
  assert.match(header, /main p a:not\(\.btn\)[^{]*\{ padding-block: 4px; \}/);
  assert.match(books, /\.bk-link-btn \{[^}]*min-height: 28px/);
});

test("footer: no vertical separators below 641px (they wrapped into stray bars), a gap instead", () => {
  const phone = block(header, "@media (max-width: 640px) {\n  footer.mkt-footer ul");
  assert.match(phone, /footer\.mkt-footer ul \{ gap: 2px 18px; \}/);
  assert.match(phone, /li:first-child \{ border-left: 0; padding: 0; \}/);
});

test("browse page genre and collection tiles: equal-width carousel items that wrap their names, whole items per view", () => {
  assert.match(books, /\.bk-tiles > \* \{ flex: 0 0 calc\(\(100cqw - \(var\(--per\) - 1\) \* var\(--gap\)\) \/ var\(--per\)\); min-width: 0; scroll-snap-align: start;/);
  assert.match(books, /\.bk-tiles \.bk-genre \{ overflow-wrap: anywhere;/);
  assert.match(books, /\.bk-genre \.chip \{\s*width: 50px; height: 50px;/, "genre pictures keep their size");
});
