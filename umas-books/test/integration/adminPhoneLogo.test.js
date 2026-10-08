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
