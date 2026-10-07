// Collecting an online RESERVATION at the till: scan (or type) ORDER-<n>, or scan
// the UB- label of a book that a reservation holds. The reservation's lines are
// loaded into the sale (at the reserved prices: nothing to override), the
// customer pays cash or card at the till, and the order is paid through the SAME
// function the admin "Mark collected and paid" button uses
// (lib/orderActions.js collectReservationTx), inside the till's own transaction:
// no second copy of that logic. The staff can remove lines before paying: the
// lines left are a partial pickup and the rest stays reserved (the same "collect
// selected items" rule), drop-in seats included.
//
// What a till sale writes for a collected reservation: till_sales and
// till_sale_items rows (so the receipt, the day totals and the accounting export
// include the money taken), tagged with reservation_order_id; NO shop_sales row
// (the Sales report already counts the order, at paid_at, once); the books and
// seats are sold by collectReservationTx. A sale that collected a reservation
// cannot be voided from the till: refund the order instead (orderActions
// markOrderRefunded).

const NOT_OPEN = {
  paid: "was already collected and paid",
  refunded: "was already collected and refunded",
  cancelled: "was cancelled",
  expired: "expired and was released",
  pending: "is an old unpaid online order, not a reservation",
};

// Rows of the reservation's items. A copy is held when it is 'reserved' FOR THIS
// ORDER; a seat when it is 'reserved'.
const ITEMS_SQL = `
  SELECT oi.id AS item_id, oi.price, oi.item_title, oi.book_copy_id, oi.class_dropin_seat_id,
         bc.condition, bc.publisher_price, bc.location, bc.status AS copy_status, bc.cart_order_id, bc.is_clearance,
         b.title, b.authors, b.isbn, ds.status AS seat_status, c.title AS class_title, c.starts_at AS class_starts_at
  FROM order_items oi
  LEFT JOIN book_copies bc ON bc.id = oi.book_copy_id
  LEFT JOIN books b ON b.id = bc.book_id
  LEFT JOIN class_dropin_seats ds ON ds.id = oi.class_dropin_seat_id
  LEFT JOIN classes c ON c.id = ds.class_id
  WHERE oi.order_id = $1 ORDER BY oi.id`;

const held = (r, orderId) => (r.book_copy_id != null ? r.copy_status === "reserved" && r.cart_order_id === orderId : r.seat_status === "reserved");

// -> { error } | { order: { id, name, email }, items: [row...] } (only items still held).
async function loadReservation(db, orderId) {
  const { rows } = await db.query("SELECT id, status, buyer_name, buyer_email, reserved_until FROM orders WHERE id = $1", [orderId]);
  const order = rows[0];
  if (!order) return { error: `No order ${orderId}.` };
  if (order.status !== "reserved") return { error: `Order #${orderId} ${NOT_OPEN[order.status] || `is ${order.status}`}.` };
  const { rows: all } = await db.query(ITEMS_SQL, [orderId]);
  const items = all.filter((r) => held(r, orderId));
  if (!items.length) return { error: `Nothing is held for order #${orderId} any more (its books were sold or released). Cancel it from the order page.` };
  return { order: { id: order.id, name: order.buyer_name, email: order.buyer_email, reservedUntil: order.reserved_until }, items };
}

// The order that holds a copy (for a scanned UB- label), or null.
async function reservationOfCopy(db, copyId) {
  const { rows } = await db.query(
    "SELECT c.cart_order_id FROM book_copies c JOIN orders o ON o.id = c.cart_order_id WHERE c.id = $1 AND c.status = 'reserved' AND o.status = 'reserved'", [copyId]);
  return rows[0] ? rows[0].cart_order_id : null;
}

// Inside the sale's transaction: lock the orders (in id order, BEFORE any copy
// lock, like every order action) and check each posted reservation line is still
// held for its order. Returns Map(raw line -> resolved row).
async function lockReservedLines(db, rawLines, TillError) {
  const resolved = new Map();
  if (!rawLines.length) return resolved;
  for (const it of rawLines) {
    if (!/^\d{1,9}$/.test(String(it.orderId)) || !/^\d{1,9}$/.test(String(it.itemId))) throw new TillError("A reservation line could not be read.");
  }
  const itemKeys = rawLines.map((it) => `${it.orderId}:${it.itemId}`);
  if (new Set(itemKeys).size !== itemKeys.length) throw new TillError("The same reserved item is on the sale twice.");
  const orderIds = [...new Set(rawLines.map((it) => Number(it.orderId)))].sort((a, b) => a - b);
  const { rows: orders } = await db.query("SELECT id, status FROM orders WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE", [orderIds]);
  const byId = new Map(orders.map((o) => [o.id, o]));
  for (const id of orderIds) {
    const o = byId.get(id);
    if (!o) throw new TillError(`Order #${id} could not be found.`, 404);
    if (o.status !== "reserved") throw new TillError(`Order #${id} is no longer a reservation (it ${NOT_OPEN[o.status] || `is ${o.status}`}). Reload the till.`, 409);
  }
  const rowsByOrder = new Map();
  for (const id of orderIds) rowsByOrder.set(id, new Map((await db.query(ITEMS_SQL, [id])).rows.map((r) => [r.item_id, r])));
  for (const it of rawLines) {
    const row = rowsByOrder.get(Number(it.orderId)).get(Number(it.itemId));
    if (!row) throw new TillError(`A line does not belong to order #${it.orderId}.`);
    if (!held(row, Number(it.orderId))) {
      throw new TillError(`"${row.item_title}" is no longer held for order #${it.orderId} (it was sold or released). Reload the till.`, 409);
    }
    resolved.set(it, row);
  }
  return resolved;
}

// After the sale rows are written: pay each order, for exactly the items that
// were on the sale. Throws (rolling the whole sale back) on anything but a clean collection.
async function collectReserved(db, lines, { method, userId }, TillError) {
  const byOrder = new Map();
  for (const l of lines) {
    if (!byOrder.has(l.orderId)) byOrder.set(l.orderId, []);
    byOrder.get(l.orderId).push(l.itemId);
  }
  const collected = [];
  for (const [orderId, itemIds] of [...byOrder].sort((a, b) => a[0] - b[0])) {
    const { collectReservationTx } = require("./orderActions"); // lazily: lib/till.js is also loaded without a database
    const r = await collectReservationTx(db, orderId, { adminUserId: userId, method, itemIds });
    if (r.outcome !== "collected") throw new TillError(`Order #${orderId} could not be collected (${r.outcome}). Reload the till and try again.`, 409);
    collected.push({ orderId, total: r.total, items: r.items, partial: r.partial, newOrderId: r.newOrderId });
  }
  return collected;
}

module.exports = { loadReservation, reservationOfCopy, lockReservedLines, collectReserved };
