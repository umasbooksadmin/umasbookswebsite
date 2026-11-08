// Educational items (lib/eduItems.js, migration 113): the money and stock rules, end to end on the real app and database.
//   - a reservation writes one order line per unit at the unit price; the total, the deadline (the book deadline) and
//     the hold (stock minus the units of open reservations) are right;
//   - oversell is impossible: concurrent reservations for the last units, exactly as many succeed as there is stock;
//   - a changed price is refused (PRICE_CHANGED), a hidden item too (EDU_UNAVAILABLE);
//   - cancel, expiry and a partial pickup give back / keep exactly the right units; an expiring reservation keeps a live
//     drop-in seat on its own but releases the educational items with the books;
//   - collecting (admin button, with a pickup discount, and the till) takes the units off stock, and the Accounting export
//     and the Sales report show an "Educational items" line (707) whose amounts reconcile with what was received;
//   - a refund puts the units back on stock and adds the negative "Educational items" row.
// Port 5113.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { tillHarness } = require("../helpers/tillHarness");

let h, cart, accounting, reports, actions, reservations;
before(async () => {
  h = await tillHarness({ port: 5113, ip: "10.51.13.1" });
  cart = require("../../src/lib/cart");
  accounting = require("../../src/lib/accounting");
  reports = require("../../src/lib/reports");
  actions = require("../../src/lib/orderActions");
  reservations = require("../../src/lib/reservations");
  assert.equal((await h.post("/admin/till/day/open", { openingFloat: "50" })).status, 302);
});
after(async () => { await h.stop(); });

const paris = async () => (await h.pool.query("SELECT (now() AT TIME ZONE 'Europe/Paris')::date::text AS d")).rows[0].d;
const genreId = async () => (await h.pool.query("SELECT id FROM edu_genres WHERE slug = 'worksheets'")).rows[0].id;
async function makeItem({ name = `Edu ${h.uniq()}`, price = 4.5, stock = 10 } = {}) {
  const { rows } = await h.pool.query("INSERT INTO edu_items (name, price, stock, genre_id) VALUES ($1, $2, $3, $4) RETURNING *", [name, price, stock, await genreId()]);
  return rows[0];
}
async function buyer() {
  const { rows } = await h.pool.query(
    "INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, 'x', 'Edu Buyer', now()) RETURNING id, email", [`edu-${h.uniq()}@example.test`]);
  return rows[0];
}
const eduLine = (item, qty, price = item.price) => ({ kind: "edu", eduItemId: item.id, qty, title: item.name, price: Number(price) });
async function reserve(items, user) {
  return cart.createReservation(h.pool, { user: user || await buyer(), name: "Edu Buyer", items, acceptedVersion: "v", hasDropin: false });
}
async function bookLine(price = 6) {
  const book = await h.seedBook(`Edu Book ${h.uniq()}`);
  const copy = await h.seedCopy(book.id, { price, condition: "very_good", location: "E1" });
  return { kind: "book", copyId: copy, title: "Edu Book", price };
}
async function stockOf(item) {
  const { rows } = await h.pool.query(
    `SELECT i.stock, (SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.edu_item_id = i.id AND o.status = 'reserved')::int AS held FROM edu_items i WHERE i.id = $1`, [item.id]);
  return { stock: rows[0].stock, held: rows[0].held, available: rows[0].stock - rows[0].held };
}
const lines = async (orderId) => (await h.pool.query("SELECT * FROM order_items WHERE order_id = $1 ORDER BY id", [orderId])).rows;
const exportRows = async () => { const d = await paris(); return accounting.accountingRows(h.pool, d, d); };

test("a reservation writes one line per unit at the unit price, the right total, the book deadline, and holds the units", async () => {
  const item = await makeItem({ price: 4.5, stock: 10 });
  const book = await bookLine(6);
  const order = await reserve([book, eduLine(item, 3)]);
  assert.equal(Number(order.total_amount), 19.5); // 6 + 3 x 4.50
  const l = await lines(order.id);
  assert.equal(l.filter((x) => x.edu_item_id === item.id).length, 3);
  assert.ok(l.filter((x) => x.edu_item_id === item.id).every((x) => Number(x.price) === 4.5 && x.item_title === item.name));
  assert.deepEqual(await stockOf(item), { stock: 10, held: 3, available: 7 });
  // Educational items only: still the book deadline (collected at the shop), never NULL.
  const only = await reserve([eduLine(item, 1)]);
  assert.ok(only.reserved_until, "an educational-only reservation has a deadline");
  const days = (new Date(only.reserved_until) - Date.now()) / 86400000;
  assert.ok(days > 13 && days < 16, `deadline in ${days} days`);
});

test("oversell is impossible: concurrent reservations of the last units", async () => {
  const item = await makeItem({ stock: 3 });
  const users = await Promise.all([1, 2, 3, 4, 5, 6].map(() => buyer()));
  const results = await Promise.allSettled(users.map((u) => reserve([eduLine(item, 1)], u)));
  const ok = results.filter((r) => r.status === "fulfilled").length;
  assert.equal(ok, 3, results.map((r) => r.reason && r.reason.message).join(","));
  for (const r of results.filter((x) => x.status === "rejected")) assert.equal(r.reason.message, "SOLD_OUT");
  assert.deepEqual(await stockOf(item), { stock: 3, held: 3, available: 0 });

  const two = await makeItem({ stock: 2 });
  const [a, b] = await Promise.allSettled([reserve([eduLine(two, 2)]), reserve([eduLine(two, 2)])]);
  assert.equal([a, b].filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await stockOf(two)).held, 2);
  // Asking for more than is left reserves nothing at all (no partial hold).
  const three = await makeItem({ stock: 2 });
  const book = await bookLine();
  await assert.rejects(reserve([book, eduLine(three, 3)]), /SOLD_OUT/);
  assert.equal((await stockOf(three)).held, 0);
  assert.equal((await h.copy(book.copyId)).status, "in_stock", "the book of the refused reservation was not held");
});

test("a changed price is refused, a hidden item is refused", async () => {
  const item = await makeItem({ price: 5 });
  await assert.rejects(reserve([eduLine(item, 1, 4)]), (e) => e.message === "PRICE_CHANGED" && e.changes[0].kind === "edu" && e.changes[0].newPrice === 5);
  await h.pool.query("UPDATE edu_items SET is_hidden = true WHERE id = $1", [item.id]);
  await assert.rejects(reserve([eduLine(item, 1)]), (e) => e.message === "EDU_UNAVAILABLE" && e.titles[0] === item.name);
});

test("cancel and expiry give the units back; stock is unchanged; a live seat is kept on its own", async () => {
  const item = await makeItem({ stock: 5 });
  const o1 = await reserve([eduLine(item, 2)]);
  assert.equal((await stockOf(item)).available, 3);
  assert.equal((await actions.cancelReservationByAdmin(h.pool, o1.id)).outcome, "released");
  assert.deepEqual(await stockOf(item), { stock: 5, held: 0, available: 5 });

  const classId = (await h.pool.query("INSERT INTO classes (title, starts_at, capacity, dropin_price) VALUES ('Edu Class', now() + interval '20 days', 5, 7) RETURNING id")).rows[0].id;
  const o2 = await reserve([eduLine(item, 2), { kind: "dropin", classId, title: "Edu Class", startsAt: new Date(Date.now() + 20 * 86400000), price: 7 }]);
  assert.equal((await stockOf(item)).held, 2);
  await h.pool.query("UPDATE orders SET reserved_until = now() - interval '1 minute' WHERE id = $1", [o2.id]);
  await reservations.expireOrderReservations(h.pool);
  assert.equal((await h.pool.query("SELECT status FROM orders WHERE id = $1", [o2.id])).rows[0].status, "expired");
  assert.deepEqual(await stockOf(item), { stock: 5, held: 0, available: 5 });
  const kept = (await h.pool.query("SELECT id, status, total_amount FROM orders WHERE split_from_order_id = $1", [o2.id])).rows;
  assert.equal(kept.length, 1);
  assert.equal(kept[0].status, "reserved");
  assert.equal(Number(kept[0].total_amount), 7, "the seat goes on alone");
  const keptLines = await lines(kept[0].id);
  assert.ok(keptLines.every((l) => l.edu_item_id == null));

  // Customer cancel and extension: an educational-only reservation can be extended once.
  const o3 = await reserve([eduLine(item, 1)]);
  assert.equal((await reservations.extendReservation(h.pool, o3.id)).outcome, "extended");
});

test("collect with a pickup discount: stock goes down, accounting and the Sales report reconcile to what was received", async () => {
  const item = await makeItem({ price: 3, stock: 8 });
  const book = await bookLine(10);
  const classId = (await h.pool.query("INSERT INTO classes (title, starts_at, capacity, dropin_price) VALUES ('Edu Disc Class', now() + interval '6 days', 5, 7) RETURNING id")).rows[0].id;
  // 10 (book) + 3 x 3 (edu) + 7 (seat) = 26.00 list; received 20.00 (6.00 off, with a note).
  const order = await reserve([book, eduLine(item, 3), { kind: "dropin", classId, title: "Edu Disc Class", startsAt: new Date(Date.now() + 6 * 86400000), price: 7 }]);
  assert.equal(Number(order.total_amount), 26);
  const before = await exportRows();
  const res = await h.post(`/admin/orders/${order.id}/collect`, { method: "card", amountReceived: "20", note: "loyalty" });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location") || "", /collected-paid/);
  assert.deepEqual(await stockOf(item), { stock: 5, held: 0, available: 5 });

  const after = await exportRows();
  const sum = (rows, cat, method) => rows.filter((r) => r.category === cat && r.method === method).reduce((a, r) => a + r.cents, 0);
  assert.equal(sum(after, "Educational items", "Card at the till") - sum(before, "Educational items", "Card at the till"), 900);
  assert.equal(sum(after, "Discount", "Card at the till") - sum(before, "Discount", "Card at the till"), -600);
  const all = (rows) => rows.filter((r) => r.method === "Card at the till").reduce((a, r) => a + r.cents, 0);
  assert.equal(all(after) - all(before), 2000, "the export of the reservation is exactly what was received");
  const mapping = accounting.defaultMapping("Educational items", "Card at the till");
  assert.equal(mapping.credit, "707");

  // Sales report: the discount is shared books / educational items / seats in proportion (10 : 9 : 7 of 26), cumulative
  // rounding, and the three tables add up to what was received.
  const d = await paris();
  const rep = await reports.REPORTS.find((r) => r.slug === "sales").run(h.pool, { from: d, to: d, group: "day" });
  const sec = (k) => rep.sections.find((s) => s.key === k);
  const edu = sec("educational");
  assert.ok(edu, "the Sales report has an Educational items table");
  assert.equal(edu.totals.items, 3);
  assert.equal(edu.totals.revenue, 9);
  // book share round(600*10/26)=231, edu share round(600*19/26)-231 = 438-231 = 207, seat share 600-438 = 162
  assert.equal(edu.totals.discounts, -2.07);
  assert.equal(edu.totals.total_revenue, 6.93);
  const seats = sec("dropin");
  assert.equal(seats.totals.discounts, -1.62);
  const books = sec("books");
  assert.equal(books.totals.discounts, -2.31);
  const received = books.totals.online_revenue + books.totals.discounts + edu.totals.total_revenue + seats.totals.total_revenue;
  assert.equal(Math.round(received * 100), 2000);
});

test("partial pickup: only the collected units come off stock, the rest stays held on the new reservation", async () => {
  const item = await makeItem({ price: 2, stock: 6 });
  const order = await reserve([eduLine(item, 3)]);
  const l = await lines(order.id);
  const r = await actions.collectReservation(h.pool, order.id, { method: "cash", itemIds: [l[0].id], adminUserId: h.adminId });
  assert.equal(r.outcome, "collected");
  assert.equal(r.partial, true);
  assert.equal(r.total, 2);
  assert.deepEqual(await stockOf(item), { stock: 5, held: 2, available: 3 });
  const rest = await lines(r.newOrderId);
  assert.equal(rest.length, 2);
  const newOrder = (await h.pool.query("SELECT * FROM orders WHERE id = $1", [r.newOrderId])).rows[0];
  assert.equal(Number(newOrder.total_amount), 4);
  assert.ok(newOrder.reserved_until);
});

test("the till collects ORDER-<n>: 'educational' lines, Educational items in the export, stock down; a refund restocks", async () => {
  const item = await makeItem({ price: 5.5, stock: 4 });
  const order = await reserve([eduLine(item, 2)]);
  const scan = await h.scan(`ORDER-${order.id}`);
  assert.equal(scan.body.type, "reservation");
  assert.equal(scan.body.lines.length, 2);
  assert.ok(scan.body.lines.every((x) => x.edu === true && x.priceCents === 550));
  const before = await exportRows();
  const sale = await h.sale(scan.body.lines.map((x) => ({ kind: "reserved", orderId: x.orderId, itemId: x.itemId, expected: x.priceCents })), { method: "cash", received: "20" });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const cats = (await h.pool.query("SELECT category, quantity, unit_price_cents FROM till_sale_items WHERE sale_id = $1", [sale.body.saleId])).rows;
  assert.deepEqual(cats.map((c) => c.category), ["educational", "educational"]);
  assert.deepEqual(await stockOf(item), { stock: 2, held: 0, available: 2 });
  assert.equal((await h.pool.query("SELECT status FROM orders WHERE id = $1", [order.id])).rows[0].status, "paid");
  const after = await exportRows();
  const cash = (rows, cat) => rows.filter((r) => r.category === cat && r.method === "Cash" && !r.refund).reduce((a, r) => a + r.cents, 0);
  assert.equal(cash(after, "Educational items") - cash(before, "Educational items"), 1100);
  // Counted once: the order is not also an order row.
  assert.equal(after.reduce((a, r) => a + r.cents, 0) - before.reduce((a, r) => a + r.cents, 0), 1100);

  const ref = await actions.markOrderRefunded(h.pool, order.id, { note: "changed mind", refundMethod: "card" });
  assert.equal(ref.outcome, "refunded");
  assert.equal(ref.eduRestocked, 2);
  assert.deepEqual(await stockOf(item), { stock: 4, held: 0, available: 4 });
  const afterRefund = await exportRows();
  const refundRow = afterRefund.filter((r) => r.category === "Educational items" && r.refund && r.method === "Card at the till").reduce((a, r) => a + r.cents, 0);
  assert.equal(refundRow, -1100);
});

test("admin: stock cannot go below what is held; an item on orders cannot be deleted; changes are audited", async () => {
  const item = await makeItem({ price: 4, stock: 5 });
  await reserve([eduLine(item, 3)]);
  const form = { name: item.name, price: "4.00", stock: "2", genre: "Worksheets", sortOrder: "0" };
  let res = await h.post(`/admin/edu-items/${item.id}`, form);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /cannot be lower than 3/);
  assert.equal((await stockOf(item)).stock, 5, "refused: 3 are held");
  await h.post(`/admin/edu-items/${item.id}`, { ...form, stock: "9" });
  assert.equal((await stockOf(item)).stock, 9);
  const edits = await h.audit("edu_item.edit");
  assert.match(edits[edits.length - 1].detail, /stock 5 -> 9/);
  res = await h.post(`/admin/edu-items/${item.id}/delete`, {});
  assert.match(await res.text(), /Hide it instead/);
  assert.ok((await h.pool.query("SELECT 1 FROM edu_items WHERE id = $1", [item.id])).rows.length, "not deleted: it is on an order");
  const free = await makeItem();
  await h.post(`/admin/edu-items/${free.id}/delete`, {});
  assert.equal((await h.pool.query("SELECT 1 FROM edu_items WHERE id = $1", [free.id])).rows.length, 0);
  assert.equal((await h.audit("edu_item.delete")).length, 1);
  // The database itself refuses to delete an item that is on an order.
  await assert.rejects(h.pool.query("DELETE FROM edu_items WHERE id = $1", [item.id]), /foreign key/);
});
