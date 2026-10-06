// What an admin can do to an online order after it exists (/admin/orders/:id):
// mark it collected, mark it refunded, cancel it while unpaid.
//
// Refunding is ALWAYS done by a person in the HelloAsso dashboard first: this
// app has no way to move money. "Mark refunded" only brings our own records in
// line (order status, the books back on the shelf, the drop-in seats back on
// sale). Each action returns { outcome, ... } instead of throwing for the
// expected refusals, and is safe to repeat (a second click changes nothing).

const { withTransaction } = require("../db");

const NOTE_MAX = 500;

// A paid order is "awaiting pickup" while it has at least one book and nobody
// has marked it collected. Drop-in seats need no collection.
const HAS_BOOKS = `EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.book_copy_id IS NOT NULL)`;
const AWAITING_PICKUP = `o.status = 'paid' AND o.collected_at IS NULL AND ${HAS_BOOKS}`;

// The admin's work lists (the "Show" filter on /admin/orders, and the counts in
// the dashboard's "needs attention" box). Each sql is a condition on `o`.
const OVERDUE_DAYS = 14;
const STALE_PENDING_HOURS = 2;
const ORDER_VIEWS = {
  uncollected: { label: "Paid and not collected", sql: AWAITING_PICKUP },
  overdue: { label: `Not collected after ${OVERDUE_DAYS} days`, sql: `${AWAITING_PICKUP} AND o.paid_at < now() - interval '${OVERDUE_DAYS} days'` },
  refund_detected: { label: "Refund detected in HelloAsso", sql: "o.status = 'paid' AND o.refund_detected_at IS NOT NULL" },
  stale_pending: { label: `Unpaid for over ${STALE_PENDING_HOURS} hours`, sql: `o.status = 'pending' AND o.created_at < now() - interval '${STALE_PENDING_HOURS} hours'` },
};

// Marks a paid order collected. outcome: "collected" | "already" | "not_paid" | "not_found".
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

// Marks a paid order refunded, after the admin refunded it in HelloAsso.
// One transaction, with the order row locked:
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

// Cancels an unpaid (pending) order and frees its books and seats. HelloAsso
// is asked first: an order that turns out to be paid is NOT cancelled.
// outcome: "cancelled" | "paid" | "not_pending" | "not_found".
async function cancelUnpaidOrder(pool, orderId) {
  // Required lazily: lib/cart.js is the payment path and is replaced by tests.
  const cart = require("./cart");
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [orderId]);
  const order = rows[0];
  if (!order) return { outcome: "not_found" };
  if (order.status !== "pending") return { outcome: "not_pending", status: order.status };
  const status = await cart.reconcileOrder(pool, order);
  if (status === "paid") return { outcome: "paid" };
  if (status !== "pending") return { outcome: "not_pending", status };
  await cart.releaseCartHold(pool, orderId, "cancelled");
  const { rows: after } = await pool.query("SELECT status FROM orders WHERE id = $1", [orderId]);
  if (after[0] && after[0].status === "paid") return { outcome: "paid" };
  return { outcome: "cancelled" };
}

module.exports = { markOrderCollected, markOrderRefunded, cancelUnpaidOrder, AWAITING_PICKUP, HAS_BOOKS, NOTE_MAX, ORDER_VIEWS, OVERDUE_DAYS, STALE_PENDING_HOURS };
