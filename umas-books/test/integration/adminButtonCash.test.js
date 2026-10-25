// PR C3: cash taken through the admin "Mark collected and paid" button (a back-up: the normal routine is the till)
// must be part of that till day's EXPECTED CASH, so a slip does not make the drawer look "over". Real app, real
// database, the real routes. Orders collected at the till already have a till sale and are never counted twice.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { tillHarness } = require("../helpers/tillHarness");
const { makeOrder } = require("../helpers/orderFixtures");

let h;
let cart;
let till;
let acc;
let ax;
before(async () => {
  h = await tillHarness({ port: 4895, ip: "10.95.1.1" });
  cart = require("../../src/lib/cart");
  till = require("../../src/lib/till");
  acc = require("../../src/lib/accounting");
  ax = require("../../src/lib/accountingExport");
});
after(async () => { await h.stop(); });

const today = async () => (await h.pool.query("SELECT (now() AT TIME ZONE 'Europe/Paris')::date::text AS d")).rows[0].d;
const summary = async () => till.daySummary(h.pool, await today());

async function reserve(prices) {
  const { rows: u } = await h.pool.query(
    "INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, 'x', 'Admin Cash Buyer', now()) RETURNING id, email", [`abc-${h.uniq()}@example.test`]);
  const items = [];
  for (const price of prices) {
    const book = await h.seedBook(`ABC ${h.uniq()}`);
    const copy = await h.seedCopy(book.id, { price, location: "R9" });
    items.push({ kind: "book", copyId: copy, title: `ABC ${copy}`, price });
  }
  const order = await cart.createReservation(h.pool, { user: u[0], name: "Admin Cash Buyer", items, acceptedVersion: "v", hasDropin: false });
  const lines = (await h.pool.query("SELECT id FROM order_items WHERE order_id = $1 ORDER BY id", [order.id])).rows.map((r) => r.id);
  return { id: order.id, lines };
}
async function collectByAdmin(r, method, amountReceived, note = "") {
  const res = await h.post(`/admin/orders/${r.id}/collect`, { method, amountReceived: amountReceived === undefined ? "" : String(amountReceived), note });
  return res; // 302 + Location on success; a refusal is a 303 the harness follows: a 200 page carrying the message
}
const collected = (res) => res.status === 302 && /collected-paid/.test(res.headers.get("location") || "");
async function collectAtTill(r, method) {
  const res = await h.sale(r.lines.map((id) => ({ kind: "reserved", orderId: r.id, itemId: id })), { method, received: "100" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}
async function refund(r, refundMethod) {
  const res = await h.post(`/admin/orders/${r.id}/refund`, { confirmRefunded: "on", refundMethod, note: "gave the money back" });
  assert.match(res.headers.get("location") || "", /notice=refunded/);
}
const snap = (s) => [s.cash.total, s.adminCash.n, s.adminCash.total, s.cashRefunds.total, s.expectedCashCents];

test("admin-button cash with a discount joins the expected cash; the closing difference is 0", async () => {
  assert.equal((await h.post("/admin/till/day/open", { openingFloat: "50" })).status, 302);
  const r = await reserve([7]); // list 7.00
  assert.ok(collected(await collectByAdmin(r, "cash", "6.00", "regular customer")));
  const s = await summary();
  assert.deepEqual(snap(s), [0, 1, 600, 0, 5600], "float 50 + admin cash 6.00 (the DISCOUNTED amount received)");
  const page = (await h.get(`/admin/till/day?day=${await today()}`)).text;
  assert.match(page, /Cash taken via admin \(Mark collected and paid\)/);
  assert.match(page, /€56\.00/);
});

test("collected at the till: counted once (as a till sale), not again as admin cash; admin card/cheque never touch the drawer", async () => {
  const before = await summary();
  const t = await reserve([5]);
  await collectAtTill(t, "cash");
  const o = (await h.pool.query("SELECT payment_method, amount_received, collected_at FROM orders WHERE id = $1", [t.id])).rows[0];
  assert.equal(o.payment_method, "cash");
  assert.ok(o.amount_received != null && o.collected_at, "the till also records these fields on the order: the till link is what excludes it");
  const s = await summary();
  assert.equal(s.cash.total, before.cash.total + 500, "counted once, as a till cash sale");
  assert.equal(s.adminCash.n, before.adminCash.n, "not counted again as admin cash");
  assert.equal(s.expectedCashCents, before.expectedCashCents + 500);

  const card = await reserve([8]);
  await collectByAdmin(card, "card");
  const cheque = await reserve([9]);
  await collectByAdmin(cheque, "cheque");
  assert.deepEqual(snap(await summary()), snap(s), "admin card and cheque: no drawer effect");
});

test("refunding an admin-button cash order from the drawer nets to zero", async () => {
  const before = await summary();
  const r = await reserve([4]);
  await collectByAdmin(r, "cash");
  assert.equal((await summary()).expectedCashCents, before.expectedCashCents + 400);
  await refund(r, "cash");
  const s = await summary();
  assert.equal(s.expectedCashCents, before.expectedCashCents, "cash in 4.00, cash refund out 4.00");
  assert.deepEqual([s.adminCash.n, s.adminCash.total, s.cashRefunds.total], [before.adminCash.n + 1, before.adminCash.total + 400, before.cashRefunds.total + 400]);
});

test("legacy rows (no amount received, no cash method, online orders) behave exactly as before", async () => {
  const before = await summary();
  // a pre-#329 cash pickup: payment_method set, amount_received NULL
  const { order: legacy } = await makeOrder(h.pool, { status: "paid", collected: true });
  await h.pool.query("UPDATE orders SET payment_method = 'cash', amount_received = NULL, paid_at = now() WHERE id = $1", [legacy.id]);
  // an old online (HelloAsso) order, paid today
  const { order: online } = await makeOrder(h.pool, { status: "paid" });
  await h.pool.query("UPDATE orders SET payment_method = 'helloasso', amount_received = NULL, paid_at = now() WHERE id = $1", [online.id]);
  // a cash order that was never collected through the button (collected_at NULL)
  const { order: odd } = await makeOrder(h.pool, { status: "paid" });
  await h.pool.query("UPDATE orders SET payment_method = 'cash', amount_received = 3, paid_at = now(), collected_at = NULL WHERE id = $1", [odd.id]);
  assert.deepEqual(snap(await summary()), snap(before));
  await h.pool.query("UPDATE orders SET status = 'cancelled' WHERE id = ANY($1)", [[legacy.id, online.id, odd.id]]); // keep the fixtures out of the export checks below
});

test("the day is the Paris day of the payment: 23:59 belongs to that day, 00:00 to the next (summer and winter)", async () => {
  for (const [late, early, dayA, dayB] of [
    ["2026-01-15 23:59:30", "2026-01-16 00:00:30", "2026-01-15", "2026-01-16"],
    ["2026-07-15 23:59:30", "2026-07-16 00:00:30", "2026-07-15", "2026-07-16"],
  ]) {
    for (const [at, amount] of [[late, 3], [early, 4]]) {
      const { order } = await makeOrder(h.pool, { status: "paid", collected: true, });
      // makeOrder takes an instant: convert the Paris wall time to it in SQL, then set the cash fields
      await h.pool.query(
        `UPDATE orders SET payment_method = 'cash', amount_received = $2, paid_at = ($3::timestamp AT TIME ZONE 'Europe/Paris'), collected_at = ($3::timestamp AT TIME ZONE 'Europe/Paris') WHERE id = $1`,
        [order.id, amount, at]);
    }
    const a = await till.daySummary(h.pool, dayA);
    const b = await till.daySummary(h.pool, dayB);
    assert.deepEqual([a.adminCash.n, a.adminCash.total], [1, 300], `${dayA}: only the 23:59 payment`);
    assert.deepEqual([b.adminCash.n, b.adminCash.total], [1, 400], `${dayB}: only the 00:00 payment`);
    assert.equal(a.expectedCashCents, 300, "no till day row: float counts as 0");
  }
});

test("close the day: counted = float + till cash + admin cash - cash refunds gives difference 0; the accounting export is unchanged and has no Cash over/short row", async () => {
  const day = await today();
  const s = await summary();
  const netBefore = (await acc.accountingRows(h.pool, day, day)).reduce((a, r) => a + r.cents, 0);
  // float 50 + till cash 5.00 + admin cash (6.00 + 4.00) - refund 4.00 = 61.00
  assert.equal(s.expectedCashCents, 6100);
  assert.equal((await h.post("/admin/till/day/close", { day, counted: "61.00" })).status, 302);
  const dr = (await h.pool.query("SELECT * FROM till_days WHERE day = $1", [day])).rows[0];
  assert.deepEqual([dr.expected_cash_cents, dr.counted_cash_cents, dr.difference_cents], [6100, 6100, 0]);
  const rows = await acc.accountingRows(h.pool, day, day);
  assert.equal(rows.filter((x) => x.category === "Cash over/short").length, 0);
  assert.equal(rows.reduce((a, r) => a + r.cents, 0), netBefore, "the export is unchanged by the close and counts the revenue once");
  // revenue counted once: Cash = admin 6.00 (7.00 list less the 1.00 discount row) + admin 4.00 - its refund 4.00 + till 5.00
  const byMethod = (m) => rows.filter((x) => x.method === m).reduce((a, x) => a + x.cents, 0);
  assert.equal(byMethod("Cash"), 600 + 400 - 400 + 500, "each cash order once in the export, whether collected by the button or at the till");
  assert.equal(byMethod("Card at the till") + byMethod("Cheque"), 800 + 900);
  // the till days CSV: the new column is LAST, earlier columns keep their order
  const csv = (await ax.buildExport(h.pool, { from: day, to: day, kind: "month", label: day })).tillCsv.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = csv[0].split(";").map((c) => c.replace(/"/g, ""));
  assert.equal(header[header.length - 1], "Admin-button cash (EUR)");
  assert.equal(header[header.length - 2], "Cash refunds paid out (EUR)");
  assert.equal(header.slice(0, 5).join("|"), "Date|Opening float (EUR)|Cash counted (EUR)|Expected cash (EUR)|Difference (EUR)");
  const todayRow = csv.find((l) => l.includes(day)).split(";");
  assert.equal(todayRow[todayRow.length - 1].replace(/"/g, ""), "10,00", "admin-button cash 6.00 + 4.00 (the refunded one is still cash that came in)");
});

test("after the day is closed the admin button refuses cash (nothing changes) and offers Other; reopening allows it again", async () => {
  const day = await today();
  const r = await reserve([6]);
  const page = (await h.get(`/admin/orders/${r.id}`)).text;
  assert.match(page, /already closed, so Cash is not offered/);
  assert.match(page, /<option value="cash"[^>]*disabled/);
  const refused = await collectByAdmin(r, "cash");
  assert.equal(refused.status, 200);
  assert.match(await refused.text(), /already closed/);
  assert.equal((await h.pool.query("SELECT status FROM orders WHERE id = $1", [r.id])).rows[0].status, "reserved", "nothing was changed");
  assert.equal((await h.pool.query("SELECT status FROM book_copies WHERE id = (SELECT book_copy_id FROM order_items WHERE order_id = $1)", [r.id])).rows[0].status, "reserved");
  const before = await summary();
  assert.ok(collected(await collectByAdmin(r, "other")), "Other still works and has no drawer effect");
  assert.deepEqual(snap(await summary()), snap(before));
  // reopen: cash is accepted again and counts
  assert.equal((await h.post("/admin/till/day/reopen", { day, reason: "test reopen" })).status, 302);
  const r2 = await reserve([2]);
  assert.ok(collected(await collectByAdmin(r2, "cash")));
  assert.equal((await summary()).expectedCashCents, 6100 + 200);
});
