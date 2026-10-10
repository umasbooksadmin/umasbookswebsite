// Phone polish, static checks (no server): print stylesheet, light colour scheme, home-indicator padding,
// font preload and size-adjusted fallback fonts. The rendered pages are checked in
// test/integration/phonePolishMarkup.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const cssFiles = () => [
  ...fs.readdirSync(path.join(root, "public")).filter((f) => f.endsWith(".css")).map((f) => path.join(root, "public", f)),
  ...fs.readdirSync(path.join(root, "..", "assets")).filter((f) => f.endsWith(".css")).map((f) => path.join(root, "..", "assets", f)),
];

// ---- PH-26 print ----

test("print.css is a print-only sheet that hides the chrome, buttons and sticky bars", () => {
  const css = stripComments(read("public", "print.css"));
  assert.match(css, /^\s*@media print\s*\{/, "everything is inside @media print");
  const hide = /([^{}]*)\{\s*display:\s*none\s*!important;?\s*\}/.exec(css);
  assert.ok(hide, "has a display:none rule");
  for (const sel of ["header.mkt-header", "footer.mkt-footer", ".skip-link", ".site-back-bar", ".preview-banner", ".langtoggle", ".favorite-toggle", ".form-actions-sticky", ".sticky-bar", ".cookie-banner", ".consent-banner", "button", ".btn", 'input[type="submit"]'])
    assert.ok(hide[1].includes(sel), `hides ${sel}`);
});

test("print.css writes out external links only, and only in running text", () => {
  const css = stripComments(read("public", "print.css"));
  assert.match(css, /main p a\[href\^="http"\]::after/);
  assert.match(css, /content:\s*" \(" attr\(href\) "\)"/);
  assert.ok(!/(^|[\s,}])a::after|a\[href\]::after/.test(css), "no rule that prints the address of every link");
  assert.ok(!/href\^="\/"|href\^="#"|mailto/.test(css), "relative, anchor and mailto links are not written out");
  assert.match(css, /a\.btn\[href\^="http"\]::after[^}]*content:\s*none/, "a button-styled link is left alone");
});

test("only the public heads load print.css; the admin pages and the till receipt keep their own print rules", () => {
  for (const f of ["views/partials/header.ejs", "views/marketing/partials/mkt_header.ejs"])
    assert.match(read(...f.split("/")), /<link rel="stylesheet" href="<%= assetUrl\('\/print\.css'\) %>" media="print">/, f);
  for (const f of ["views/partials/admin_header.ejs", "views/admin/till/receipt.ejs"])
    assert.ok(!/print\.css/.test(read(...f.split("/"))), `${f} does not load print.css`);
  // The print layouts that must stay as they are.
  const admin = read("public", "admin.css");
  assert.match(admin, /\.admin-main:has\(\.color-chart\) > \*:not\(\.color-chart\) \{ display: none !important; \}/);
  assert.match(read("public", "till-receipt.css"), /@media print \{ \.no-print \{ display: none; \} \.receipt \{ margin: 0; \} @page \{ margin: 4mm; \} \}/);
});

// ---- PH-27 colour scheme ----

test("the site is light only: color-scheme is declared in the stylesheets and in every page head", () => {
  assert.match(stripComments(read("public", "style.css")), /:root\s*\{[^}]*color-scheme:\s*light;/);
  assert.match(stripComments(read("..", "assets", "site.css")), /:root\s*\{[^}]*color-scheme:\s*light;/);
  for (const f of ["views/partials/header.ejs", "views/marketing/partials/mkt_header.ejs", "views/partials/admin_header.ejs", "views/admin/till/receipt.ejs"])
    assert.ok(read(...f.split("/")).includes('<meta name="color-scheme" content="light">'), `${f} has the meta tag`);
  for (const file of cssFiles()) assert.ok(!/prefers-color-scheme:\s*dark/.test(stripComments(fs.readFileSync(file, "utf8"))), `${path.basename(file)} has no dark theme (the decision is documented in ARCHITECTURE.md)`);
});

// ---- PH-28 safe area ----

test("every fixed or sticky bar at the bottom of the screen pads for the home indicator", () => {
  // Full-screen overlays (a dimmed backdrop, a centred modal) are not bars: their content is centred with padding.
  const OVERLAYS = new Set([".till-modal", ".admin-nav-backdrop", "body.modal-open"]);
  const offenders = [];
  let barsSeen = 0;
  for (const file of cssFiles()) {
    const css = stripComments(fs.readFileSync(file, "utf8"));
    const blocks = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim().replace(/\s+/g, " "), body: m[2] }));
    for (const b of blocks) {
      if (!/position:\s*(fixed|sticky)/.test(b.body) || !/(^|[;\s])(bottom:\s*0|inset:\s*0)/.test(b.body)) continue;
      if (b.sel.split(",").every((s) => OVERLAYS.has(s.trim()))) continue;
      barsSeen++;
      const padded = /safe-area-inset-bottom/.test(b.body) || blocks.some((o) => o !== b && o.sel === b.sel && /safe-area-inset-bottom/.test(o.body));
      if (!padded) offenders.push(`${path.basename(file)}: ${b.sel}`);
    }
  }
  assert.ok(barsSeen >= 3, `found only ${barsSeen} bottom bars`);
  assert.deepEqual(offenders, []);
});

test("the till pay bar, the sticky save bar and the phone menu drawer use env(safe-area-inset-bottom)", () => {
  assert.match(read("public", "till.css"), /padding: 10px 14px calc\(10px \+ env\(safe-area-inset-bottom, 0px\)\)/);
  assert.match(stripComments(read("public", "admin.css")), /\.form-actions-sticky \{[^}]*calc\(12px \+ env\(safe-area-inset-bottom, 0px\)\)/);
  assert.match(stripComments(read("public", "admin.css")), /\.admin-sidebar \{[^}]*calc\(24px \+ env\(safe-area-inset-bottom, 0px\)\)/);
  assert.match(read("public", "scan-intake.css"), /safe-area-inset-bottom/);
});

test("viewport-fit=cover is NOT set: without it the home-screen app already stays inside the safe area, so the page is never under the indicator", () => {
  for (const f of ["views/partials/header.ejs", "views/marketing/partials/mkt_header.ejs", "views/partials/admin_header.ejs"])
    assert.ok(!/viewport-fit/.test(read(...f.split("/"))), f);
});

// ---- PH-29 fonts ----

test("each web font has a size-adjusted local fallback, and every font stack names it right after the web font", () => {
  for (const [file, label] of [[path.join(root, "public", "style.css"), "style.css"], [path.join(root, "..", "assets", "site.css"), "site.css"]]) {
    const css = fs.readFileSync(file, "utf8");
    for (const fam of ["Cormorant Garamond", "Libre Baskerville", "Nunito Sans", "Montserrat"]) {
      const face = new RegExp(`@font-face \\{ font-family: '${fam} Fallback'; src: local\\([^;]+; size-adjust: [\\d.]+%; ascent-override: [\\d.]+%; descent-override: [\\d.]+%; line-gap-override: 0%; \\}`).exec(css);
      assert.ok(face, `${label}: ${fam} Fallback face with size-adjust and the three overrides`);
      const size = Number(/size-adjust: ([\d.]+)%/.exec(face[0])[1]);
      assert.ok(size > 80 && size < 125, `${fam} size-adjust ${size}% is a plausible scale`);
    }
  }
  const bare = [];
  for (const file of cssFiles()) {
    const css = stripComments(fs.readFileSync(file, "utf8"));
    for (const m of css.matchAll(/font-family:\s*([^;}]*)[;}]/g)) {
      for (const fam of ["Cormorant Garamond", "Libre Baskerville", "Nunito Sans", "Montserrat"]) {
        if (m[1].includes(`'${fam}'`) && !m[1].includes(`'${fam}', '${fam} Fallback'`) && !/^\s*'[^']+'\s*$/.test(m[1]) ) bare.push(`${path.basename(file)}: ${m[0]}`);
      }
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
