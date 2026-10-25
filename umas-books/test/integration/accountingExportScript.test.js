// scripts/export-accounting-month.js on a seeded database: the CSV is the admin export's own output,
// refunds are negative rows in the month of the refund, Paris month boundaries (a sale at 00:30 on
// 1 October Paris time is October even though it is still September in UTC), an empty month still
// succeeds, and no personal data reaches any file although the seed is full of it.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { prepareDatabase } = require("../helpers/inProcessApp");
const { makeOrder } = require("../helpers/orderFixtures");

const db = prepareDatabase("acctexport", { isolated: true });
const { pool } = require("../../src/db");
const { main } = require("../../scripts/export-accounting-month");
const accounting = require("../../src/lib/accounting");
const reports = require("../../src/lib/reports");
const ax = require("../../src/lib/accountingExport");

const NOW = new Date("2026-10-09T10:00:00Z");
const PII = ["jean.dupont@example.org", "Jean Dupont", "06 12 34 56 78", "Fixture Buyer", "buyer-secret@example.test"];
let seq = 0;

before(async () => {
  db.create();
  await pool.query("INSERT INTO users (email, password_hash, display_name) VALUES ('jean.dupont@example.org', 'x', 'Jean Dupont')");
  const sale = async ({ at, method = "cash", status = "completed", lines, receipt = null, reason = null }) => {
    const total = lines.reduce((a, l) => a + l[1] * l[2], 0);
    const { rows } = await pool.query(
      `INSERT INTO till_sales (created_at, payment_method, total_cents, sale_token, status, receipt_year, receipt_no, void_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [at, method, total, `tok-${++seq}`, status, receipt && Number(at.slice(0, 4)), receipt, reason]);
    for (const [category, qty, cents] of lines) {
      await pool.query(`INSERT INTO till_sale_items (sale_id, kind, description, quantity, unit_price_cents, category) VALUES ($1, 'manual', 'item', $2, $3, $4)`, [rows[0].id, qty, cents, category]);
    }
  };
  // September 2026 (CEST, UTC+2)
  await sale({ at: "2026-08-31T22:30:00Z", lines: [["books_used", 1, 700]], receipt: 1 }); // 00:30 on 1 Sept Paris: September
  await sale({ at: "2026-09-10T10:00:00+02", lines: [["books_used", 1, 1000], ["refreshments", 1, 250]], receipt: 2 });
  await sale({ at: "2026-09-10T15:00:00+02", method: "card", lines: [["merchandise", 1, 2000]], receipt: 3 });
  await sale({ at: "2026-09-10T16:00:00+02", status: "voided", lines: [["books_used", 1, 500]], receipt: 4, reason: "customer jean.dupont@example.org asked, phone 06 12 34 56 78" });
  await sale({ at: "2026-09-30T22:30:00Z", lines: [["books_used", 1, 900]], receipt: 5 }); // 00:30 on 1 Oct Paris: October
  await pool.query(`INSERT INTO till_days (day, opening_float_cents, counted_cash_cents, expected_cash_cents, difference_cents, closed_at, note)
                    VALUES ('2026-09-10', 5000, 6200, 6250, -50, '2026-09-10T18:00:00+02', 'Jean Dupont counted')`);
  await pool.query(`INSERT INTO till_days (day, opening_float_cents) VALUES ('2026-09-01', 4000)`);
  await pool.query(`INSERT INTO membership_payments (helloasso_order_id, payer_email, amount_cents, paid_at) VALUES (9001, 'jean.dupont@example.org', 3000, '2026-09-15T12:00:00+02')`);
  // A reservation paid in cash in September and refunded in October: its refund is a negative row in OCTOBER.
  const { order } = await makeOrder(pool, { status: "refunded", paidAt: "2026-09-05T11:00:00+02", price: 8, name: "Jean Dupont", email: "buyer-secret@example.test" });
  await pool.query("UPDATE orders SET payment_method = 'cash', refunded_at = '2026-10-03T11:00:00+02' WHERE id = $1", [order.id]);
});
after(async () => { await pool.end(); db.drop(); });

const outDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "acctexp-"));
const read = (d, f) => fs.readFileSync(path.join(d, f), "utf8");
const run = async (args) => { const d = outDir(); const r = await main([...args, "--out", d], NOW); return { d, r }; };

test("September: the files exist, the CSV is the admin export's own, boundaries are Paris", async () => {
  const { d, r } = await run(["--month", "2026-09"]);
  assert.deepEqual(fs.readdirSync(d).sort(), ["accounting_2026-09.csv", "email_body.txt", "summary_2026-09.txt", "till_days_2026-09.csv"]);
  const csv = read(d, "accounting_2026-09.csv");
  // same function as Admin > Reports > Accounting export
  const admin = await accounting.accountingExportReport(pool, { from: "2026-09-01", to: "2026-09-30" });
  assert.equal(csv, reports.toCsv(admin.sections[0], { locale: "fr" }));
  assert.ok(csv.startsWith("\uFEFF"), "UTF-8 BOM");
  assert.ok(csv.includes("\r\n") && !/[^\r]\n/.test(csv), "CRLF");
  assert.match(csv.split("\r\n")[0], /^\uFEFF"Date";"Category"/);
  assert.match(csv, /;12,50;|;10,00;/, "decimal comma");
  assert.equal(r.stats.accountingRows, admin.sections[0].rows.length);
  const totals = await accounting.salesTotals(pool, "2026-09-01", "2026-09-30");
  assert.equal(r.stats.totalCents, totals.totalCents);
  // 7.00 (00:30 on 1 Sept Paris) + 10 + 2.50 + 20 (till) + 30 (membership) - 0.50 (cash short) + 8 (reservation, cash); the 9.00 sale is October
  assert.equal(r.stats.totalCents, 700 + 1000 + 250 + 2000 + 3000 - 50 + 800);
  assert.doesNotMatch(csv, /"2026-10-01"/);
  assert.match(csv, /"2026-09-01";"Books used";"Cash"/);
});

test("the refund is a negative row in October, not in September", async () => {
  const sep = read((await run(["--month", "2026-09"])).d, "accounting_2026-09.csv");
  const { d, r } = await run(["--month", "2026-10", "--force"]);
  const oct = read(d, "accounting_2026-10.csv");
  assert.doesNotMatch(sep, /Remboursement/);
  assert.match(oct, /Remboursement/);
  assert.match(oct, /"2026-10-03";[^\r\n]*;-1;-8,00;/);
  assert.match(oct, /"2026-10-01";"Books used";"Cash";1;9,00;/); // the 00:30 Paris sale
  assert.equal(r.stats.refunds, 1);
});

test("till days: one row per day, float, counted, difference, totals, receipt range, closed", async () => {
  const { d, r } = await run(["--month", "2026-09"]);
  const lines = read(d, "till_days_2026-09.csv").replace(/^\uFEFF/, "").split("\r\n").filter(Boolean);
  assert.equal(lines[0], ax.TILL_HEADER.map((h) => `"${h}"`).join(";"));
  assert.equal(lines.length, 1 + 2, "1 and 10 September (the 30 September 22:30Z sale is 1 October in Paris)");
  const by = Object.fromEntries(lines.slice(1).map((l) => [l.split(";")[0].replace(/"/g, ""), l.split(";")]));
  assert.deepEqual(Object.keys(by), ["2026-09-01", "2026-09-10"]);
  const ten = by["2026-09-10"];
  assert.deepEqual(ten.slice(1, 8), ["50,00", "62,00", "62,50", "-0,50", "12,50", "20,00", "32,50"]);
  assert.deepEqual(ten.slice(8), ["2", "1", '"2026-0002"', '"2026-0004"', '"yes"', "0,00", "0,00"]); // ... cash refunds, then the admin-button cash (last column)
  assert.equal(by["2026-09-01"][12], '"no"');
  assert.equal(r.stats.unclosedDays, 1, "1 September has a sale and no closing");
  const summary = read(d, "summary_2026-09.txt");
  assert.match(summary, /Till sales: 3/);
  assert.match(summary, /Voided till sales: 1/);
  assert.match(summary, /2026-0001 to 2026-0004/);
  assert.match(summary, /not closed: 1 \(2026-09-01\)/);
  assert.match(summary, /707 \| Cash:/);
});

test("no personal data in any file, though the seed has names, emails and a phone number everywhere", async () => {
  for (const month of ["2026-09", "2026-10"]) {
    const d = (await run(["--month", month, "--force"])).d;
    for (const f of fs.readdirSync(d)) {
      const text = read(d, f);
      assert.doesNotMatch(text, /@/, f);
      assert.doesNotMatch(text, /\d{2}[ .]\d{2}[ .]\d{2}[ .]\d{2}[ .]\d{2}|\d{10,}/, f);
      for (const p of PII) assert.ok(!text.includes(p), `${f} contains ${p}`);
    }
    const csv = read(d, `accounting_${month}.csv`).replace(/^\uFEFF/, "");
    assert.deepEqual(csv.split("\r\n")[0].split(";").map((c) => c.replace(/"/g, "")), ax.ACCOUNTING_HEADER);
  }
});

test("an empty month succeeds with headers only and a 'no sales' summary", async () => {
  const { d, r } = await run(["--month", "2026-07"]);
  assert.equal(r.stats.accountingRows, 0);
  const csv = read(d, "accounting_2026-07.csv").replace(/^\uFEFF/, "");
  assert.equal(csv.split("\r\n").filter(Boolean).length, 1);
  assert.equal(read(d, "till_days_2026-07.csv").replace(/^\uFEFF/, "").split("\r\n").filter(Boolean).length, 1);
  assert.match(read(d, "summary_2026-07.txt"), /No sales were recorded in this period/);
  assert.match(read(d, "email_body.txt"), /overstated/);
  assert.match(read(d, "email_body.txt"), /No sales were recorded/);
});

test("the current month and future months are refused unless forced; nothing is written", async () => {
  for (const month of ["2026-10", "2026-11", "2027-01"]) {
    const d = outDir();
    await assert.rejects(main(["--month", month, "--out", d], NOW), /current month|future/);
    assert.deepEqual(fs.readdirSync(d), []);
  }
  await assert.doesNotReject(run(["--month", "2026-10", "--force"]));
});

test("the default month is the previous Paris month", async () => {
  const d = outDir();
  await main(["--out", d], new Date("2026-11-01T06:00:00Z"));
  assert.ok(fs.existsSync(path.join(d, "accounting_2026-10.csv")));
});

test("year mode: the whole year, a different financial year start, and the file names", async () => {
  const { d, r } = await run(["--year", "2026"]);
  assert.deepEqual(fs.readdirSync(d).sort(), ["accounting_2026-full-year.csv", "email_body.txt", "summary_2026-full-year.txt", "till_days_2026-full-year.csv"]);
  const admin = await accounting.accountingExportReport(pool, { from: "2026-01-01", to: "2026-12-31" });
  assert.equal(read(d, "accounting_2026-full-year.csv"), reports.toCsv(admin.sections[0], { locale: "fr" }));
  assert.equal(r.stats.accountingRows, admin.sections[0].rows.length);
  // a financial year starting in October 2026 contains the October rows only
  const fy = await run(["--year", "2026", "--fiscal-start-month", "10"]);
  const oct = await accounting.accountingExportReport(pool, { from: "2026-10-01", to: "2027-09-30" });
  assert.equal(fy.r.stats.accountingRows, oct.sections[0].rows.length);
  assert.ok(fy.r.stats.accountingRows < r.stats.accountingRows);
  // "last" is the last year that ended before today (2025 on 9 Oct 2026): nothing happened then
  const last = await run(["--year", "last"]);
  assert.equal(last.r.range.label, "2025-full-year");
  assert.equal(last.r.stats.accountingRows, 0);
});

test("the export only reads: it runs in a READ ONLY transaction", async () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "export-accounting-month.js"), "utf8");
  assert.match(src, /BEGIN READ ONLY/);
  assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/);
  const before = (await pool.query("SELECT (SELECT COUNT(*) FROM till_sales) a, (SELECT COUNT(*) FROM till_days) b, (SELECT COUNT(*) FROM orders) c")).rows[0];
  await run(["--month", "2026-09"]);
  assert.deepEqual((await pool.query("SELECT (SELECT COUNT(*) FROM till_sales) a, (SELECT COUNT(*) FROM till_days) b, (SELECT COUNT(*) FROM orders) c")).rows[0], before);
});
