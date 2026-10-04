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
const { alertOnError } = require("./errorAlert");
const { buildOrderConfirmationText, orderConfirmationSubject } = require("./orderEmail");

const CART_HOLD_TTL_MINUTES = 60;

// How long after an order was created we keep asking HelloAsso whether an
// order we already expired/cancelled locally was paid after all.
const LATE_PAYMENT_WINDOW_DAYS = 7;

async function expireStaleCartHolds(pool) {
  // Orders are discovered through BOTH kinds of hold: an abandoned
  // checkout containing only a drop-in seat has no book copy to find it by.
  const { rows: stale } = await pool.query(
    `SELECT DISTINCT order_id FROM (
       SELECT cart_order_id AS order_id FROM book_copies
       WHERE status = 'in_cart' AND cart_added_at < now() - interval '${CART_HOLD_TTL_MINUTES} minutes'
       UNION ALL
       SELECT order_id FROM class_dropin_seats
       WHERE status = 'in_cart' AND order_id IS NOT NULL
         AND cart_added_at < now() - interval '${CART_HOLD_TTL_MINUTES} minutes'
     ) s`
  );
  // One order that always fails to release (bad data, a constraint) must
  // not stop every other stale hold from expiring on every run: isolate
  // each order, keep going, and alert once at the end.
  const failed = [];
  for (const { order_id } of stale) {
    try {
      // Via module.exports so tests can substitute the release step.
      await module.exports.releaseCartHold(pool, order_id, "expired");
    } catch (err) {
      failed.push(order_id);
      console.error(`Cart hold expiry failed for order ${order_id}:`, err.message);
    }
  }
  if (failed.length > 0) {
    await alertOnError(
      "Cart hold expiry failing for some orders",
      `Could not release the expired cart hold for order(s): ${failed.join(", ")}. Other holds were released normally; these will be retried on the next sweep.`
    );
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
    // Marked 'released', not deleted: order_items.class_dropin_seat_id
    // references the seat row (no ON DELETE action), so deleting it threw
    // a foreign-key error that rolled back this whole release. A released
    // seat no longer counts toward capacity (see lib/classCapacity.js) or
    // shows on the roster, and the expired order keeps its line items.
    await client.query(
      `UPDATE class_dropin_seats SET status = 'released', updated_at = now() WHERE order_id = $1 AND status = 'in_cart'`,
      [orderId]
    );
    await client.query(`UPDATE orders SET status = $1, client_ip = NULL WHERE id = $2 AND status = 'pending'`, [status, orderId]);
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

// Resolves true if THIS call flipped the order to paid, false if it was no
// longer 'pending' (another caller won, or it was expired/cancelled since
// the caller's snapshot was read).
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
      "UPDATE orders SET status = 'paid', paid_at = now(), client_ip = NULL WHERE id = $1 AND status = 'pending'",
      [order.id]
    );
    if (rowCount === 0) return false;
    await markCopiesSold(client, order.id);
    return true;
  });
  if (!won) return false;

  await sendOrderConfirmation(pool, order);
  return true;
}

async function sendOrderConfirmation(pool, order) {
  const { rows: items } = await pool.query("SELECT item_title, price FROM order_items WHERE order_id = $1", [order.id]);
  const base = process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL;
  // Subject and body follow order.lang ('en' | 'fr' | null; null is English).
  sendMail({
    to: order.buyer_email,
    subject: orderConfirmationSubject(order.lang),
    text: buildOrderConfirmationText(order, items, base),
  }).catch((err) => console.error(`Order confirmation email failed for order ${order.id}:`, err.message));
}

// The single source of truth for "did this order get paid" — re-checks
// with HelloAsso's own API rather than trusting a webhook payload or the
// return-URL's code=succeeded param, both of which HelloAsso's docs say
// aren't reliable enough to act on directly. Safe to call more than once
// (markOrderPaid/releaseCartHold only touch orders still 'pending').
//
// LATE PAYMENTS: an order we already closed locally ('expired' by the
// 60-minute hold, or 'cancelled') can still turn out to have been paid —
// HelloAsso's own checkout outlives our hold, and a crash between
// createCheckoutIntent and saving its id (see persistCheckoutIntentId)
// leaves an order that expires with no intent recorded. So for up to
// LATE_PAYMENT_WINDOW_DAYS after creation, closed orders that have an
// intent id are re-checked too; if HelloAsso says paid, see
// recoverLatePayment for the (deliberately conservative) policy.
function isRecentlyClosed(order) {
  return (
    (order.status === "expired" || order.status === "cancelled") &&
    !!order.checkout_intent_id &&
    !order.helloasso_order_id && // set once we've recovered OR flagged it — never handle twice
    Date.now() - new Date(order.created_at).getTime() < LATE_PAYMENT_WINDOW_DAYS * 24 * 3600 * 1000
  );
}

// An expired/cancelled order was actually paid. Under one transaction with
// row locks, re-claim every copy/seat the order covers and mark it paid —
// all or nothing. If ANY item can no longer be claimed (resold to someone
// else, reserved in-shop, drop-in seat gone), nothing is applied: we
// can't fulfil the order as bought, and partially fulfilling money-taken
// orders is worse than a human deciding. The admin gets an email naming
// the order, buyer and amount to refund/handle by hand. No new order
// status is introduced; instead helloasso_order_id doubles as the
// "already handled" marker on a closed order (it's otherwise only ever
// set together with status 'paid'), so neither the sweep nor webhook
// retries re-alert or re-process the same order.
async function recoverLatePayment(pool, order, intent) {
  const marker = String((intent.order && intent.order.id) || `intent-${order.checkout_intent_id}`);

  const result = await withTransaction(pool, async (client) => {
    const { rows: locked } = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [order.id]);
    const current = locked[0];
    if (!current || !isRecentlyClosed(current)) return { outcome: "skip", status: current ? current.status : null };

    const { rows: items } = await client.query(
      "SELECT book_copy_id, class_dropin_seat_id, item_title FROM order_items WHERE order_id = $1",
      [order.id]
    );
    const copyIds = items.filter((i) => i.book_copy_id != null).map((i) => i.book_copy_id);
    const seatIds = items.filter((i) => i.class_dropin_seat_id != null).map((i) => i.class_dropin_seat_id);

    const { rows: copies } = await client.query(
      "SELECT id, status, cart_order_id FROM book_copies WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE",
      [copyIds]
    );
    const { rows: seats } = await client.query(
      // Only a seat still held ('in_cart') can be claimed. A 'released' one
      // (the hold expired) has already been given back to the session's
      // capacity, so reclaiming it could oversell — it counts as unavailable
      // and the admin is alerted to refund instead.
      "SELECT id FROM class_dropin_seats WHERE id = ANY($1::int[]) AND order_id = $2 AND status = 'in_cart' ORDER BY id FOR UPDATE",
      [seatIds, order.id]
    );
    const copyOk = new Set(
      copies.filter((c) => c.status === "in_stock" || (c.status === "in_cart" && c.cart_order_id === order.id)).map((c) => c.id)
    );
    const seatOk = new Set(seats.map((s) => s.id));
    const unavailable = items.filter((i) =>
      i.book_copy_id != null ? !copyOk.has(i.book_copy_id) : !seatOk.has(i.class_dropin_seat_id)
    );

    if (items.length === 0 || unavailable.length > 0) {
      await client.query("UPDATE orders SET helloasso_order_id = $1 WHERE id = $2", [marker, order.id]);
      return { outcome: "conflict", unavailable: unavailable.map((i) => i.item_title), order: current };
    }

    await client.query(
      `UPDATE book_copies SET status = 'sold', cart_order_id = NULL, cart_added_at = NULL, updated_at = now()
       WHERE id = ANY($1::int[])`,
      [copyIds]
    );
    await client.query(
      "UPDATE class_dropin_seats SET status = 'sold', updated_at = now() WHERE id = ANY($1::int[])",
      [seatIds]
    );
    await client.query(
      "UPDATE orders SET status = 'paid', paid_at = now(), helloasso_order_id = $1, client_ip = NULL WHERE id = $2",
      [marker, order.id]
    );
    return { outcome: "recovered", order: current };
  });

  if (result.outcome === "recovered") {
    console.warn(`Late payment recovered: order ${order.id} (was ${order.status}) is now paid.`);
    await sendOrderConfirmation(pool, result.order);
    return "paid";
  }
  if (result.outcome === "conflict") {
    const o = result.order;
    const msg =
      `Order ${o.id} was ${o.status} locally but HelloAsso shows it PAID (checkout intent ${o.checkout_intent_id}), ` +
      `and these items can no longer be claimed: ${result.unavailable.join("; ") || "(order has no items)"}. ` +
      `Nothing was changed. Buyer: ${o.buyer_name} <${o.buyer_email}>, amount: €${Number(o.total_amount).toFixed(2)}. ` +
      `Please refund or fulfil this order manually in HelloAsso.`;
    console.error(`LATE PAYMENT CONFLICT: ${msg}`);
    await alertOnError(`Paid order ${o.id} could not be fulfilled — manual refund needed`, msg, { force: true });
    return o.status;
  }
  return result.status || order.status;
}

// opts.failFast: rethrow a systemic HelloAsso failure (auth/network, see
// isSystemicHelloAssoError) instead of swallowing it per order, so a sweep
// can stop instead of trying every remaining order against a dead API.
async function reconcileOrder(pool, order, { failFast = false } = {}) {
  if (!order) return null;
  const closed = isRecentlyClosed(order);
  if ((order.status !== "pending" && !closed) || !order.checkout_intent_id) return order.status;

  let intent;
  try {
    intent = await getCheckoutIntent(order.checkout_intent_id);
  } catch (err) {
    console.error(`HelloAsso lookup failed for order ${order.id}:`, err.message);
    if (failFast && isSystemicHelloAssoError(err)) throw err;
    return order.status; // transient API error — leave as is, a later pass will retry
  }

  if (closed) {
    // Only a confirmed payment matters for an already-closed order; a
    // still-unpaid/failed intent changes nothing (holds are already released).
    return isOrderPaid(intent) ? recoverLatePayment(pool, order, intent) : order.status;
  }

  if (isOrderPaid(intent)) {
    const won = await markOrderPaid(pool, order);
    if (won) {
      if (intent.order && intent.order.id) {
        await pool.query("UPDATE orders SET helloasso_order_id = $1 WHERE id = $2", [String(intent.order.id), order.id]);
      }
      return "paid";
    }
    // We lost: our snapshot said 'pending' but the row moved on (e.g. the
    // hold-expiry sweep expired it while we were asking HelloAsso). Never
    // report/stamp 'paid' on the strength of the stale snapshot - that
    // would also hide the order from isRecentlyClosed forever.
    const { rows: fresh } = await pool.query("SELECT * FROM orders WHERE id = $1", [order.id]);
    const current = fresh[0];
    if (!current) return order.status;
    if (current.status === "paid") return "paid"; // another caller won
    if (isRecentlyClosed(current)) return recoverLatePayment(pool, current, intent);
    return current.status;
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
//
// `includeClosed` also re-checks orders expired/cancelled in the last
// LATE_PAYMENT_WINDOW_DAYS (see "LATE PAYMENTS" above). That's one
// HelloAsso call per such order, and abandoned carts are the common case,
// so index.js only turns it on once an hour rather than every 10 minutes.
function isSystemicHelloAssoError(err) {
  return !!err && (err.kind === "auth" || err.kind === "network");
}

// Consecutive sweeps that hit a systemic HelloAsso failure; reset by any
// sweep that gets through without one.
let helloassoFailureStreak = 0;
const getHelloAssoFailureStreak = () => helloassoFailureStreak;
const resetHelloAssoFailureStreak = () => { helloassoFailureStreak = 0; };
const FAILURE_ALERT_EVERY = 6; // ~hourly at the 10-minute cadence

async function reconcilePendingOrders(pool, { includeClosed = true } = {}) {
  const { rows: pending } = await pool.query(
    `SELECT * FROM orders WHERE checkout_intent_id IS NOT NULL AND (
       (status = 'pending' AND created_at < now() - interval '20 minutes')
       OR ($1::boolean AND status IN ('expired', 'cancelled') AND helloasso_order_id IS NULL
           AND created_at > now() - interval '${LATE_PAYMENT_WINDOW_DAYS} days')
     ) ORDER BY id`,
    [includeClosed]
  );
  let systemicError = null;
  for (const order of pending) {
    try {
      await reconcileOrder(pool, order, { failFast: true });
    } catch (err) {
      if (isSystemicHelloAssoError(err)) {
        // HelloAsso is unreachable or rejecting our credentials: every
        // remaining order would burn its own 10 s timeout for nothing.
        systemicError = err;
        break;
      }
      console.error(`Order reconciliation failed for order ${order.id}:`, err.message);
    }
  }
  if (!systemicError) {
    helloassoFailureStreak = 0;
    return;
  }
  helloassoFailureStreak++;
  console.error(`Order reconciliation stopped early (HelloAsso ${systemicError.kind} failure, run ${helloassoFailureStreak} in a row).`);
  // Mention the first failure, then only every FAILURE_ALERT_EVERY-th run.
  if (helloassoFailureStreak === 1 || helloassoFailureStreak % FAILURE_ALERT_EVERY === 0) {
    await alertOnError(
      "HelloAsso reconciliation failing",
      `Order reconciliation stopped after a HelloAsso ${systemicError.kind} failure: ${systemicError.message}. ` +
        `${helloassoFailureStreak} consecutive run(s) have failed this way; pending payments are not being confirmed until it recovers.`
    );
  }
}

// The 10-minute cart job: the two sweeps run one after the other (never
// concurrently) so the expiry sweep cannot release an order out from under
// a reconcile that is about to mark it paid.
async function runCartMaintenance(pool, { includeClosed }) {
  try {
    await module.exports.expireStaleCartHolds(pool);
  } catch (err) {
    console.error("Cart hold expiry failed:", err);
  }
  try {
    await module.exports.reconcilePendingOrders(pool, { includeClosed });
  } catch (err) {
    console.error("Order reconciliation failed:", err);
  }
}

// Checkout (routes/cart.js) creates the HelloAsso intent first and only
// then can record its id on our order. If the process dies or the DB
// blips in between, the buyer can still pay, but nothing links the
// payment back to the order. So: retry the write once, and if it still
// fails, log + alert the admin with both ids (the intent id is the only
// thing that can reunite the two). Never throws — the buyer should still
// be sent to pay; adoptCheckoutIntent (called from the webhook) can also
// repair the link later. Returns true if the id was saved.
async function persistCheckoutIntentId(pool, orderId, intentId, { retryDelayMs = 250 } = {}) {
  const sql = "UPDATE orders SET checkout_intent_id = $1 WHERE id = $2";
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await pool.query(sql, [String(intentId), orderId]);
      return true;
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  const msg =
    `Could not save HelloAsso checkout intent ${intentId} on local order ${orderId} ` +
    `(${lastErr.message}). The buyer may still pay; if a payment arrives, match intent ${intentId} to order ${orderId} manually ` +
    `(UPDATE orders SET checkout_intent_id = '${intentId}' WHERE id = ${orderId}).`;
  console.error(msg);
  await alertOnError(`Checkout intent not saved for order ${orderId}`, msg, { force: true });
  return false;
}

// For a webhook that names an order which has no intent id recorded (the
// gap persistCheckoutIntentId guards): the notification body is never
// trusted, so the intent id it carries is only adopted after HelloAsso's
// own API confirms that intent's metadata.orderId is this very order.
async function adoptCheckoutIntent(pool, order, intentId) {
  if (!order || order.checkout_intent_id || !intentId) return order;
  let intent;
  try {
    intent = await getCheckoutIntent(intentId);
  } catch (err) {
    console.error(`HelloAsso lookup failed adopting intent ${intentId} for order ${order.id}:`, err.message);
    return order;
  }
  const meta = (intent && (intent.metadata || (intent.order && intent.order.metadata))) || {};
  if (Number(meta.orderId) !== order.id) return order;
  const { rows } = await pool.query(
    "UPDATE orders SET checkout_intent_id = $1 WHERE id = $2 AND checkout_intent_id IS NULL RETURNING *",
    [String(intentId), order.id]
  );
  return rows[0] || order;
}

module.exports = { runCartMaintenance, isRecentlyClosed, getHelloAssoFailureStreak, resetHelloAssoFailureStreak, persistCheckoutIntentId, adoptCheckoutIntent, expireStaleCartHolds, releaseCartHold, markOrderPaid, reconcileOrder, reconcilePendingOrders, CART_HOLD_TTL_MINUTES };
