// Sales report (Admin > Reports > Sales over time), two money rules (5th review, findings D1 and D2):
//  D1: a pickup discount on a reservation that holds drop-in seats is shared between the books and the
//      seats in proportion to their list prices, so each table adds up to what was really received (a
//      seats-only reservation no longer makes the BOOK table go negative).
//  D2: a reservation collected at the Till is counted on the day of the Till sale, even when the sale was
//      entered later with an earlier time (backdated), like the Accounting export does.
// Real app, real database, the real routes for collecting.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { tillHarness } = require("../helpers/tillHarness");

let h;
let cart;
let reports;
before(async () => {
  h = await tillHarness({ port: 4912, ip: "10.88.1.1" });
  cart = require("../../src/lib/cart");
  reports = require("../../src/lib/reports");
});
after(async () => { await h.stop(); });

const paris = async (offsetDays = 0) => (await h.pool.query("SELECT ((now() AT TIME ZONE 'Europe/Paris')::date + $1::int)::text AS d", [offsetDays])).rows[0].d;

// A real reservation: books at the given prices and/or one drop-in seat.
async function reserve({ prices = [], seat = null }) {
  const { rows: u } = await h.pool.query(
    "INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, 'x', 'Sales Buyer', now()) RETURNING id, email", [`sales-${h.uniq()}@example.test`]);
  const items = [];
  for (const price of prices) {
    const book = await h.seedBook(`Sales ${h.uniq()}`);
    const copy = await h.seedCopy(book.id, { price, location: "S1" });
    items.push({ kind: "book", copyId: copy, title: `Sales ${copy}`, price });
  }
  if (seat) {
    const classId = (await h.pool.query("INSERT INTO classes (title, starts_at, capacity, dropin_price) VALUES ($1, now() + interval '5 days', 4, $2) RETURNING id", [`Sales Seat ${h.uniq()}`, seat])).rows[0].id;
    items.push({ kind: "dropin", classId, title: "Sales Seat", startsAt: new Date(Date.now() + 5 * 86400000), price: seat });
  }
  const order = await cart.createReservation(h.pool, { user: u[0], name: "Sales Buyer", items, acceptedVersion: "v", hasDropin: false });
  const lines = (await h.pool.query("SELECT id FROM order_items WHERE order_id = $1 ORDER BY id", [order.id])).rows.map((r) => r.id);
  return { id: order.id, lines };
}
async function collectByAdmin(r, amountReceived) {
  const res = await h.post(`/admin/orders/${r.id}/collect`, { method: "cash", amountReceived: String(amountReceived), note: "pickup deal" });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location") || "", /collected-paid/, `collect refused: ${res.headers.get("location")}`);
}
async function sales(from, to) {
  const out = await reports.runReport(h.pool, reports.getReport("sales"), { from, to, group: "day" });
  const sec = (key) => out.sections.find((s) => s.key === key);
  return { books: sec("books"), dropin: sec("dropin") };
}

test("D1: a pickup discount is shared between books and drop-in seats by list price; a seats-only discount stays off the book table", async () => {
  const today = await paris();
  assert.equal((await h.post("/admin/till/day/open", { openingFloat: "50" })).status, 302); // cash collected by the admin button needs an open till day
  // seats only: list 10, received 7 -> the 3 discount belongs to the seat
  const seatsOnly = await reserve({ seat: 10 });
  await collectByAdmin(seatsOnly, 7);
  let { books, dropin } = await sales(today, today);
  assert.equal(books.rows.length, 0, "no book was sold, so the book table has no row (it used to show a -3.00 discount)");
  assert.deepEqual(books.columns.map((c) => c.key).filter((k) => k === "discounts"), [], "no pickup discount column on the book table");
  assert.deepEqual(dropin.rows.map((r) => [r.seats, r.revenue, r.discounts, r.total_revenue]), [[1, 10, -3, 7]]);

  // books and a seat: book 12 + seat 8 = list 20, received 15 -> discount 5 = 3 on the book, 2 on the seat
  const mixed = await reserve({ prices: [12], seat: 8 });
  await collectByAdmin(mixed, 15);
  ({ books, dropin } = await sales(today, today));
  assert.deepEqual([books.rows[0].online_revenue, books.rows[0].discounts, books.rows[0].total_revenue], [12, -3, 9]);
  assert.deepEqual(dropin.rows.map((r) => [r.seats, r.revenue, r.discounts, r.total_revenue]), [[2, 18, -5, 13]]);
  // what was really received: 7 + 15 = 22 = 9 (books) + 13 (seats)
  assert.equal(books.totals.total_revenue + dropin.totals.total_revenue, 22);

  // odd cents never lose a cent: book 0.05 + seat 0.10, received 0.10 -> discount 0.05, shared 1 and 4 cents
  const odd = await reserve({ prices: [0.05], seat: 0.1 });
  await collectByAdmin(odd, "0.10");
  ({ books, dropin } = await sales(today, today));
  assert.equal(Math.round((books.totals.total_revenue + dropin.totals.total_revenue) * 100), 2200 + 10);
});

test("D2: a reservation collected at the Till on a backdated sale is counted on the Till sale's day, not the day it was typed in", async () => {
  const today = await paris();
  const yesterday = await paris(-1);
  const r = await reserve({ prices: [9], seat: 6 });
  const before = { t: await sales(today, today), y: await sales(yesterday, yesterday) };
  const sale = await h.sale(r.lines.map((id) => ({ kind: "reserved", orderId: r.id, itemId: id })), {
    method: "cash", received: "100", soldAtTime: "10:15", soldAtDay: "yesterday", backdateReason: "internet was down",
  });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  // the order itself was paid "now" (today)...
  assert.equal((await h.pool.query("SELECT (paid_at AT TIME ZONE 'Europe/Paris')::date::text AS d FROM orders WHERE id = $1", [r.id])).rows[0].d, today);
  const after = { t: await sales(today, today), y: await sales(yesterday, yesterday) };
  const items = (s) => (s.books.rows[0] ? s.books.rows[0].online_items : 0);
  const seats = (s) => (s.dropin.rows[0] ? s.dropin.rows[0].seats : 0);
  // ...but the Sales report follows the Till sale: yesterday gained the book and the seat, today gained nothing
  assert.equal(items(after.y) - items(before.y), 1);
  assert.equal(seats(after.y) - seats(before.y), 1);
  assert.equal(items(after.t) - items(before.t), 0);
  assert.equal(seats(after.t) - seats(before.t), 0);
  // the same day as the Accounting export
  const acc = await require("../../src/lib/accounting").accountingRows(h.pool, yesterday, yesterday);
  for (const category of ["Books used", "Class seats"]) assert.ok(acc.some((x) => x.category === category && String(x.date).slice(0, 10) === yesterday), `the export has the ${category} line on ${yesterday}`);
});
