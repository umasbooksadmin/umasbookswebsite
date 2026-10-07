// Idempotency of the staff actions on a reservation (src/lib/orderActions.js,
// src/lib/reservations.js): the realistic shapes are a double click, two
// browser tabs, or the expiry sweep racing an admin. Each action runs in ONE
// transaction with the order row locked first, so a second (or concurrent)
// call must change nothing more: no second payment record, no moved deadline,
// no copy taken back from someone who reserved it afterwards.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { prepareDatabase } = require("../helpers/testDatabase");
const { makeOrder } = require("../helpers/orderFixtures");

// Own database even on the shared CI one (see helpers/testDatabase.js).
const db = prepareDatabase("idempotency", { isolated: true });

const { pool } = require("../../src/db");
const { collectReservation, cancelReservationByAdmin, markReservationNoShow, extendReservation, markOrderRefunded } = require("../../src/lib/orderActions");

before(() => { db.create(); });
after(async () => { await pool.end(); db.drop(); });

const orderRow = async (id) => (await pool.query("SELECT * FROM orders WHERE id = $1", [id])).rows[0];
const copy = async (id) => (await pool.query("SELECT status, cart_order_id FROM book_copies WHERE id = $1", [id])).rows[0];
const admin = async () => {
  const { rows } = await pool.query("INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ($1, 'x', 'Idem Admin', TRUE) RETURNING id", [`idem-${Date.now()}-${Math.random()}@example.test`]);
  return rows[0].id;
};

test("a second 'mark collected and paid' changes nothing: same paid_at, same amount, books stay sold", async () => {
  const adminUserId = await admin();
  const { order, copyIds } = await makeOrder(pool, { status: "reserved", books: 2 });
  const first = await collectReservation(pool, order.id, { adminUserId, method: "cash" });
  assert.equal(first.outcome, "collected");
  const afterFirst = await orderRow(order.id);
  assert.equal(afterFirst.status, "paid");

  const second = await collectReservation(pool, order.id, { adminUserId, method: "card", amountReceived: "1", note: "double click" });
  assert.equal(second.outcome, "not_reserved");
  const afterSecond = await orderRow(order.id);
  assert.equal(afterSecond.paid_at.getTime(), afterFirst.paid_at.getTime());
  assert.equal(afterSecond.payment_method, "cash");
  assert.equal(Number(afterSecond.total_amount), Number(afterFirst.total_amount));
  assert.equal(afterSecond.payment_note, null);
  for (const id of copyIds) assert.equal((await copy(id)).status, "sold");
});

test("two truly concurrent 'mark collected and paid' calls: exactly one wins", async () => {
  const adminUserId = await admin();
  const { order, copyIds } = await makeOrder(pool, { status: "reserved", books: 2 });
  // Hold the order row so BOTH calls are in flight before either can proceed:
  // only the row lock inside collectReservation keeps them from both winning.
  const holder = await pool.connect();
  await holder.query("BEGIN");
  await holder.query("SELECT 1 FROM orders WHERE id = $1 FOR UPDATE", [order.id]);
  const calls = [
    collectReservation(pool, order.id, { adminUserId, method: "cash" }),
    collectReservation(pool, order.id, { adminUserId, method: "cheque" }),
  ];
  await new Promise((r) => setTimeout(r, 200));
  await holder.query("COMMIT");
  holder.release();
  const results = await Promise.all(calls);
  assert.deepEqual(results.map((r) => r.outcome).sort(), ["collected", "not_reserved"]);
  const row = await orderRow(order.id);
  assert.equal(row.status, "paid");
  assert.ok(["cash", "cheque"].includes(row.payment_method));
  assert.equal(Number((await pool.query("SELECT count(*) FROM orders WHERE split_from_order_id = $1", [order.id])).rows[0].count), 0);
  for (const id of copyIds) assert.equal((await copy(id)).status, "sold");
});

test("cancelling twice (or cancelling then marking no-show) releases once and never touches a book that was reserved again", async () => {
  const { order, copyIds } = await makeOrder(pool, { status: "reserved" });
  assert.equal((await cancelReservationByAdmin(pool, order.id)).outcome, "released");
  const released = await orderRow(order.id);
  assert.equal(released.status, "cancelled");
  assert.deepEqual(await copy(copyIds[0]), { status: "in_stock", cart_order_id: null });

  // Someone else reserves the same copy meanwhile.
  const other = await makeOrder(pool, { status: "reserved", books: 0 });
  await pool.query("UPDATE book_copies SET status = 'reserved', cart_order_id = $2, reserved_by_email = 'next@example.test' WHERE id = $1", [copyIds[0], other.order.id]);

  assert.equal((await cancelReservationByAdmin(pool, order.id)).outcome, "not_reserved");
  assert.equal((await markReservationNoShow(pool, order.id)).outcome, "not_reserved");
  const again = await orderRow(order.id);
  assert.equal(again.status, "cancelled", "not re-labelled as expired");
  assert.equal(again.released_at.getTime(), released.released_at.getTime());
  assert.deepEqual(await copy(copyIds[0]), { status: "reserved", cart_order_id: other.order.id }, "the new holder keeps the book");
});

test("a second 'extend by 7 days' is refused and the deadline does not move again", async () => {
  const { order } = await makeOrder(pool, { status: "reserved", reservedDays: 2 });
  const first = await extendReservation(pool, order.id);
  assert.equal(first.outcome, "extended");
  const afterFirst = await orderRow(order.id);
  const second = await extendReservation(pool, order.id);
  assert.equal(second.outcome, "already_extended");
  const afterSecond = await orderRow(order.id);
  assert.equal(afterSecond.reserved_until.getTime(), afterFirst.reserved_until.getTime());
  assert.equal(afterSecond.reservation_extended_at.getTime(), afterFirst.reservation_extended_at.getTime());
});

test("a second 'mark refunded' changes nothing: the refund time and note stay, a book sold again is not taken back", async () => {
  const { order, copyIds } = await makeOrder(pool, { status: "paid", paidDaysAgo: 1 });
  assert.equal((await markOrderRefunded(pool, order.id, { note: "Gave back cash" })).outcome, "refunded");
  const afterFirst = await orderRow(order.id);
  assert.equal((await copy(copyIds[0])).status, "in_stock");
  await pool.query("UPDATE book_copies SET status = 'sold' WHERE id = $1", [copyIds[0]]); // sold again in the shop
  assert.equal((await markOrderRefunded(pool, order.id, { note: "again" })).outcome, "already");
  const afterSecond = await orderRow(order.id);
  assert.equal(afterSecond.refunded_at.getTime(), afterFirst.refunded_at.getTime());
  assert.equal(afterSecond.refund_note, "Gave back cash");
  assert.equal((await copy(copyIds[0])).status, "sold");
});
