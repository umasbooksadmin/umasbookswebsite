// What an admin can do to an order after it exists (/admin/orders/:id).
//
// RESERVATIONS (status 'reserved'; see lib/reservations.js): the customer pays IN
// PERSON, so the staff record the payment here:
//   collectReservation  "Mark collected and paid": one transaction, order -> paid
//                       (paid_at = now, how it was paid, what was received),
//                       books -> sold, seats -> sold. With `itemIds` only those
//                       items are sold and paid (partial pickup): the rest move to
//                       a NEW reserved order with the same deadline.
//   releaseReservation  "Cancel reservation" / "Mark no-show": everything goes back.
//   extendReservation   "Extend by 7 days", once.
//
// Refunding is ALWAYS done by a person in the shop (cash, cheque or card): this
// app has no way to move money. "Mark refunded" only brings our own records in
// line (order status, the books back on the shelf, the drop-in seats back on
// sale). Each action returns { outcome, ... } instead of throwing for the
// expected refusals, and is safe to repeat (a second click changes nothing).

const { withTransaction } = require("../db");
const { parseMoney } = require("./validation");
const { releaseReservation, extendReservation } = require("./reservations");

const NOTE_MAX = 500;

// How a customer paid in the shop (orders.payment_method).
const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card at the shop" },
  { value: "cheque", label: "Cheque" },
  { value: "other", label: "Other" },
];

// A PAID order from the old online checkout is "awaiting pickup" while it has at
// least one book and nobody has marked it collected (a reservation that was paid
// in the shop is collected at the same moment, so it never is). Drop-in seats
// need no collection.
const HAS_BOOKS = `EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.book_copy_id IS NOT NULL)`;
const AWAITING_PICKUP = `o.status = 'paid' AND o.collected_at IS NULL AND ${HAS_BOOKS}`;

// The admin's work lists (the "Show" filter on /admin/orders, and the counts in
// the dashboard's "needs attention" box). Each sql is a condition on `o`.
const OVERDUE_DAYS = 14;
const EXPIRING_SOON_DAYS = 3;
const STALE_PENDING_HOURS = 2;
const ORDER_VIEWS = {
  expiring_soon: {
    label: `Expiring in ${EXPIRING_SOON_DAYS} days`,
    sql: `o.status = 'reserved' AND o.reserved_until >= now() AND o.reserved_until < now() + interval '${EXPIRING_SOON_DAYS} days'`,
  },
  past_deadline: {
    label: "Past the deadline, not yet released",
    sql: "o.status = 'reserved' AND o.reserved_until < now()",
  },
  // Orders paid online before reservations replaced online payment.
  uncollected: { label: "Paid online and not collected (old reservations)", sql: AWAITING_PICKUP },
  overdue: { label: `Paid online, not collected after ${OVERDUE_DAYS} days (old reservations)`, sql: `${AWAITING_PICKUP} AND o.paid_at < now() - interval '${OVERDUE_DAYS} days'` },
  stale_pending: { label: `Unpaid for over ${STALE_PENDING_HOURS} hours (old reservations)`, sql: `o.status = 'pending' AND o.created_at < now() - interval '${STALE_PENDING_HOURS} hours'` },
};

// Marks a paid order (old online checkout) collected. outcome: "collected" | "already" | "not_paid" | "not_found".
async function markOrderCollected(pool, orderId, adminUserId) {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query("SELECT id, status, collected_at FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
    const order = rows[0];
    if (!order) return { outcome: "not_found" };
    if (order.status !== "paid") return { outcome: "not_paid", status: order.status };
    if (order.collected_at) return { outcome: "already" };
    await client.query("UPDATE orders SET collected_at = now(), collected_by = $2 WHERE id = $1", [orderId, adminUserId || null]);
    return { outcome: "collected" };
  });
}

const toCents = (v) => Math.round(Number(v) * 100);

// "Mark collected and paid". The customer came, took (some of) the reserved items
// and paid in the shop. Everything below is ONE transaction with the order row
// locked first (a release or an extension cannot overlap it):
//   - the items still held (a book 'reserved' for THIS order, a seat 'reserved')
//     are "active"; with `itemIds` only those order_items ids are collected,
//     otherwise all active ones. An item that is no longer held (its book was
//     sold in the shop meanwhile, its session passed) is dropped from the order.
//   - collected items: books and seats become 'sold'.
//   - the order becomes 'paid': paid_at = now, payment_method, amount_received,
//     collected_at/by. total_amount becomes what was received (reports count
//     revenue from it at paid_at); reserved_total keeps the reserved total when
//     less was received (allowed only with a note).
//   - partial pickup: the active items NOT collected move to a new 'reserved'
//     order (same customer, same deadline, split_from_order_id = this order).
// `amountReceived` (euros) defaults to the total of the collected items and may
// only be LOWER (a discount given at the till, with a note).
// outcome: "collected" | "not_found" | "not_reserved" | "method_required" |
// "nothing_to_collect" | "amount_invalid" | "amount_too_high" | "note_required".
async function collectReservation(pool, orderId, opts = {}) {
  return withTransaction(pool, (client) => collectReservationTx(client, orderId, opts));
}

// The same, inside a transaction the caller already opened (the till collects a
// reservation in the SAME transaction as its own sale rows: no duplicated logic).
// On any outcome other than "collected" nothing was changed by this call.
async function collectReservationTx(client, orderId, { adminUserId = null, method, amountReceived, note, itemIds } = {}) {
  if (!PAYMENT_METHODS.some((m) => m.value === method)) return { outcome: "method_required" };
  const cleanNote = String(note == null ? "" : note).trim().slice(0, NOTE_MAX);
  {
    const { rows } = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
    const order = rows[0];
    if (!order) return { outcome: "not_found" };
    if (order.status !== "reserved") return { outcome: "not_reserved", status: order.status };

    const { rows: items } = await client.query(
      `SELECT oi.id, oi.price, oi.item_title, oi.book_copy_id, oi.class_dropin_seat_id,
              bc.status AS copy_status, bc.cart_order_id AS copy_order_id, ds.status AS seat_status
       FROM order_items oi
       LEFT JOIN book_copies bc ON bc.id = oi.book_copy_id
       LEFT JOIN class_dropin_seats ds ON ds.id = oi.class_dropin_seat_id
       WHERE oi.order_id = $1 ORDER BY oi.id`,
      [orderId]
    );
    const copyIds = items.filter((i) => i.book_copy_id != null).map((i) => i.book_copy_id).sort((a, b) => a - b);
    const seatIds = items.filter((i) => i.class_dropin_seat_id != null).map((i) => i.class_dropin_seat_id).sort((a, b) => a - b);
    // Lock what we are about to change, in id order, then read the state again.
    if (copyIds.length) await client.query("SELECT id FROM book_copies WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE", [copyIds]);
    if (seatIds.length) await client.query("SELECT id FROM class_dropin_seats WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE", [seatIds]);
    const { rows: fresh } = await client.query(
      `SELECT oi.id, bc.status AS copy_status, bc.cart_order_id AS copy_order_id, ds.status AS seat_status
       FROM order_items oi
       LEFT JOIN book_copies bc ON bc.id = oi.book_copy_id
       LEFT JOIN class_dropin_seats ds ON ds.id = oi.class_dropin_seat_id
       WHERE oi.order_id = $1`,
      [orderId]
    );
    const state = new Map(fresh.map((r) => [r.id, r]));
    const isActive = (i) => {
      const st = state.get(i.id);
      if (!st) return false;
      return i.book_copy_id != null
        ? st.copy_status === "reserved" && st.copy_order_id === orderId
        : st.seat_status === "reserved";
    };
    const active = items.filter(isActive);
    const inactive = items.filter((i) => !isActive(i));
    const wanted = itemIds ? new Set(itemIds.map(Number)) : null;
    const selected = wanted ? active.filter((i) => wanted.has(i.id)) : active;
    if (!selected.length) return { outcome: "nothing_to_collect" };
    const rest = active.filter((i) => !selected.includes(i));

    const subtotal = selected.reduce((sum, i) => sum + toCents(i.price), 0);
    let received = subtotal;
    if (amountReceived !== undefined && amountReceived !== null && String(amountReceived).trim() !== "") {
      // Same strict money rule as every other form (comma or dot, at most 2 decimals; no "0x0A", "1e1").
      const parsed = parseMoney(amountReceived, { allowBlank: true });
      if (parsed.error || parsed.value === null) return { outcome: "amount_invalid" };
      received = toCents(parsed.value);
      if (received > subtotal) return { outcome: "amount_too_high", subtotal: subtotal / 100 };
    }
    if (received < subtotal && !cleanNote) return { outcome: "note_required" };

    let newOrderId = null;
    if (rest.length) {
      const restTotal = rest.reduce((sum, i) => sum + toCents(i.price), 0) / 100;
      const { rows: created } = await client.query(
        `INSERT INTO orders (buyer_name, buyer_email, buyer_phone, total_amount, status, withdrawal_waiver_at, lang,
                             cgv_accepted_at, cgv_version, user_id, reserved_until, reservation_extended_at, confirmation_sent_at,
                             customer_pickup_reminder_sent_at, pickup_reminder_sent_at, split_from_order_id)
         SELECT buyer_name, buyer_email, buyer_phone, $2, 'reserved', withdrawal_waiver_at, lang,
                cgv_accepted_at, cgv_version, user_id, reserved_until, reservation_extended_at, confirmation_sent_at,
                customer_pickup_reminder_sent_at, pickup_reminder_sent_at, id
         FROM orders WHERE id = $1 RETURNING id`,
        [orderId, restTotal]
      );
      newOrderId = created[0].id;
      const restCopies = rest.filter((i) => i.book_copy_id != null).map((i) => i.book_copy_id);
      const restSeats = rest.filter((i) => i.class_dropin_seat_id != null).map((i) => i.class_dropin_seat_id);
      await client.query("UPDATE order_items SET order_id = $2 WHERE id = ANY($1::int[])", [rest.map((i) => i.id), newOrderId]);
      if (restCopies.length) await client.query("UPDATE book_copies SET cart_order_id = $2, updated_at = now() WHERE id = ANY($1::int[])", [restCopies, newOrderId]);
      if (restSeats.length) await client.query("UPDATE class_dropin_seats SET order_id = $2, updated_at = now() WHERE id = ANY($1::int[])", [restSeats, newOrderId]);
    }
    if (inactive.length) await client.query("DELETE FROM order_items WHERE id = ANY($1::int[])", [inactive.map((i) => i.id)]);

    const soldCopies = selected.filter((i) => i.book_copy_id != null).map((i) => i.book_copy_id);
    const soldSeats = selected.filter((i) => i.class_dropin_seat_id != null).map((i) => i.class_dropin_seat_id);
    if (soldCopies.length) {
      await client.query(
        `UPDATE book_copies SET status = 'sold', reserved_by_name = NULL, reserved_by_email = NULL, reserved_by_phone = NULL,
                reserved_at = NULL, reminder_sent_at = NULL, cart_order_id = NULL, cart_added_at = NULL, updated_at = now()
         WHERE id = ANY($1::int[])`,
        [soldCopies]
      );
    }
    if (soldSeats.length) {
      await client.query("UPDATE class_dropin_seats SET status = 'sold', updated_at = now() WHERE id = ANY($1::int[])", [soldSeats]);
    }
    await client.query(
      `UPDATE orders SET status = 'paid', paid_at = now(), total_amount = $2, amount_received = $2,
              reserved_total = CASE WHEN $3::numeric <> $2::numeric THEN $3 END,
              payment_method = $4, payment_note = $5, collected_at = now(), collected_by = $6, client_ip = NULL
       WHERE id = $1`,
      [orderId, received / 100, subtotal / 100, method, cleanNote || null, adminUserId]
    );
    return {
      outcome: "collected", total: received / 100, reservedTotal: subtotal / 100, items: selected.length,
      partial: rest.length > 0, newOrderId, dropped: inactive.map((i) => i.item_title),
    };
  }
}

// "Cancel reservation" by an admin: books back in stock, seats released.
const cancelReservationByAdmin = (pool, orderId) => releaseReservation(pool, orderId, { status: "cancelled", reason: "admin" });
// "Mark no-show / expired": the customer never came; the same release, recorded as such.
const markReservationNoShow = (pool, orderId) => releaseReservation(pool, orderId, { status: "expired", reason: "no_show" });

// Marks a paid order refunded, after the shop gave the money back (cash, cheque
// or card, done by a person). One transaction, with the order row locked:
//   - order -> 'refunded' (+ refunded_at, refund_note);
//   - every copy this order sold goes back to 'in_stock', EXCEPT a copy that
//     has since been sold again (a shop sale after this order was paid, or
//     another paid order): that one is left alone and reported in `kept`;
//   - the order's drop-in seats become 'released', so they stop counting
//     against the session's capacity.
// outcome: "refunded" | "already" | "not_paid" | "not_found" | "note_required".
async function markOrderRefunded(pool, orderId, { note } = {}) {
  const cleanNote = String(note == null ? "" : note).trim().slice(0, NOTE_MAX);
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
    const order = rows[0];
    if (!order) return { outcome: "not_found" };
    if (order.status === "refunded") return { outcome: "already" };
    if (order.status !== "paid") return { outcome: "not_paid", status: order.status };
    if (!cleanNote) return { outcome: "note_required" };

    await client.query("UPDATE orders SET status = 'refunded', refunded_at = now(), refund_note = $2 WHERE id = $1", [orderId, cleanNote]);

    const { rows: copyRows } = await client.query(
      `SELECT c.id, c.status,
              EXISTS (SELECT 1 FROM shop_sales s WHERE s.copy_id = c.id AND s.sold_at >= $2) AS resold_in_shop,
              EXISTS (SELECT 1 FROM order_items oi2 JOIN orders o2 ON o2.id = oi2.order_id
                      WHERE oi2.book_copy_id = c.id AND o2.id <> $1 AND o2.status = 'paid') AS resold_online
       FROM order_items oi JOIN book_copies c ON c.id = oi.book_copy_id
       WHERE oi.order_id = $1 ORDER BY c.id FOR UPDATE OF c`,
      [orderId, order.paid_at || order.created_at]
    );
    const restock = copyRows.filter((c) => c.status === "sold" && !c.resold_in_shop && !c.resold_online).map((c) => c.id);
    const kept = copyRows.filter((c) => c.status === "sold" && (c.resold_in_shop || c.resold_online)).map((c) => c.id);
    if (restock.length) {
      await client.query(
        `UPDATE book_copies SET status = 'in_stock', cart_order_id = NULL, cart_added_at = NULL, updated_at = now()
         WHERE id = ANY($1::int[])`,
        [restock]
      );
    }
    const seats = await client.query(
      "UPDATE class_dropin_seats SET status = 'released', updated_at = now() WHERE order_id = $1 AND status = 'sold'",
      [orderId]
    );
    return { outcome: "refunded", restocked: restock.length, kept, seatsReleased: seats.rowCount };
  });
}

// Cancels an unpaid (pending) order left over from the old online checkout and
// frees its books and seats. No payment provider is asked: such an order can no
// longer be paid. outcome: "cancelled" | "not_pending" | "not_found".
async function cancelUnpaidOrder(pool, orderId) {
  // Required lazily: lib/cart.js requires the reservation code.
  const cart = require("./cart");
  const { rows } = await pool.query("SELECT status FROM orders WHERE id = $1", [orderId]);
  if (!rows[0]) return { outcome: "not_found" };
  if (rows[0].status !== "pending") return { outcome: "not_pending", status: rows[0].status };
  await cart.releaseCartHold(pool, orderId, "cancelled");
  return { outcome: "cancelled" };
}

module.exports = {
  markOrderCollected, collectReservation, collectReservationTx, cancelReservationByAdmin, markReservationNoShow, extendReservation,
  markOrderRefunded, cancelUnpaidOrder,
  AWAITING_PICKUP, HAS_BOOKS, NOTE_MAX, ORDER_VIEWS, OVERDUE_DAYS, EXPIRING_SOON_DAYS, STALE_PENDING_HOURS, PAYMENT_METHODS,
};
