// Regression: releasing an order that holds a drop-in seat used to DELETE the
// class_dropin_seats row, but order_items.class_dropin_seat_id references it with
// no ON DELETE action (migrations/015) and the order always has that item, so the
// release threw a foreign-key error, rolled back, and left the order, its books
// and the seat counted against the session's capacity. Seats are marked
// 'released' (kept, uncounted) instead of deleted.
//
// Two generations of holds are covered:
//  - RESERVATIONS (status 'reserved', the current model): releaseReservation,
//    the deadline sweep and the "session is over" sweep (lib/reservations.js);
//  - the LEFTOVERS of the old online checkout ('pending' order, 'in_cart' rows):
//    releaseCartHold / expireStaleCartHolds (lib/cart.js), which still clean up
//    any that were open when the change went live.
// (The old "a late payment for a released seat is a conflict" test was deleted:
// there is no payment lookup to reconcile any more.)

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { reserveHarness } = require("../helpers/reserveHarness");

// Own database even on the shared CI one; real routes build the reservations.
const h = reserveHarness("seatrelease");
const { pool } = h;
const { releaseCartHold, expireStaleCartHolds } = require("../../src/lib/cart");
const { releaseReservation, expireStaleReservations, releaseEndedSeats } = require("../../src/lib/reservations");
const { seatsTakenExpr } = require("../../src/lib/classCapacity");

before(() => h.start());
after(() => h.stop());

// A LEGACY order exactly as the old checkout built it: a seat row plus the order_items
// row pointing at it, optionally with a book copy held too.
async function insertDropinOrder({ withBook = false, ageMinutes = 0 } = {}) {
  const { rows: o } = await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, total_amount, status, checkout_intent_id)
     VALUES ('Seat Buyer', 'seats@example.test', 20.00, 'pending', $1) RETURNING *`,
    [`intent-${Date.now()}-${Math.random()}`]
  );
  const order = o[0];
  const { rows: c } = await pool.query(
    "INSERT INTO classes (title, starts_at, capacity, dropin_price) VALUES ('Drop-in', now() + interval '2 days', 3, 20.00) RETURNING id"
  );
  const classId = c[0].id;
  const { rows: s } = await pool.query(
    `INSERT INTO class_dropin_seats (class_id, status, order_id, cart_added_at)
     VALUES ($1, 'in_cart', $2, now() - make_interval(mins => $3)) RETURNING id`,
    [classId, order.id, ageMinutes]
  );
  await pool.query(
    "INSERT INTO order_items (order_id, class_dropin_seat_id, item_title, price) VALUES ($1, $2, 'Drop-in seat', 20.00)",
    [order.id, s[0].id]
  );
  let copyId = null;
  if (withBook) {
    const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ('Seat Book', 'A') RETURNING id");
    const { rows: copy } = await pool.query(
      `INSERT INTO book_copies (book_id, status, cart_order_id, cart_added_at, price)
       VALUES ($1, 'in_cart', $2, now() - make_interval(mins => $3), 5.00) RETURNING id`,
      [b[0].id, order.id, ageMinutes]
    );
    copyId = copy[0].id;
    await pool.query(
      "INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, 'Seat Book', 5.00)",
      [order.id, copyId]
    );
  }
  return { order, classId, seatId: s[0].id, copyId };
}

const seatsTaken = async (classId) =>
  (await pool.query(`SELECT ${seatsTakenExpr("classes")}::int AS n FROM classes WHERE id = $1`, [classId])).rows[0].n;

test("releasing an order that holds a drop-in seat and a book works and frees both", async () => {
  const { order, classId, seatId, copyId } = await insertDropinOrder({ withBook: true });
  assert.equal(await seatsTaken(classId), 1);

  await releaseCartHold(pool, order.id, "expired");

  const { rows: o } = await pool.query("SELECT status FROM orders WHERE id = $1", [order.id]);
  assert.equal(o[0].status, "expired");
  const { rows: c } = await pool.query("SELECT status, cart_order_id FROM book_copies WHERE id = $1", [copyId]);
  assert.equal(c[0].status, "in_stock", "the book must be released too, not stuck behind the seat failure");
  assert.equal(c[0].cart_order_id, null);
  const { rows: s } = await pool.query("SELECT status FROM class_dropin_seats WHERE id = $1", [seatId]);
  assert.equal(s[0].status, "released", "the seat row is kept (order_items references it), just marked released");
  assert.equal(await seatsTaken(classId), 0, "a released seat must stop counting against the session's capacity");
  const { rows: items } = await pool.query("SELECT 1 FROM order_items WHERE order_id = $1", [order.id]);
  assert.equal(items.length, 2, "the expired order keeps its line items");
});

test("a stale drop-in-only order is found and expired by the sweep", async () => {
  const { order, classId } = await insertDropinOrder({ ageMinutes: 120 });
  await expireStaleCartHolds(pool);
  const { rows: o } = await pool.query("SELECT status FROM orders WHERE id = $1", [order.id]);
  assert.equal(o[0].status, "expired");
  assert.equal(await seatsTaken(classId), 0);
});

test("a fresh drop-in hold is left alone by the sweep", async () => {
  const { order, classId } = await insertDropinOrder({ ageMinutes: 5 });
  await expireStaleCartHolds(pool);
  const { rows: o } = await pool.query("SELECT status FROM orders WHERE id = $1", [order.id]);
  assert.equal(o[0].status, "pending");
  assert.equal(await seatsTaken(classId), 1);
});

// ---------- reservations (the current model) ----------

async function reserveSeatAndBook({ startsInHours = 48, endsInHours = 50 } = {}) {
  const buyer = await h.account();
  const classId = await h.session({ capacity: 3, price: 20, startsInHours, endsInHours });
  const copyId = await h.copy({ price: 5 });
  const { order } = await h.reserve(buyer, { copyIds: [copyId], classIds: [classId] });
  const seatId = (await pool.query("SELECT id FROM class_dropin_seats WHERE order_id = $1", [order.id])).rows[0].id;
  return { order, classId, seatId, copyId, buyer };
}

test("releasing a reservation that holds a drop-in seat and a book works and frees both (the seat row is kept, uncounted)", async () => {
  const { order, classId, seatId, copyId } = await reserveSeatAndBook();
  assert.equal(await seatsTaken(classId), 1);

  const result = await releaseReservation(pool, order.id, { status: "cancelled", reason: "admin" });
  assert.equal(result.outcome, "released");

  assert.equal((await h.order(order.id)).status, "cancelled");
  const { rows: c } = await pool.query("SELECT status, cart_order_id FROM book_copies WHERE id = $1", [copyId]);
  assert.equal(c[0].status, "in_stock", "the book must be released too, not stuck behind the seat");
  assert.equal(c[0].cart_order_id, null);
  const { rows: s } = await pool.query("SELECT status FROM class_dropin_seats WHERE id = $1", [seatId]);
  assert.equal(s[0].status, "released", "the seat row is kept (order_items references it), just marked released");
  assert.equal(await seatsTaken(classId), 0, "a released seat must stop counting against the session's capacity");
  const { rows: items } = await pool.query("SELECT 1 FROM order_items WHERE order_id = $1", [order.id]);
  assert.equal(items.length, 2, "the closed order keeps its line items");
});

test("a seat-only reservation past its deadline is found and expired by the sweep", async () => {
  const buyer = await h.account();
  const classId = await h.session({ capacity: 3, price: 20 });
  const { order } = await h.reserve(buyer, { classIds: [classId] });
  await pool.query("UPDATE orders SET reserved_until = now() - interval '1 hour' WHERE id = $1", [order.id]);
  await expireStaleReservations(pool);
  assert.equal((await h.order(order.id)).status, "expired");
  assert.equal(await seatsTaken(classId), 0);
});

test("a reservation still inside its deadline is left alone by the sweep", async () => {
  const { order, classId, copyId } = await reserveSeatAndBook();
  await expireStaleReservations(pool);
  assert.equal((await h.order(order.id)).status, "reserved");
  assert.equal(await seatsTaken(classId), 1);
  assert.equal(await h.copyStatus(copyId), "reserved");
});

test("a seat nobody came for is released once its session is over; the book of the same order stays held", async () => {
  const { order, classId, seatId, copyId } = await reserveSeatAndBook();
  await pool.query("UPDATE classes SET starts_at = now() - interval '3 hours', ends_at = now() - interval '1 hour' WHERE id = $1", [classId]);
  assert.equal(await releaseEndedSeats(pool), 1);
  assert.equal((await pool.query("SELECT status FROM class_dropin_seats WHERE id = $1", [seatId])).rows[0].status, "released");
  assert.equal(await seatsTaken(classId), 0);
  assert.equal((await h.order(order.id)).status, "reserved", "the order still holds a book");
  assert.equal(await h.copyStatus(copyId), "reserved");
});

test("a seat that was collected and paid ('sold') is never released by the session-over sweep", async () => {
  const { classId, seatId } = await reserveSeatAndBook();
  await pool.query("UPDATE class_dropin_seats SET status = 'sold' WHERE id = $1", [seatId]);
  await pool.query("UPDATE classes SET starts_at = now() - interval '3 hours', ends_at = now() - interval '1 hour' WHERE id = $1", [classId]);
  assert.equal(await releaseEndedSeats(pool), 0);
  assert.equal((await pool.query("SELECT status FROM class_dropin_seats WHERE id = $1", [seatId])).rows[0].status, "sold");
});

test("releasing an already-released reservation changes nothing: its seat is never re-claimed or double-released", async () => {
  const { order, seatId } = await reserveSeatAndBook();
  await releaseReservation(pool, order.id, { status: "expired", reason: "expired" });
  const again = await releaseReservation(pool, order.id, { status: "cancelled", reason: "customer" });
  assert.equal(again.outcome, "not_reserved");
  assert.equal((await h.order(order.id)).status, "expired");
  assert.equal((await pool.query("SELECT status FROM class_dropin_seats WHERE id = $1", [seatId])).rows[0].status, "released");
});
