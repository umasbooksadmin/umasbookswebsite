// RECONCILIATION (Review C, C-M1 and C-M2): the accounting export, the Sales report, the Refunds report and
// the Dashboard's sales figure are four views of the same money. Over one seeded fixture set they must agree
// to the cent, per day and per month, and the export must equal what was really received minus what was
// refunded. The fixtures: no discount; a discount given at collection (several lines, odd cents); a partial
// pickup with a discount; a reservation collected at the till then refunded; one collected with the admin
// button then refunded; a discounted order that is refunded; and cash / card refunds against the drawer.
// Real app, real database, the real routes for collecting and refunding.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { tillHarness } = require("../helpers/tillHarness");

let h;
let cart;
let lib;
before(async () => {
  h = await tillHarness({ port: 4873, ip: "10.87.3.3" });
  cart = require("../../src/lib/cart");
  lib = {
    accounting: require("../../src/lib/accounting"),
    reports: require("../../src/lib/reports"),
    dashboard: require("../../src/lib/dashboardStats"),
    till: require("../../src/lib/till"),
    actions: require("../../src/lib/orderActions"),
  };
});
after(async () => { await h.stop(); });

const cents = (euros) => Math.round(euros * 100);
const paris = async (offsetDays = 0) => (await h.pool.query("SELECT ((now() AT TIME ZONE 'Europe/Paris')::date + $1::int)::text AS d", [offsetDays])).rows[0].d;

// A reservation of one line per price (euros, 2 decimals) for a fresh account.
async function reserve(prices) {
  const { rows: u } = await h.pool.query(
    "INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, 'x', 'Recon Buyer', now()) RETURNING id, email", [`recon-${h.uniq()}@example.test`]);
  const items = [];
  for (const price of prices) {
    const book = await h.seedBook(`Recon ${h.uniq()}`);
    const copy = await h.seedCopy(book.id, { price, location: "R9" });
    items.push({ kind: "book", copyId: copy, title: `Recon ${copy}`, price });
  }
  const order = await cart.createReservation(h.pool, { user: u[0], name: "Recon Buyer", items, acceptedVersion: "v", hasDropin: false });
  const lines = (await h.pool.query("SELECT id FROM order_items WHERE order_id = $1 ORDER BY id", [order.id])).rows.map((r) => r.id);
  return { id: order.id, lines };
}
// The admin form "Mark collected and paid" (all lines still held).
async function collectByAdmin(r, method, amountReceived, note = "") {
  const res = await h.post(`/admin/orders/${r.id}/collect`, { method, amountReceived: amountReceived === undefined ? "" : String(amountReceived), note });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location") || "", /collected-paid/, `collect refused: ${res.headers.get("location")}`);
}
async function collectAtTill(r, method) {
  const res = await h.sale(r.lines.map((id) => ({ kind: "reserved", orderId: r.id, itemId: id })), { method, received: "100" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}
async function refund(r, refundMethod) {
  const res = await h.post(`/admin/orders/${r.id}/refund`, { confirmRefunded: "on", refundMethod, note: "gave the money back" });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location") || "", /notice=refunded/, `refund refused: ${res.headers.get("location")}`);
}
const order = async (id) => (await h.pool.query("SELECT *, refund_till_day::text AS refund_day FROM orders WHERE id = $1", [id])).rows[0];
const exportNet = async (from, to) => (await lib.accounting.accountingRows(h.pool, from, to)).reduce((a, r) => a + r.cents, 0);

const F = {}; // the fixtures, by name
const RECEIVED = {}; // what the customer really paid, cents
const REFUNDED = new Set();

test("fixtures: every way a reservation can be collected and refunded", async () => {
  assert.equal((await h.post("/admin/till/day/open", { openingFloat: "50" })).status, 302);

  // A: no discount, admin button, cash, kept
  F.plain = await reserve([5]);
  await collectByAdmin(F.plain, "cash");
  RECEIVED.plain = 500;
  // B: discount at collection, three lines with odd cents (list 15.06), 12.50 received by card, kept
  F.disc = await reserve([4.01, 5.02, 6.03]);
  await collectByAdmin(F.disc, "card", "12.50", "regular customer");
  RECEIVED.disc = 1250;
  // C: partial pickup (two of three lines) AND a discount, the rest stays reserved
  F.part = await reserve([5, 7, 9]);
  const r = await lib.actions.collectReservation(h.pool, F.part.id, { adminUserId: h.adminId, method: "cheque", amountReceived: "10", note: "pickup deal", itemIds: [F.part.lines[0], F.part.lines[2]] });
  assert.equal(r.outcome, "collected");
  assert.deepEqual([r.total, r.reservedTotal, r.discount, r.partial], [10, 14, 4, true]);
  RECEIVED.part = 1000;
  // D: collected AT THE TILL in cash, then refunded in cash from the drawer
  F.tillRefunded = await reserve([5]);
  await collectAtTill(F.tillRefunded, "cash");
  await refund(F.tillRefunded, "cash");
  RECEIVED.tillRefunded = 500; REFUNDED.add("tillRefunded");
  // E: collected with the admin button (cash), refunded by card on the terminal (no drawer effect)
  F.adminRefunded = await reserve([6]);
  await collectByAdmin(F.adminRefunded, "card");
  await refund(F.adminRefunded, "card");
  RECEIVED.adminRefunded = 600; REFUNDED.add("adminRefunded");
  // F: a DISCOUNTED order, refunded in cash: the refund reverses what was RECEIVED
  F.discRefunded = await reserve([3.33, 6.67, 8.01]);
  await collectByAdmin(F.discRefunded, "cash", "12.00", "damaged cover");
  await refund(F.discRefunded, "cash");
  RECEIVED.discRefunded = 1200; REFUNDED.add("discRefunded");
  // G: till collection by card, kept
  F.tillKept = await reserve([8]);
  await collectAtTill(F.tillKept, "card");
  RECEIVED.tillKept = 800;
  // The collected orders' totals are exactly what was received
  for (const k of Object.keys(RECEIVED)) assert.equal(cents(Number((await order(F[k].id)).total_amount)), RECEIVED[k], k);

  // Spread the history over days and months (the refunds all happened today): A a month and a half ago,
  // B yesterday, F three weeks ago; C, D, E, G today.
  await h.pool.query("UPDATE orders SET paid_at = paid_at - interval '45 days' WHERE id = $1", [F.plain.id]);
  await h.pool.query("UPDATE orders SET paid_at = paid_at - interval '1 day' WHERE id = $1", [F.disc.id]);
  await h.pool.query("UPDATE orders SET paid_at = paid_at - interval '21 days' WHERE id = $1", [F.discRefunded.id]);
});

test("the export is exactly what was received minus what was refunded, with the discount shown on its own row", async () => {
  const from = "2000-01-01"; const to = await paris();
  const rows = await lib.accounting.accountingRows(h.pool, from, to);
  const received = Object.values(RECEIVED).reduce((a, b) => a + b, 0);
  const refunded = [...REFUNDED].reduce((a, k) => a + RECEIVED[k], 0);
  assert.equal(rows.reduce((a, x) => a + x.cents, 0), received - refunded, "export total == received - refunded");
  assert.equal(rows.filter((x) => x.category === "Cash over/short").length, 0, "no over/short row");
  // the lines stay at list price; the discount is its own negative row per day and method
  const discount = rows.filter((x) => x.category === "Discount" && !x.refund);
  assert.deepEqual(discount.map((x) => [x.method, x.cents]).sort(), [["Card at the till", -256], ["Cash", -601], ["Cheque", -400]].sort());
  const reversed = rows.filter((x) => x.category === "Discount" && x.refund);
  assert.deepEqual(reversed.map((x) => [x.method, x.cents]), [["Cash", 601]], "a refund reverses the discount row too");
  assert.equal(rows.filter((x) => x.category === "Discount").every((x) => x.count === 0), true);
  // list-price book rows: A 5, B 15.06, C 14 (the two collected lines of 5 and 9), D 5, E 6, F 18.01, G 8
  const books = rows.filter((x) => x.category === "Books used" && !x.refund).reduce((a, x) => a + x.cents, 0);
  assert.equal(books, 500 + 1506 + 1400 + 500 + 600 + 1801 + 800, "lines at list price");
  // idempotent
  assert.deepEqual(await lib.accounting.accountingRows(h.pool, from, to), rows);
  // the CSV label and accounts
  const rep = await lib.accounting.accountingExportReport(h.pool, { from, to });
  const d = rep.sections[0].rows.find((x) => x.category === "Discount" && x.method === "Cash" && !x.refund);
  assert.equal(d.credit, "709");
  assert.match(d.label, /^Remise accordée au retrait/);
  assert.equal(rep.sections[0].rows.find((x) => x.category === "Discount" && x.refund).label.startsWith("Annulation de remise"), true);
});

test("export, Sales report, Refunds report and Dashboard agree to the cent, per day and per month", async () => {
  const today = await paris();
  const { rows: dayRows } = await h.pool.query(
    `SELECT DISTINCT d::text AS d FROM (
       SELECT (paid_at AT TIME ZONE 'Europe/Paris')::date AS d FROM orders WHERE paid_at IS NOT NULL
       UNION SELECT (refunded_at AT TIME ZONE 'Europe/Paris')::date FROM orders WHERE refunded_at IS NOT NULL) x ORDER BY 1`);
  const days = dayRows.map((r) => r.d);
  assert.ok(days.length >= 4, `fixtures span several days: ${days}`);

  // One range: books + drop-in + discounts of the PAID orders (the Sales report), plus the sales of orders that
  // were refunded (the Sales report leaves them out), minus what the Refunds report says was given back.
  async function reportsFor(from, to) {
    const run = await lib.reports.runReport(h.pool, lib.reports.getReport("sales"), { from, to, group: "year" });
    const sec = (k) => run.sections.find((s) => s.key === k);
    const salesEuros = sec("books").totals.total_revenue + sec("dropin").totals.revenue;
    const refundsEuros = sec("refunds").totals.amount;
    const { rows } = await h.pool.query(
      `SELECT COALESCE(SUM(ROUND(total_amount * 100)), 0)::int AS c FROM orders
       WHERE status = 'refunded' AND paid_at >= ($1::date)::timestamp AT TIME ZONE 'Europe/Paris' AND paid_at < (($2::date) + 1)::timestamp AT TIME ZONE 'Europe/Paris'`, [from, to]);
    return cents(salesEuros) + rows[0].c - cents(refundsEuros);
  }
  for (const day of days) {
    const exp = await exportNet(day, day);
    assert.equal(await reportsFor(day, day), exp, `Sales + Refunds reports == export on ${day}`);
    assert.equal((await lib.accounting.salesTotals(h.pool, day, day)).totalCents, exp, `salesTotals == export on ${day}`);
  }
  const months = [...new Set(days.map((d) => d.slice(0, 7)))];
  for (const m of months) {
    const { rows } = await h.pool.query("SELECT ($1 || '-01')::date::text AS a, (date_trunc('month', ($1 || '-01')::date) + interval '1 month' - interval '1 day')::date::text AS b", [m]);
    const exp = await exportNet(rows[0].a, rows[0].b);
    assert.equal(await reportsFor(rows[0].a, rows[0].b), exp, `reports == export in ${m}`);
  }
  // the Dashboard's "Sales today" and "Sales this month"
  const stats = await lib.dashboard.salesStats(h.pool);
  const { rows: ms } = await h.pool.query("SELECT date_trunc('month', $1::date)::date::text AS m", [today]);
  assert.equal(cents(stats.salesToday), await exportNet(today, today));
  assert.equal(cents(stats.salesThisMonth), await exportNet(ms[0].m, today));
  // and the Refunds figure on the Dashboard is what was RECEIVED, not the list price
  assert.equal(cents(stats.refundsAmountThisMonth), [...REFUNDED].filter((k) => k !== "discRefunded").reduce((a, k) => a + RECEIVED[k], 0) + RECEIVED.discRefunded, "refunds = received amounts");
  assert.equal(stats.refundsThisMonth, 3);
});

test("the Sales report shows the discount as its own column; ranges without a discount keep the old columns", async () => {
  const day = await paris(-1); // B (discount 2.56) was paid yesterday
  const run = await lib.reports.runReport(h.pool, lib.reports.getReport("sales"), { from: day, to: day, group: "day" });
  const books = run.sections.find((s) => s.key === "books");
  assert.ok(books.columns.some((c) => c.key === "discounts"));
  assert.deepEqual([books.totals.online_revenue, books.totals.discounts, books.totals.total_revenue], [15.06, -2.56, 12.5]);
  const none = await lib.reports.runReport(h.pool, lib.reports.getReport("sales"), { from: await paris(-5), to: await paris(-4), group: "day" });
  assert.equal(none.sections.find((s) => s.key === "books").columns.some((c) => c.key === "discounts"), false);
});

test("cash refund with an open till day: expected cash drops, the closing difference is 0, and nothing is exported twice", async () => {
  const day = await paris();
  const s = await lib.till.daySummary(h.pool, day);
  // float 50 + till cash sales (D: 5.00) - cash refunds (D 5.00 + F 12.00). The card refund (E) never touches the drawer.
  assert.deepEqual([s.cashRefunds.n, s.cashRefunds.total], [2, 1700]);
  assert.equal(s.cash.total, 500);
  assert.equal(s.expectedCashCents, 3800);
  const row = await order(F.adminRefunded.id);
  assert.deepEqual([row.refund_method, row.refund_day], ["card", null], "card refund: no drawer effect");
  assert.equal((await order(F.tillRefunded.id)).refund_day, day);
  const page = (await h.get(`/admin/till/day?day=${day}`)).text;
  assert.match(page, /Cash refunds paid out/);
  assert.match(page, /€38\.00/, "expected cash shown");
  // counted exactly the expected: difference 0, no over/short row
  assert.equal((await h.post("/admin/till/day/close", { day, counted: "38.00" })).status, 302);
  const dr = (await h.pool.query("SELECT * FROM till_days WHERE day = $1", [day])).rows[0];
  assert.deepEqual([dr.expected_cash_cents, dr.counted_cash_cents, dr.difference_cents], [3800, 3800, 0]);
  const rows = await lib.accounting.accountingRows(h.pool, day, day);
  assert.equal(rows.filter((x) => x.category === "Cash over/short").length, 0);
});

test("refund after the day was closed: the cash option is refused (nothing changes); Other works and has no drawer effect", async () => {
  const day = await paris();
  const netBefore = await exportNet(day, day);
  const r = await reserve([4]);
  await collectByAdmin(r, "cash");
  const before = await lib.till.daySummary(h.pool, day);
  const form = (await h.get(`/admin/orders/${r.id}/refund`)).text;
  assert.match(form, /Refunded how\?/);
  assert.match(form, /today(&#39;|')s till day is closed/);
  const refused = await h.post(`/admin/orders/${r.id}/refund`, { confirmRefunded: "on", refundMethod: "cash", note: "cash back" });
  assert.match(await refused.text(), /already closed/);
  assert.equal((await order(r.id)).status, "paid", "nothing was changed");
  await refund(r, "other");
  const o = await order(r.id);
  assert.deepEqual([o.status, o.refund_method, o.refund_day], ["refunded", "other", null]);
  const after = await lib.till.daySummary(h.pool, day);
  assert.equal(after.expectedCashCents, before.expectedCashCents);
  // the export nets that order to zero (sale + negative refund row), and the closed day's difference is untouched
  assert.equal(await exportNet(day, day), netBefore, "sale and refund net to zero");
  const missing = await h.post(`/admin/orders/${(await reserve([3])).id}/refund`, { confirmRefunded: "on", note: "no method" });
  assert.match(await missing.text(), /Choose how the money was given back/);
});

test("old refunded orders (no recorded method) behave exactly as before", async () => {
  const { makeOrder } = require("../helpers/orderFixtures");
  const { order: o } = await makeOrder(h.pool, { status: "paid" });
  const res = await lib.actions.markOrderRefunded(h.pool, o.id, { note: "legacy" });
  assert.equal(res.outcome, "refunded");
  const row = await order(o.id);
  assert.deepEqual([row.refund_method, row.refund_day], [null, null]);
  assert.equal((await lib.actions.markOrderRefunded(h.pool, o.id, { note: "x" })).outcome, "already");
  const { order: o2 } = await makeOrder(h.pool, { status: "paid" });
  assert.equal((await lib.actions.markOrderRefunded(h.pool, o2.id, { note: "x", refundMethod: "bogus" })).outcome, "method_invalid");
});
