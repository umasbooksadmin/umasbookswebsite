// Wording guard: the shop works by RESERVATION (reserve online, pay and collect in
// the shop), so customer-facing text, emails, dictionaries and the admin screens
// must say "reservation", never "order". The database table, routes, status keys
// and code identifiers keep their old names (orders, /admin/orders, order_id ...):
// only user-visible text is checked, so identifiers and comments are skipped.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "../..");

function walk(dir, ext, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, ext, out);
    else if (ext.some((x) => e.name.endsWith(x))) out.push(rel);
  }
  return out;
}

// Drops comments, so a developer note may still say "order".
function visibleText(file) {
  let s = fs.readFileSync(path.join(ROOT, file), "utf8");
  if (file.endsWith(".ejs")) s = s.replace(/<%#[\s\S]*?%>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  else s = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\w])\/\/.*$/gm, "$1");
  return s;
}

// Customer-facing: views outside admin/, the email builders, the dictionaries and
// client scripts, and the routes that put messages in front of customers.
const customerFiles = [
  ...walk("views", [".ejs"]).filter((f) => !f.startsWith(path.join("views", "admin"))),
  ...walk("src/routes", [".js"]).filter((f) => !f.includes(`${path.sep}admin${path.sep}`)),
  ...walk("public", [".js"]).filter((f) => !/till/.test(f)),
  "src/lib/orderEmail.js", "src/lib/orderSweeps.js", "src/lib/pageDictionary.js", "src/lib/legalText.js",
  "src/lib/legal.js", "src/lib/cart.js", "src/lib/privacy.js", "src/lib/frenchTypography.js",
];

const FORBIDDEN = [
  // English
  /\byour orders?\b/i, /\border confirmation\b/i, /\bplace(?:d|s)? an order\b/i, /\bplacing an order\b/i,
  /\border number\b/i, /\bmy orders\b/i, /\border history\b/i, /\bBooks (?:&|&amp;) orders\b/i,
  /\bunpaid orders?\b/i, /\bat checkout\b/i, /\bproceed to checkout\b/i,
  // French
  /\bvotre commande\b/i, /\bvos commandes\b/i, /\bma commande\b/i, /\bmes commandes\b/i,
  /\bconfirmation de (?:la )?commande\b/i, /\bnuméro de commande\b/i, /\bpasser (?:une )?commande\b/i,
  /\bcommandes? (?:en ligne|passée)/i, /\bles commandes\b/i, /\bune commande\b/i,
];

// file (relative) -> [{ pattern, reason }]: places where the old word is right.
const ALLOWED = [
  // Every entry needs a reason; never allow a whole file.
  { file: "src/routes/admin/till.js", re: /^Order$/, reason: "'Order must be a whole number': the sort position of a Till quick item, not a reservation" },
];

const allowed = (file, text) => ALLOWED.some((a) => a.file === file && a.re.test(text));

test("customer-facing text never speaks of orders: it is reservations (EN and FR)", () => {
  const hits = [];
  for (const file of customerFiles) {
    const text = visibleText(file);
    for (const re of FORBIDDEN) {
      const m = text.match(re);
      if (m && !allowed(file, m[0])) hits.push(`${file}: "${m[0]}"`);
    }
  }
  assert.deepEqual(hits, [], "say reservation / réservation, not order / commande");
});

test("the admin screens call them reservations too (menu, headings, buttons, reports)", () => {
  const ADMIN_FORBIDDEN = [/\bOrders?\b(?!\s*<\/label>)/, /\bBooks (?:&|&amp;) Orders\b/, /\bunpaid orders?\b/i, /\bpaid orders?\b/i, /\bthis order\b/i, /\bthe order\b/i];
  const files = [
    ...walk("views/admin", [".ejs"]), "src/lib/reports.js", "src/lib/orderActions.js", "src/lib/tillReservations.js",
    "src/lib/accounting.js", "src/lib/outboxAttention.js", "src/routes/admin/orders.js", "src/routes/admin/inventory.js",
    "src/routes/admin/sessions.js", "src/routes/admin/till.js",
  ];
  const hits = [];
  for (const file of files) {
    // The Till's "Order" box is the sort-order number of a quick item, not a reservation.
    const text = visibleText(file).replace(/<label for="[^"]*">Order<\/label>/g, "").replace(/ORDER-/g, "");
    for (const re of ADMIN_FORBIDDEN) {
      const m = text.match(re);
      if (m && !allowed(file, m[0])) hits.push(`${file}: "${m[0]}"`);
    }
  }
  assert.deepEqual(hits, [], "admin text should say Reservation(s)");
});

test("the guard itself catches the old wording", () => {
  assert.ok(FORBIDDEN.some((re) => re.test("Thanks for your order")));
  assert.ok(FORBIDDEN.some((re) => re.test("Votre commande n° 4")));
  assert.ok(FORBIDDEN.some((re) => re.test("Order confirmation")));
  assert.ok(!FORBIDDEN.some((re) => re.test("Your reservation #4")));
});
