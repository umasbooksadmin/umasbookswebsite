// On a phone the admin sidebar (with its logo) is a closed off-canvas drawer, so
// every admin page carries a small logo link to the main page ("/") in its top
// bar (views/partials/admin_header.ejs, shown by public/admin.css up to 900px).
// This checks the markup: the partial itself in every variant, that every admin
// view uses the partial (so none can skip the logo), real admin pages over HTTP,
// and the CSS rules that show it on phones and keep it hidden on desktop.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");
const { adminHarness } = require("../helpers/adminHarness");

const ROOT = path.join(__dirname, "..", "..");
const PARTIAL = path.join(ROOT, "views", "partials", "admin_header.ejs");

const h = adminHarness("adminphonelogo", ["charity", "audit", "reports"], { isolated: true });
before(h.start);
after(h.stop);

// The top-bar logo link: href "/", an image named exactly like the brand, before the page title.
function assertBrandLink(html, where) {
  const m = html.match(/<div class="admin-topbar">([\s\S]*?)<h1>/);
  assert.ok(m, `${where}: no top bar`);
  const a = m[1].match(/<a class="admin-topbar-brand" href="\/">([\s\S]*?)<\/a>/);
  assert.ok(a, `${where}: no link to "/" with class admin-topbar-brand in the top bar`);
  assert.match(a[1], /<img [^>]*src="\/assets\/img\/logo-wordmark-framed\.png"[^>]*alt="Uma's Books and Adventures"/, `${where}: the link has no logo image named "Uma's Books and Adventures"`);
}

test("the admin header partial has the logo link to '/' in every variant", async () => {
  const variants = [
    { active: "overview", pageTitle: "Dashboard" },
    { active: "inventory", pageTitle: "Inventory" },
    { active: "till", pageTitle: "Till", tillOnly: true },
    { active: "reports", pageTitle: "Reports", mainWide: true },
  ];
  for (const v of variants) {
    const html = await ejs.renderFile(PARTIAL, { user: { displayName: "Admin Tester" }, ...v });
    assertBrandLink(html, JSON.stringify(v));
  }
});

test("every admin page view includes the admin header partial (so none can miss the logo)", () => {
  const files = [];
  (function walk(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.isDirectory()) walk(path.join(dir, f.name));
      else if (f.name.endsWith(".ejs")) files.push(path.join(dir, f.name));
    }
  })(path.join(ROOT, "views", "admin"));
  assert.ok(files.length > 20, "found the admin views");
  // Fragments (_name.ejs) are included by pages; the till receipt is a standalone printable slip.
  const missing = files.filter((f) => !path.basename(f).startsWith("_") && !f.endsWith(path.join("till", "receipt.ejs")))
    .filter((f) => !/include\('(\.\.\/)+partials\/admin_header'/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(missing.map((f) => path.relative(ROOT, f)), [], "admin views that do not use partials/admin_header");
});

test("real admin pages render the logo link in the top bar", async () => {
  for (const p of ["/admin/charity", "/admin/audit", "/admin/reports"]) {
    const { res, text } = await h.get(p);
    assert.equal(res.status, 200, p);
    assertBrandLink(text, p);
  }
});

test("the stylesheet hides the top-bar logo on desktop and shows it, 44 px tall at least, on phones", () => {
  const css = fs.readFileSync(path.join(ROOT, "public", "admin.css"), "utf8");
  assert.match(css, /^\.admin-topbar-brand \{ display: none; \}/m, "hidden by default (desktop layout unchanged)");
  const phone = css.match(/@media \(max-width: 900px\) \{([\s\S]*?)\n\}\n/);
  assert.ok(phone, "the 900px block");
  assert.match(phone[1], /\.admin-topbar-brand \{[^}]*display: block;[^}]*min-height: 44px/, "shown with a 44 px touch target");
});

// The page title (Back link + h1) must be a SIBLING of the tools wrapper, not inside it. Inside, the
// desktop/tablet flex row laid it out after the search box and the initials, so "Inventory" sat on the
// right (and off screen on a narrow window above 900 px, e.g. a phone turned sideways).
function topbarChildren(html) {
  const start = html.indexOf('<div class="admin-topbar">');
  assert.ok(start >= 0, "no top bar");
  let depth = 0;
  const kids = [];
  const re = /<div\b[^>]*>|<\/div>/g;
  re.lastIndex = start;
  let m;
  while ((m = re.exec(html))) {
    if (m[0] === "</div>") { depth--; if (depth === 0) break; continue; }
    depth++;
    if (depth === 2) kids.push(m[0]);
  }
  return kids;
}

test("the page title is a direct child of the top bar, next to (not inside) the tools wrapper", async () => {
  for (const v of [{ active: "inventory", pageTitle: "Inventory" }, { active: "overview", pageTitle: "Dashboard" }, { active: "till", pageTitle: "Till", tillOnly: true }]) {
    const html = await ejs.renderFile(PARTIAL, { user: { displayName: "Admin Tester" }, ...v });
    const kids = topbarChildren(html);
    assert.ok(kids.some((k) => k.includes("admin-topbar-tools")), "tools wrapper is a direct child");
    assert.ok(kids.some((k) => k.includes("admin-topbar-title")), `${JSON.stringify(v)}: the title wrapper must be a direct child of .admin-topbar, not inside .admin-topbar-tools`);
    const tools = html.match(/<div class="admin-topbar-tools">([\s\S]*?)<div class="admin-topbar-title">/);
    assert.ok(tools && !/<h1>/.test(tools[1]) && (tools[1].match(/<div\b/g) || []).length + 1 === (tools[1].match(/<\/div>/g) || []).length, "the tools wrapper is closed before the title starts");
  }
});

test("the stylesheet keeps the title on the left: before the tools on desktop, never right-aligned", () => {
  const css = fs.readFileSync(path.join(ROOT, "public", "admin.css"), "utf8");
  assert.match(css, /^\.admin-topbar-title \{ order: 1; min-width: 0; \}/m);
  assert.match(css, /^\.admin-topbar-tools \{ order: 2; \}/m);
  const rule = (css.match(/^\.admin-topbar-title\b[^{]*\{[^}]*\}/gm) || []).join("\n");
  assert.doesNotMatch(rule, /margin-left:\s*auto|text-align:\s*(right|end)/);
});
