// Keyboard focus ring (review item PH-20): there was no :focus-visible rule in the app's stylesheets and the browser's
// default ring was about 2.4:1 on the cream page (WCAG 2.4.11 / 1.4.11 ask for 3:1). These tests read the CSS and
// compute the contrast ratios from the colours, so changing a colour to a pale one fails here.
//
// The ring is two-tone: a 2px near-black outline, 2px away from the control, with a 2px white ring (box-shadow)
// in the gap. White reads against dark buttons, near-black reads against the page.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
const APP_CSS = ["style.css", "floral-calendar.css", "dashboard.css", "admin.css", "till.css", "scan-intake.css", "site-header.css"].map((f) => `umas-books/public/${f}`);
const SITE_CSS = ["site.css", "home.css", "books.css", "blog.css", "events.css", "membership.css", "preregistration.css", "programs.css", "immersion.css", "about.css"].map((f) => `assets/${f}`);

function lum(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

// the rule text of `:focus-visible { ... }` (the global one: a selector that is exactly :focus-visible)
function globalRule(file) {
  const m = read(file).match(/(?:^|\})\s*:focus-visible\s*\{([^}]*)\}/);
  assert.ok(m, `${file} has a global :focus-visible rule`);
  return m[1];
}
const parse = (rule) => ({
  outline: (rule.match(/outline:\s*(\d+)px solid (#[0-9a-f]{3,6})/i) || []),
  offset: Number((rule.match(/outline-offset:\s*(\d+)px/) || [])[1]),
  ring: (rule.match(/box-shadow:\s*0 0 0 (\d+)px (#[0-9a-f]{3,6})/i) || []),
});

test("the app pages and the marketing pages carry the same global :focus-visible rule", () => {
  const app = globalRule("umas-books/public/style.css").replace(/\s+/g, " ").trim();
  const site = globalRule("assets/site.css").replace(/\s+/g, " ").trim();
  assert.equal(site, app);
  const f = parse(app);
  assert.equal(f.outline[1], "2", "outline is 2px");
  assert.equal(f.offset, 2, "2px away from the control");
  assert.equal(f.ring[1], "2", "2px white ring in the gap");
});

test("the ring: near-black outline against white ring and the page (>= 3:1), white ring against every dark button colour", () => {
  const f = parse(globalRule("umas-books/public/style.css"));
  const outline = f.outline[2];
  const ring = f.ring[2];
  assert.ok(ratio(outline, ring) >= 3, `outline ${outline} on the ring ${ring}: ${ratio(outline, ring).toFixed(2)}`);

  // every plain hex background used in the stylesheets: light ones sit outside the ring (they are the page, a card, a
  // pill, a calendar tone) and meet the outline; dark ones (buttons) sit inside it and meet the white ring.
  const backgrounds = new Set(["#fffefb", "#ffffff"]);
  for (const file of [...APP_CSS, ...SITE_CSS]) {
    for (const m of read(file).matchAll(/background(?:-color)?:\s*(#[0-9a-f]{6}|#[0-9a-f]{3})\b/gi)) backgrounds.add(m[1].toLowerCase());
  }
  assert.ok(backgrounds.size > 20, "found the backgrounds the pages use");
  let dark = 0;
  let light = 0;
  for (const bg of backgrounds) {
    if (lum(bg) >= 0.18) {
      light++;
      assert.ok(ratio(outline, bg) >= 3, `outline ${outline} on light background ${bg}: ${ratio(outline, bg).toFixed(2)}:1`);
    } else {
      dark++;
      assert.ok(ratio(ring, bg) >= 3, `white ring on dark background ${bg}: ${ratio(ring, bg).toFixed(2)}:1`);
    }
  }
  assert.ok(dark >= 3 && light >= 10, `checked ${dark} dark and ${light} light backgrounds`);
  // the two button colours named in the review (the orange/terracotta one and the green)
  for (const bg of ["#a65347", "#43523a", "#34402d"]) assert.ok(ratio(ring, bg) >= 3, `white ring on ${bg}`);
  // the old default ring, for the record: the browser's orange on cream was below 3:1
  assert.ok(ratio("#ffffff", "#fffefb") < 1.1);
  assert.ok(ratio(outline, "#fffefb") > 12, "about 17:1 on the cream page");
});

test("form fields keep their own focus style, and each of those outlines is at least 3:1 on the page and on white", () => {
  const vars = {};
  for (const file of ["umas-books/public/style.css", "assets/site.css"]) {
    for (const m of read(file).matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)) vars[m[1]] = m[2];
  }
  let seen = 0;
  for (const file of [...APP_CSS, ...SITE_CSS]) {
    for (const m of read(file).matchAll(/([^{}]*:focus(?:-within)?[^{}]*)\{([^}]*)\}/g)) {
      if (/focus-visible/.test(m[1]) && !/[a-z.#[]/.test(m[1].replace(/\s/g, "").replace(":focus-visible", ""))) continue; // the global rule
      const o = m[2].match(/outline:\s*\d+px solid (var\(--([a-z-]+)\)|#[0-9a-f]{6})/i);
      if (!o) continue;
      const colour = o[2] ? vars[o[2]] : o[1];
      if (!colour) continue;
      if (/skip-link/.test(m[1])) continue; // white on the maroon skip link itself
      seen++;
      for (const bg of ["#fffefb", "#ffffff"]) assert.ok(ratio(colour, bg) >= 3, `${file}: ${m[1].trim()} outline ${colour} on ${bg}: ${ratio(colour, bg).toFixed(2)}:1`);
    }
  }
  assert.ok(seen >= 6, `checked ${seen} field focus styles`);
});

test("nothing removes the focus ring from a control without drawing another one", () => {
  // outline: none is only allowed on script-focused targets or where a wrapper shows a ring (:focus-within)
  const allowed = /(\.richtext-editor:focus|\.bk-search input:focus|\.bk-results-head h2:focus|\[tabindex="-1"\]:focus-visible|\.admin-search input)/;
  for (const file of [...APP_CSS, ...SITE_CSS]) {
    for (const m of read(file).matchAll(/([^{}]*)\{[^}]*outline:\s*(?:none|0)\s*[;}]/g)) {
      const sel = m[1].trim();
      if (sel.startsWith("@")) continue;
      assert.match(sel, allowed, `${file}: "${sel}" removes the outline`);
    }
  }
});
