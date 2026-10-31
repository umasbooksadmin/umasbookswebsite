// D4: the Accounting export page warns when a month that the monthly export has already produced was changed
// afterwards (a late/backdated till sale, a void, a late close with a difference, a late membership payment),
// and says when the range includes the current month. Real app, real database, real admin page.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { tillHarness } = require("../helpers/tillHarness");

let h;
before(async () => { h = await tillHarness({ port: 4881, ip: "10.88.1.1" }); });
after(async () => { await h.stop(); });

const staleness = () => require("../../src/lib/accountingStaleness");
const page = async (from, to) => (await h.get(`/admin/reports/accounting?from=${from}&to=${to}`)).text;
// A closed month far in the past (its export surely ran): January 2025. Rows are cleaned between tests.
const FROM = "2025-01-01", TO = "2025-01-31";
async function clean() {
  await h.pool.query("DELETE FROM till_sales WHERE sale_token LIKE 'stale-%'");
  await h.pool.query("DELETE FROM till_days WHERE day = '2025-01-15'");
  await h.pool.query("DELETE FROM membership_payments WHERE helloasso_order_id BETWEEN 990000001 AND 990000009");
}
// A completed (or voided) sale made on 2025-01-15 and typed in at `entered` (SQL expression).
const sale = (token, { entered = "'2025-01-15 10:00+01'", voided = false } = {}) => h.pool.query(
  `INSERT INTO till_sales (created_at, payment_method, total_cents, sale_token, entered_at, status, voided_at)
   VALUES ('2025-01-15 10:00+01', 'cash', 500, $1, ${entered}, ${voided ? "'voided'" : "'completed'"}, ${voided ? "now()" : "NULL"})`, [token]);

test("a month with nothing changed after its export has no warning", async () => {
  await clean();
  await sale("stale-ok");
  assert.equal(await staleness().stalenessBanner(h.pool, FROM, TO), null);
  assert.doesNotMatch(await page(FROM, TO), /newer than the monthly export/);
});

test("a sale typed in after the month was exported is flagged, with the month and the count", async () => {
  await clean();
  await sale("stale-late", { entered: "now()" });
  const b = await staleness().stalenessBanner(h.pool, FROM, TO);
  assert.match(b.text, /2025-01: 1 till sale entered late or backdated/);
  assert.match(await page(FROM, TO), /newer than the monthly export already made/);
});

test("a sale typed in on the 1st before the export hour is not flagged", async () => {
  await clean();
  await sale("stale-early", { entered: "'2025-02-01 08:00+01'" });
  assert.equal(await staleness().stalenessBanner(h.pool, FROM, TO), null);
});

test("a sale voided after the month was exported is flagged", async () => {
  await clean();
  await sale("stale-void", { voided: true });
  const b = await staleness().stalenessBanner(h.pool, FROM, TO);
  assert.match(b.text, /2025-01: 1 till sale voided/);
});

test("a late-closed day with a cash difference and a late membership payment are flagged; a zero difference is not", async () => {
  await clean();
  await h.pool.query("INSERT INTO till_days (day, opening_float_cents, closed_at, difference_cents) VALUES ('2025-01-15', 5000, now(), 0)");
  assert.equal(await staleness().stalenessBanner(h.pool, FROM, TO), null);
  await h.pool.query("UPDATE till_days SET difference_cents = -200 WHERE day = '2025-01-15'");
  assert.match((await staleness().stalenessBanner(h.pool, FROM, TO)).text, /1 day closed with a cash difference/);
  await h.pool.query("DELETE FROM till_days WHERE day = '2025-01-15'");
  await h.pool.query("INSERT INTO membership_payments (helloasso_order_id, payer_email, amount_cents, paid_at) VALUES (990000001, 'm@example.test', 1500, '2025-01-20 12:00+01')");
  assert.match((await staleness().stalenessBanner(h.pool, FROM, TO)).text, /1 membership payment recorded/);
});

test("changes outside the range shown are not reported", async () => {
  await clean();
  await sale("stale-out", { entered: "now()" });
  assert.equal(await staleness().stalenessBanner(h.pool, "2025-02-01", "2025-02-28"), null);
});

test("the CSV download is unchanged (no warning text in it)", async () => {
  await clean();
  await sale("stale-csv", { entered: "now()" });
  const r = await h.get(`/admin/reports/accounting?format=csv&from=${FROM}&to=${TO}`);
  assert.equal(r.res.status, 200);
  assert.doesNotMatch(r.text, /newer than the monthly export/);
});

test("a range that includes the current month says it is not final", async () => {
  await clean();
  const today = (await h.pool.query("SELECT (now() AT TIME ZONE 'Europe/Paris')::date::text AS d")).rows[0].d;
  assert.match(await page(today.slice(0, 8) + "01", today), /includes the current month, which is not over/);
  assert.doesNotMatch(await page(FROM, TO), /includes the current month/);
});
