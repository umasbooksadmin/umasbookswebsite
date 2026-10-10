// The inventory CSV: the admin download (Inventory > Download all inventory) and
// scripts/export-inventory-csv.js (the nightly job) give the SAME bytes for a
// seeded dataset; admin only; audited; no personal data even when a copy is
// reserved by a named person. Own throwaway database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { adminHarness } = require("../helpers/adminHarness");

const h = adminHarness("inventory_export", ["inventory"], { isolated: true });
const SECRETS = ["Secret Buyer", "secret.buyer@example.test", "0612345678"];
let tmp;
// The response body with its BOM (fetch().text() drops a leading BOM).
async function get(p, user = h.admin) {
  const res = await fetch(`${h.base}${p}`, { redirect: "manual", headers: user ? { "x-test-user": JSON.stringify(user) } : {} });
  return { res, text: Buffer.from(await res.arrayBuffer()).toString("utf8") };
}

before(async () => {
  await h.start();
  const { rows: [b1] } = await h.pool.query(
    "INSERT INTO books (isbn, title, authors, publisher, published_year, binding, categories) VALUES ('9780306406157', 'Dune; \"Part 1\"', 'Frank Herbert', 'Ace', 1965, 'mass_market', 'Science Fiction') RETURNING id");
  const { rows: [b2] } = await h.pool.query("INSERT INTO books (isbn, title) VALUES (NULL, '=SUM(A1)') RETURNING id");
  await h.pool.query("INSERT INTO books (title) VALUES ('No copies at all')");
  await h.pool.query(
    `INSERT INTO book_copies (book_id, condition, price, status, location, source, notes, is_clearance, publisher_price)
     VALUES ($1, 'very_good', 4.5, 'in_stock', 'Store', 'donation', 'torn corner', true, NULL),
            ($1, 'new', 12.9, 'in_stock', NULL, NULL, NULL, false, 12.9),
            ($2, 'good', NULL, 'sold', NULL, 'purchase', '+1 note', false, NULL)`, [b1.id, b2.id]);
  await h.pool.query(
    `INSERT INTO book_copies (book_id, condition, price, status, reserved_by_name, reserved_by_email, reserved_by_phone, reserved_at)
     VALUES ($1, 'good', 3, 'reserved', $2, $3, $4, now())`, [b1.id, ...SECRETS]);
  await h.pool.query("UPDATE book_copies SET sold_at = '2026-10-02 10:00+02' WHERE status = 'sold'");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inv-export-"));
});
after(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  await h.stop();
});

test("admin download: French-Excel CSV, one row per copy, no personal data", async () => {
  const { res, text } = await get("/admin/inventory/export.csv");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.match(res.headers.get("content-disposition"), /attachment; filename="inventory_\d{4}-\d\d-\d\d\.csv"/);
  assert.ok(text.startsWith("\uFEFF"));
  const lines = text.split("\r\n");
  assert.equal(lines.length, 6); // header, 4 copies, trailing empty
  assert.match(lines[0], /^\uFEFF"ISBN-13";"ISBN-10";"Title"/);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), secret);
  assert.match(text, /"Reserved"/);
  assert.match(text, /"'=SUM\(A1\)"/); // formula neutralised
  assert.match(text, /;4,50;/); // decimal comma
  assert.match(text, /"2026-10-02"/); // date sold
  assert.ok(!text.includes("No copies at all"));
});

test("per-book download includes books without copies", async () => {
  const { res, text } = await get("/admin/inventory/export.csv?books=1");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /inventory_books_/);
  assert.ok(text.includes("No copies at all"));
  assert.equal(text.split("\r\n").length, 5);
});

test("only an admin can download", async () => {
  for (const user of [null, h.member]) {
    const { res, text } = await get("/admin/inventory/export.csv", user);
    assert.notEqual(res.status, 200);
    assert.ok(!text.includes("Frank Herbert"));
  }
});

test("each download is written to the admin activity log", async () => {
  const rows = await h.q("SELECT detail FROM admin_audit_log WHERE action = 'inventory.csv' ORDER BY id");
  assert.ok(rows.length >= 2);
  assert.match(rows[0].detail, /per copy: 4 rows/);
  assert.match(rows[1].detail, /per book: 3 rows/);
});

test("the nightly script writes the same bytes as the download, prints counts only", async () => {
  const out = execFileSync("node", ["scripts/export-inventory-csv.js", "--out", tmp, "--date", "2026-10-09"], {
    cwd: path.join(__dirname, "..", ".."), env: process.env, encoding: "utf8",
  });
  assert.equal(out.trim(), [
    "date=2026-10-09", "copies=4", "in_stock=2", "reserved=1", "sold=1", "other=0", "books=3",
    `copies_bytes=${fs.statSync(path.join(tmp, "inventory_2026-10-09.csv")).size}`,
    `books_bytes=${fs.statSync(path.join(tmp, "inventory_books_2026-10-09.csv")).size}`,
  ].join("\n"));
  for (const secret of [...SECRETS, "Frank Herbert", "Dune"]) assert.ok(!out.includes(secret));
  assert.deepEqual(fs.readdirSync(tmp).sort(), ["inventory_2026-10-09.csv", "inventory_books_2026-10-09.csv", "inventory_latest.csv"].sort());
  const file = fs.readFileSync(path.join(tmp, "inventory_2026-10-09.csv"), "utf8");
  assert.equal(fs.readFileSync(path.join(tmp, "inventory_latest.csv"), "utf8"), file);
  assert.equal(file, (await get("/admin/inventory/export.csv")).text);
  assert.equal(fs.readFileSync(path.join(tmp, "inventory_books_2026-10-09.csv"), "utf8"), (await get("/admin/inventory/export.csv?books=1")).text);
});

test("the script fails clearly without --out or with a bad date", () => {
  for (const args of [[], ["--out", tmp, "--date", "2026-02-31"]]) {
    assert.throws(() => execFileSync("node", ["scripts/export-inventory-csv.js", ...args], {
      cwd: path.join(__dirname, "..", ".."), env: process.env, stdio: "pipe",
    }), (err) => err.status === 1 && /Inventory export failed/.test(String(err.stderr)));
  }
});

test("the script uses only SELECTs", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "lib", "inventoryExport.js"), "utf8")
    + fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "export-inventory-csv.js"), "utf8");
  assert.doesNotMatch(src, /\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM|DROP TABLE|ALTER TABLE|TRUNCATE)\b/i);
});
