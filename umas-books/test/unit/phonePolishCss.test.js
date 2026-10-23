// Phone polish, static checks (no server): print stylesheet, light colour scheme, home-indicator padding,
// font preload and size-adjusted fallback fonts. The rendered pages are checked in
// test/integration/phonePolishMarkup.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const { loadSheet, resolveVars } = require("../helpers/css");
const cssFiles = () => [
  ...fs.readdirSync(path.join(root, "public")).filter((f) => f.endsWith(".css")).map((f) => path.join(root, "public", f)),
  ...fs.readdirSync(path.join(root, "..", "assets")).filter((f) => f.endsWith(".css")).map((f) => path.join(root, "..", "assets", f)),
];

// ---- PH-26 print ----

test("print.css is a print-only sheet that hides the chrome, buttons and sticky bars", () => {
  const print = loadSheet("public/print.css");
  assert.ok(print.list.length > 0 && print.list.every((r) => r.at === "@media print"), "everything is inside @media print");
  const hide = print.list.find((r) => r.decls.some((d) => d.prop === "display" && d.value === "none" && d.important));
  assert.ok(hide, "has a display:none !important rule");
  for (const sel of ["header.mkt-header", "footer.mkt-footer", ".skip-link", ".site-back-bar", ".preview-banner", ".langtoggle", ".favorite-toggle", ".form-actions-sticky", ".sticky-bar", ".cookie-banner", ".consent-banner", "button", ".btn", 'input[type="submit"]'])
    assert.ok(hide.selectors.includes(sel), `hides ${sel}`);
});
test("print.css writes out external links only, and only in running text", () => {
  const print = loadSheet("public/print.css");
  assert.ok(print.hasRule('main p a[href^="http"]::after', { at: "@media print" }), "links in paragraphs are written out");
  assert.equal(print.getDecl('main p a[href^="http"]::after', "content", { at: "@media print" }), '" (" attr(href) ")"');
  const selectors = print.list.flatMap((r) => r.selectors);
  assert.ok(!selectors.some((x) => /(^|[\s,])a::after|a\[href\]::after/.test(x)), "no rule that prints the address of every link");
  assert.ok(!selectors.some((x) => /href\^="\/"|href\^="#"|mailto/.test(x)), "relative, anchor and mailto links are not written out");
  assert.equal(print.getDecl('main a.btn[href^="http"]::after', "content", { at: "@media print" }), "none", "a button-styled link is left alone");
});
test("only the public heads load print.css; the admin pages and the till receipt keep their own print rules", () => {
  for (const f of ["views/partials/header.ejs", "views/marketing/partials/mkt_header.ejs"])
    assert.match(read(...f.split("/")), /<link rel="stylesheet" href="<%= assetUrl\('\/print\.css'\) %>" media="print">/, f);
  for (const f of ["views/partials/admin_header.ejs", "views/admin/till/receipt.ejs"])
    assert.ok(!/print\.css/.test(read(...f.split("/"))), `${f} does not load print.css`);
  // The print layouts that must stay as they are.
  const admin = loadSheet("public/admin.css");
  const chart = admin.getRules(".admin-main:has(.color-chart) > *:not(.color-chart)", { at: "@media print" })[0];
  assert.ok(chart, "the colour chart prints on its own");
  assert.ok(chart.decls.some((d) => d.prop === "display" && d.value === "none" && d.important));
  const receipt = loadSheet("public/till-receipt.css");
  assert.equal(receipt.getDecl(".no-print", "display", { at: "@media print" }), "none");
  assert.equal(receipt.getDecl(".receipt", "margin", { at: "@media print" }), "0");
  assert.equal(receipt.atRuleDecls("page").margin, "4mm");
});

// ---- PH-27 colour scheme ----

test("the site is light only: color-scheme is declared in the stylesheets and in every page head", () => {
  assert.equal(loadSheet("public/style.css").getDecl(":root", "color-scheme", { at: "*" }), "light");
  assert.equal(loadSheet("assets/site.css").getDecl(":root", "color-scheme", { at: "*" }), "light");
  for (const f of ["views/partials/header.ejs", "views/marketing/partials/mkt_header.ejs", "views/partials/admin_header.ejs", "views/admin/till/receipt.ejs"])
    assert.ok(read(...f.split("/")).includes('<meta name="color-scheme" content="light">'), `${f} has the meta tag`);
  for (const file of cssFiles()) assert.ok(!loadSheet(file).atRules("media").some((q) => /prefers-color-scheme:\s*dark/.test(q)), `${path.basename(file)} has no dark theme (the decision is documented in ARCHITECTURE.md)`);
});
// ---- PH-28 safe area ----

test("every fixed or sticky bar at the bottom of the screen pads for the home indicator", () => {
  // Full-screen overlays (a dimmed backdrop, a centred modal) are not bars: their content is centred with padding.
  const OVERLAYS = new Set([".till-modal", ".admin-nav-backdrop", "body.modal-open"]);
  const offenders = [];
  let barsSeen = 0;
  for (const file of cssFiles()) {
    const rules = loadSheet(file).list;
    for (const b of rules) {
      const position = b.decls.find((d) => d.prop === "position");
      const atBottom = b.decls.some((d) => (d.prop === "bottom" || d.prop === "inset") && /^0(px)?$/.test(d.value));
      if (!position || !/^(fixed|sticky)$/.test(position.value) || !atBottom) continue;
      if (b.selectors.every((x) => OVERLAYS.has(x))) continue;
      barsSeen++;
      const safe = (r) => r.decls.some((d) => /safe-area-inset-bottom/.test(d.value));
      const padded = safe(b) || rules.some((o) => o !== b && o.selectors.join(", ") === b.selectors.join(", ") && safe(o));
      if (!padded) offenders.push(`${path.basename(file)}: ${b.selectors.join(", ")}`);
    }
  }
  assert.ok(barsSeen >= 3, `found only ${barsSeen} bottom bars`);
  assert.deepEqual(offenders, []);
});
test("the till pay bar, the sticky save bar and the phone menu drawer use env(safe-area-inset-bottom)", () => {
  const SAFE = "env(safe-area-inset-bottom, 0px)";
  assert.equal(loadSheet("public/till.css").getDecl(".till-paybar", "padding", { at: "*" }), `10px 14px calc(10px + ${SAFE})`);
  assert.equal(loadSheet("public/admin.css").getDecl(".form-actions-sticky", "padding"), `12px 0 calc(12px + ${SAFE})`);
  assert.equal(loadSheet("public/admin.css").getDecl(".admin-sidebar", "padding"), `24px 18px calc(24px + ${SAFE})`);
  assert.ok(loadSheet("public/scan-intake.css").list.some((r) => r.decls.some((d) => /safe-area-inset-bottom/.test(d.value))));
});
test("viewport-fit=cover is NOT set: without it the home-screen app already stays inside the safe area, so the page is never under the indicator", () => {
  for (const f of ["views/partials/header.ejs", "views/marketing/partials/mkt_header.ejs", "views/partials/admin_header.ejs"])
    assert.ok(!/viewport-fit/.test(read(...f.split("/"))), f);
});

// ---- PH-29 fonts ----

test("each web font has a size-adjusted local fallback, and every font stack names it right after the web font", () => {
  const FAMILIES = ["Cormorant Garamond", "Libre Baskerville", "Nunito Sans", "Montserrat"];
  for (const [file, label] of [["public/style.css", "style.css"], ["assets/site.css", "site.css"]]) {
    const faces = loadSheet(file).fontFaces();
    for (const fam of FAMILIES) {
      const face = faces.find((f) => f["font-family"] === `'${fam} Fallback'`);
      assert.ok(face, `${label}: ${fam} Fallback face`);
      assert.match(face.src, /^local\(/, `${label}: ${fam} Fallback is a local font`);
      for (const prop of ["size-adjust", "ascent-override", "descent-override"]) assert.match(face[prop], /^[\d.]+%$/, `${label}: ${fam} Fallback ${prop}`);
      assert.equal(face["line-gap-override"], "0%", `${label}: ${fam} Fallback line-gap-override`);
      const size = Number.parseFloat(face["size-adjust"]);
      assert.ok(size > 80 && size < 125, `${fam} size-adjust ${size}% is a plausible scale`);
    }
  }
  // The stacks are written once, as --font-* tokens (:root of both base sheets), and used as var(--font-*): resolve them.
  const tokens = { ...loadSheet("assets/site.css").tokens(), ...loadSheet("public/style.css").tokens() };
  const stacks = [];
  for (const [name, value] of Object.entries(tokens)) if (name.startsWith("--font-")) stacks.push([`token ${name}`, value]);
  assert.ok(stacks.length >= 5, "the font stacks are tokens");
  for (const file of cssFiles()) {
    for (const d of loadSheet(file).allDecls("font-family")) stacks.push([`${path.basename(file)}: font-family: ${d.value}`, resolveVars(d.value, tokens)]);
  }
  const bare = [];
  for (const [where, value] of stacks) {
    for (const fam of FAMILIES) {
      if (value.includes(`'${fam}'`) && !value.includes(`'${fam}', '${fam} Fallback'`) && !/^\s*'[^']+'\s*$/.test(value)) bare.push(where);
    }
  }
  assert.deepEqual(bare, []);
});

test("the two fonts every page uses first are preloaded from the public heads, as fonts, cross-origin, and the files exist", () => {
  for (const f of ["views/partials/header.ejs", "views/marketing/partials/mkt_header.ejs"]) {
    const ejs = read(...f.split("/"));
    for (const file of ["cormorant-garamond-normal-latin-500-700.woff2", "nunito-sans-normal-latin-400-600.woff2"]) {
      assert.ok(ejs.includes(`<link rel="preload" href="/assets/fonts/${file}" as="font" type="font/woff2" crossorigin>`), `${f} preloads ${file}`);
      assert.ok(fs.existsSync(path.join(root, "..", "assets", "fonts", file)), file);
      // The exact URL the CSS asks for, or the preload is wasted.
      assert.ok(read("public", "style.css").includes(`url(/assets/fonts/${file})`), `style.css asks for the same URL as the preload of ${file}`);
    }
  }
});

// ---- PH-32 covers ----

test("every place that draws a cover gives the browser a srcset and sizes", () => {
  for (const f of ["views/cart.ejs", "views/book_detail.ejs"]) assert.match(read(...f.split("/")), /srcset="<%= coverSrcset\(/, f);
  assert.equal((read("views", "book_detail.ejs").match(/srcset="<%= coverSrcset\(/g) || []).length, 2, "the big cover and the 'more by this author' cards");
  for (const f of ["public/page-books.js", "public/favorites-page.js"]) {
    const js = read(...f.split("/"));
    assert.match(js, /-w300\.jpg 300w/);
    assert.match(js, /-w450\.jpg 450w/);
    assert.match(js, /sizes="/);
  }
});
