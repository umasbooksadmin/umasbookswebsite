// The online-checkout cart, separate from in-person reservations
// (src/lib/reservations.js). Browsing/"add to cart" is just a list of
// copy ids in the session — no inventory lock — so an abandoned cart
// never ties up a copy someone else could reserve or buy. A copy is
// only locked (status = 'in_cart') once checkout actually starts and we
// have a real HelloAsso checkout intent, and that lock expires quickly:
// HelloAsso's own redirect link is only valid ~15 minutes and considers
// a checkout abandoned after ~45, so an hour is a safe margin.

const { getCheckoutIntent, isOrderPaid } = require("./helloasso");
const { sendMail } = require("../mailer");
const { withTransaction } = require("../db");

const CART_HOLD_TTL_MINUTES = 60;

async function expireStaleCartHolds(pool) {
  const { rows: stale } = await pool.query(
    `SELECT DISTINCT order_id FROM (
       SELECT cart_order_id AS order_id FROM book_copies
       WHERE status = 'in_cart' AND cart_added_at < now() - interval '${CART_HOLD_TTL_MINUTES} minutes'
     ) s`
  );
  for (const { order_id } of stale) {
    await releaseCartHold(pool, order_id, "expired");
  }
}

// Puts a cart's copies back on the shelf, drops any drop-in session
// seat holds outright (there's nothing to "return to stock" — the seat
// row was only ever synthetic, see migrations/015_dropin_seats.sql), and
// marks the order closed. Used both for TTL expiry above and for a
// checkout that comes back non-paid (refused/canceled/abandoned).
//
// All in one transaction, with the order row locked first: a hold must
// never be released for an order that is actually paid. If it is (a
// payment that landed while this was running, or state left behind by an
// interrupted markOrderPaid), finish marking its copies sold instead —
// the paid-but-resold failure this guards against.
async function releaseCartHold(pool, orderId, status) {
  await withTransaction(pool, async (client) => {
    const { rows } = await client.query("SELECT status FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
    if (rows[0] && rows[0].status === "paid") {
      await markCopiesSold(client, orderId);
      return;
    }
    await client.query(
      `UPDATE book_copies SET status = 'in_stock', cart_order_id = NULL, cart_added_at = NULL, updated_at = now()
       WHERE cart_order_id = $1`,
      [orderId]
    );
    await client.query(`DELETE FROM class_dropin_seats WHERE order_id = $1 AND status = 'in_cart'`, [orderId]);
    await client.query(`UPDATE orders SET status = $1 WHERE id = $2 AND status = 'pending'`, [status, orderId]);
  });
}

async function markCopiesSold(client, orderId) {
  await client.query(
    `UPDATE book_copies SET status = 'sold', cart_order_id = NULL, cart_added_at = NULL, updated_at = now()
     WHERE cart_order_id = $1`,
    [orderId]
  );
  await client.query(`UPDATE class_dropin_seats SET status = 'sold', updated_at = now() WHERE order_id = $1`, [orderId]);
}

async function markOrderPaid(pool, order) {
  // The WHERE clause here (not just the id) is the actual idempotency
  // boundary: reconcileOrder's own "order.status !== 'pending'" guard
  // only protects against a *sequential* re-call with a freshly-fetched
  // order row. It does nothing for two calls racing concurrently on the
  // same stale in-memory `order` — e.g. a live webhook delivery landing
  // at the same moment as the periodic reconcilePendingOrders sweep
  // (index.js), or HelloAsso retrying a webhook it didn't get a fast
  // enough 200 for. Postgres serializes two concurrent UPDATEs on the
  // same row, so only one of them ever sees status='pending' still true
  // and gets rowCount 1 — the loser sees 0 and bails before touching
  // inventory or sending a second confirmation email.
  //
  // The status flip and the inventory change commit together: if the
  // process died between them, the order would read 'paid' (so nothing
  // would ever retry) while its copies sat in_cart, and the hold-expiry
  // sweep would put a book someone already paid for back on sale.
  const won = await withTransaction(pool, async (client) => {
    const { rowCount } = await client.query(
      "UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1 AND status = 'pending'",
      [order.id]
    );
    if (rowCount === 0) return false;
    await markCopiesSold(client, order.id);
    return true;
  });
  if (!won) return;

  const { rows: items } = await pool.query("SELECT item_title, price FROM order_items WHERE order_id = $1", [order.id]);
  const lines = items.map((i) => `- ${i.item_title} — €${Number(i.price).toFixed(2)}`).join("\n");
  sendMail({
    to: order.buyer_email,
    subject: "Your order at Uma's Books is confirmed",
    text: `Hi ${order.buyer_name},\n\nThanks for your order — payment received:\n\n${lines}\n\nTotal: €${Number(order.total_amount).toFixed(2)}\n\nCome by Uma's Books during opening hours to pick up any books. Drop-in sessions need no pickup — just come along at the session time.\n\nUma's Books\nRue Peyroliere, 81000 Albi`,
  }).catch((err) => console.error(`Order confirmation email failed for order ${order.id}:`, err.message));
}

// The single source of truth for "did this order get paid" — re-checks
// with HelloAsso's own API rather than trusting a webhook payload or the
// return-URL's code=succeeded param, both of which HelloAsso's docs say
// aren't reliable enough to act on directly. Safe to call more than once
// (markOrderPaid/releaseCartHold only touch orders still 'pending').
async function reconcileOrder(pool, order) {
  if (!order || order.status !== "pending" || !order.checkout_intent_id) return order.status;

  let intent;
  try {
    intent = await getCheckoutIntent(order.checkout_intent_id);
  } catch (err) {
    console.error(`HelloAsso lookup failed for order ${order.id}:`, err.message);
    return "pending"; // transient API error — leave it pending, a later pass will retry
  }

  if (isOrderPaid(intent)) {
    await markOrderPaid(pool, order);
    if (intent.order && intent.order.id) {
      await pool.query("UPDATE orders SET helloasso_order_id = $1 WHERE id = $2", [String(intent.order.id), order.id]);
    }
    return "paid";
  }

  const payments = (intent.order && intent.order.payments) || [];
  const terminalFailure = payments.some((p) => ["Refused", "Canceled", "Error"].includes(p.state));
  if (terminalFailure) {
    await releaseCartHold(pool, order.id, "cancelled");
    return "cancelled";
  }

  return "pending"; // still genuinely in progress (Pending/Registered/etc.)
}

// Periodic backstop (mirrors runReservationMaintenance in index.js) for
// orders whose webhook and return-URL both missed — e.g. the buyer
// closed the tab mid-payment and HelloAsso's notification didn't arrive
// or wasn't recognized. Only bothers with orders old enough that the
// checkout page (valid ~15 min) has definitely resolved one way or
// another.
async function reconcilePendingOrders(pool) {
  const { rows: pending } = await pool.query(
    `SELECT * FROM orders WHERE status = 'pending' AND checkout_intent_id IS NOT NULL
       AND created_at < now() - interval '20 minutes'`
  );
  for (const order of pending) {
    try {
      await reconcileOrder(pool, order);
    } catch (err) {
      console.error(`Order reconciliation failed for order ${order.id}:`, err.message);
    }
  }
}

module.exports = { expireStaleCartHolds, releaseCartHold, markOrderPaid, reconcileOrder, reconcilePendingOrders, CART_HOLD_TTL_MINUTES };
