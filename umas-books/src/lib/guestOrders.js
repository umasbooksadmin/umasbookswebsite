// Reserving WITHOUT an account (approved 2026-10-28). A signed-out visitor gives a
// name, an email and optionally a phone (routes/cart.js, GET/POST /cart/guest); the
// reservation is the same as an account holder's (lib/cart.js createReservation:
// same order row, same held copies and seats, same expiry, collection, refund,
// accounting), with orders.user_id NULL and orders.is_guest TRUE, and:
//
//   1. The books are held at once, but only for GUEST_CONFIRM_HOURS (2 h): the
//      email carries a CONFIRM link. Opened in time (GET shows a button, the POST
//      confirms: mail scanners that open links must not confirm), the usual hold
//      applies (RESERVATION_DAYS for books, until the session for seats) and the
//      full confirmation is sent. Never opened, the usual expiry
//      (lib/reservations.js expireOrderReservations) releases it, with the reason
//      'unconfirmed' (no "your reservation has ended" email to an unconfirmed
//      address).
//   2. Both emails carry a MANAGE link: view and cancel without an account. Cancel
//      is lib/reservations.js cancelReservationAsGuest (the customer cancel).
//   3. Tokens: 32 random bytes (hex), only their SHA-256 stored
//      (guest_order_tokens), one purpose each ('confirm': single use, expires with
//      the 2-hour hold; 'manage': expires MANAGE_DAYS after the hold's deadline).
//      Both emails are TOKEN_KINDS in lib/outbox.js: their body is blanked once
//      sent, so a raw link never stays in the database.
//   4. Limits per EMAIL (lower-cased), over every open guest reservation of that
//      address, confirmed or not: MAX_RESERVED_COPIES books, MAX_ACTIVE_RESERVATIONS
//      reservations (lib/cart.js), on top of the per-IP limits and CSRF of the routes.
//      The first email is a THROTTLED kind (anyone can type any address).
//   4b. Limits on holds nobody has confirmed yet (anonymous, so abusable): at most
//      GUEST_HOLD_MAX_COPIES copies held shop-wide, and GUEST_HOLD_MAX_PER_IP unconfirmed
//      holds per connection (orders.client_ip, a /56-bucketed IP, emptied when the hold is
//      confirmed or released). Refused with GUEST_HOLDS_FULL / GUEST_IP_HOLDS; the first
//      raises one admin alert an hour. The shop-wide cap on first mails (outbox.js) also
//      raises one (MAIL_THROTTLED with reason 'global'). A confirmed hold is never counted.
//   5. A later account with the same email gets these orders attached
//      (attachGuestOrders), ONLY once that account's email is confirmed.

const { generateToken, hashToken } = require("./resetTokens");
const { enqueueEmail, enqueueThrottled, deliverNow } = require("./outbox");
const { loadOrderItems } = require("./orderItems");
const { buildGuestConfirmEmail, buildOrderConfirmationText, orderConfirmationSubject } = require("./orderEmail");
const { SITE_TIME_ZONE } = require("./tz");
const legal = require("./legal");
const { RESERVATION_DAYS, SESSION_OVER_SQL, cancelReservationAsGuest } = require("./reservations");
const { claimAlertSlot, releaseAlertSlot } = require("./alertFlags");
const { sendAdminAlert } = require("./errorAlert");

const GUEST_CONFIRM_HOURS = legal.GUEST_CONFIRM_HOURS;
// A manage link keeps working this many days after the reservation's deadline (to see how it ended).
const MANAGE_DAYS = 30;
const TOKEN_RE = /^[a-f0-9]{64}$/;

// Caps on UNCONFIRMED holds (see 4b). Mutable only for tests (setHoldLimits).
const holdLimits = { maxCopies: legal.GUEST_HOLD_MAX_COPIES, maxPerIp: legal.GUEST_HOLD_MAX_PER_IP };
function setHoldLimits(next) {
  const before = { ...holdLimits };
  Object.assign(holdLimits, next);
  return () => Object.assign(holdLimits, before);
}
const ALERT_EVERY_MINUTES = 60;

const lazyDb = () => require("../db");

// Inside the reservation transaction, after the per-email limits: throws GUEST_IP_HOLDS or GUEST_HOLDS_FULL.
// A shop-wide advisory lock makes the count race-free (guest reservations only; account holders never take it).
async function assertGuestHoldCapacity(client, { ip, copies }) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('reserve-guest-global'))");
  if (ip) {
    const { rows: [m] } = await client.query(
      "SELECT count(*)::int AS n FROM orders WHERE is_guest AND status = 'reserved' AND guest_confirmed_at IS NULL AND client_ip = $1", [ip]);
    if (m.n >= holdLimits.maxPerIp) throw new Error("GUEST_IP_HOLDS");
  }
  const { rows: [t] } = await client.query(
    `SELECT count(*)::int AS n FROM book_copies c JOIN orders o ON o.id = c.cart_order_id
     WHERE o.is_guest AND o.status = 'reserved' AND o.guest_confirmed_at IS NULL AND c.status = 'reserved'`);
  if (t.n + copies > holdLimits.maxCopies) throw new Error("GUEST_HOLDS_FULL");
}

// One admin alert an hour (alert_flags, across restarts and instances) when a shop-wide guest limit refuses someone.
// `which`: 'holds' (the unconfirmed-copies ceiling) or 'mail' (the shop-wide first-mail cap). Never throws; no personal data.
async function alertGuestLimit(pool, which) {
  const key = `guest_limit_${which}`;
  try {
    if (!(await claimAlertSlot(pool, key, ALERT_EVERY_MINUTES))) return false;
    const text = which === "holds"
      ? `The ceiling on guest reservations nobody has confirmed yet was reached (${holdLimits.maxCopies} copies held at once). New guest reservations are refused until some are confirmed or released (after ${GUEST_CONFIRM_HOURS} hours). If nobody real is waiting, someone is probably spamming the guest form: look at Admin > Orders for many unconfirmed guest holds.`
      : "The shop-wide cap on first guest-reservation emails per hour was reached, so new guest reservations are refused for a while. Confirmations and other emails are not affected. If this is not a busy day, someone is probably spamming the guest form (see the 'Mail throttled' lines in the logs).";
    const sent = await sendAdminAlert({ subject: "[umas-books] Guest reservation limit reached", text });
    if (!sent) await releaseAlertSlot(pool, key);
    return sent;
  } catch (err) {
    console.error("Guest limit alert failed:", err.message);
    return false;
  }
}

const confirmUrl = (base, token) => `${base}/cart/guest/confirm/${token}`;
const manageUrl = (base, token) => `${base}/cart/guest/manage/${token}`;

async function mintToken(db, orderId, purpose, expiresSql) {
  const raw = generateToken();
  await db.query(
    `INSERT INTO guest_order_tokens (order_id, purpose, token_hash, expires_at) VALUES ($1, $2, $3, ${expiresSql})`,
    [orderId, purpose, hashToken(raw)]
  );
  return raw;
}

const mintManageToken = (db, order) =>
  mintToken(db, order.id, "manage", `GREATEST(now(), (SELECT reserved_until FROM orders WHERE id = $1)) + interval '${MANAGE_DAYS} days'`);

// Inside the reservation transaction (lib/cart.js), right after the order and its
// items exist: the 2-hour deadline, the two tokens and the first email (throttled
// per address; a refused mail throws MAIL_THROTTLED, which rolls the whole
// reservation back: no hold without its link). Returns the outbox id.
async function startGuestHold(client, order, base) {
  await client.query(
    `UPDATE orders SET reserved_until = LEAST(COALESCE(reserved_until, 'infinity'::timestamptz), now() + make_interval(hours => $2))
     WHERE id = $1`,
    [order.id, GUEST_CONFIRM_HOURS]
  );
  const confirm = await mintToken(client, order.id, "confirm", `now() + make_interval(hours => ${GUEST_CONFIRM_HOURS})`);
  const manage = await mintManageToken(client, order);
  const { rows } = await client.query("SELECT * FROM orders WHERE id = $1", [order.id]);
  const items = await loadOrderItems(client, order.id);
  const mail = buildGuestConfirmEmail(rows[0], items, { confirmUrl: confirmUrl(base, confirm), manageUrl: manageUrl(base, manage) });
  const r = await enqueueThrottled(client, { kind: "guest_reservation", lang: rows[0].lang, relatedOrderId: order.id, to: rows[0].buyer_email, ...mail }, { mode: "skipInterval" });
  if (r.throttled) throw Object.assign(new Error("MAIL_THROTTLED"), { reason: r.throttled });
  return r.id;
}

// The deadline a guest reservation gets once confirmed: the one an account holder's
// reservation made at the same moment has (lib/cart.js), counted from its creation.
const CONFIRMED_DEADLINE_SQL = `CASE
  WHEN EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.book_copy_id IS NOT NULL)
    THEN (((o.created_at AT TIME ZONE '${SITE_TIME_ZONE}')::date + ${RESERVATION_DAYS} + 1)::timestamp AT TIME ZONE '${SITE_TIME_ZONE}')
  ELSE (SELECT MAX(${SESSION_OVER_SQL}) FROM class_dropin_seats s JOIN classes c ON c.id = s.class_id WHERE s.order_id = o.id)
END`;

// What a confirm link is, without using it (the GET page):
//   { state: 'ask', order } | { state: 'invalid' | 'used' | 'expired' }
async function peekConfirmToken(pool, raw) {
  if (!TOKEN_RE.test(String(raw || ""))) return { state: "invalid" };
  const { rows } = await pool.query(
    `SELECT t.used_at, t.expires_at > now() AS live, o.id, o.status
     FROM guest_order_tokens t JOIN orders o ON o.id = t.order_id
     WHERE t.token_hash = $1 AND t.purpose = 'confirm'`,
    [hashToken(raw)]
  );
  const t = rows[0];
  if (!t) return { state: "invalid" };
  if (t.used_at) return { state: "used" };
  if (!t.live || t.status !== "reserved") return { state: "expired" };
  return { state: "ask", orderId: t.id };
}

// The POST of the confirm page. One transaction: the token is claimed atomically
// (of concurrent clicks exactly one wins), the order locked, the deadline set, a
// manage link minted and the full confirmation queued (sent after the commit).
// Resolves { outcome: 'confirmed', order, manageToken } | { outcome: 'invalid' | 'used' | 'expired' }.
async function confirmGuestOrder(pool, raw, base) {
  if (!TOKEN_RE.test(String(raw || ""))) return { outcome: "invalid" };
  const { withTransaction } = lazyDb();
  const result = await withTransaction(pool, async (client) => {
    const { rows: claimed } = await client.query(
      `UPDATE guest_order_tokens SET used_at = now()
       WHERE token_hash = $1 AND purpose = 'confirm' AND used_at IS NULL AND expires_at > now() RETURNING order_id`,
      [hashToken(raw)]
    );
    if (!claimed.length) return null;
    const { rows } = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [claimed[0].order_id]);
    const order = rows[0];
    // Released meanwhile (the 2 hours passed a moment ago, or the guest cancelled with the manage link).
    if (!order || order.status !== "reserved") return { outcome: "expired" };
    if (order.guest_confirmed_at) return { outcome: "used" };
    const { rows: upd } = await client.query(
      `UPDATE orders o SET guest_confirmed_at = now(), client_ip = NULL, reserved_until = ${CONFIRMED_DEADLINE_SQL} WHERE o.id = $1 RETURNING o.*`,
      [order.id]
    );
    const manageToken = await mintManageToken(client, upd[0]);
    const mailId = await queueConfirmedMail(client, upd[0], base, manageToken);
    return { outcome: "confirmed", order: upd[0], manageToken, mailId };
  });
  if (!result) {
    // Not claimable: say why (the token is already used, or it expired), never more.
    const peek = await peekConfirmToken(pool, raw);
    return { outcome: peek.state === "ask" ? "invalid" : peek.state };
  }
  if (result.mailId) await deliverNow(pool, result.mailId);
  return result;
}

// The full reservation confirmation (the account holder's text) with the manage link.
async function queueConfirmedMail(db, order, base, manageToken) {
  const items = await loadOrderItems(db, order.id);
  return enqueueEmail(db, {
    kind: "guest_reservation_confirmed",
    lang: order.lang,
    relatedOrderId: order.id,
    to: order.buyer_email,
    subject: orderConfirmationSubject(order.lang),
    text: buildOrderConfirmationText(order, items, base, { manageUrl: manageUrl(base, manageToken) }),
  });
}

// The order behind a live manage link, or null (unknown, expired, wrong purpose).
async function orderForManageToken(db, raw) {
  if (!TOKEN_RE.test(String(raw || ""))) return null;
  const { rows } = await db.query(
    `SELECT o.* FROM guest_order_tokens t JOIN orders o ON o.id = t.order_id
     WHERE t.token_hash = $1 AND t.purpose = 'manage' AND t.expires_at > now()`,
    [hashToken(raw)]
  );
  return rows[0] || null;
}

// "Cancel reservation" on the manage page: the customer cancel, for this link's order only.
// Resolves the release outcome ('released' | 'too_late' | 'not_reserved') or { outcome: 'not_found' }.
async function cancelWithManageToken(pool, raw) {
  const order = await orderForManageToken(pool, raw);
  if (!order) return { outcome: "not_found" };
  return cancelReservationAsGuest(pool, order.id);
}

// Admin "Resend confirmation" for a guest order: fresh links (the old ones keep working until they expire). Unconfirmed:
// the first email again (a new confirm link valid until the hold's deadline); confirmed: the full confirmation.
// Returns the outbox id.
async function queueGuestResend(db, order, base) {
  const manage = await mintManageToken(db, order);
  if (order.guest_confirmed_at) return queueConfirmedMail(db, order, base, manage);
  const confirm = await mintToken(db, order.id, "confirm", "GREATEST(now(), (SELECT reserved_until FROM orders WHERE id = $1))");
  const items = await loadOrderItems(db, order.id);
  const mail = buildGuestConfirmEmail(order, items, { confirmUrl: confirmUrl(base, confirm), manageUrl: manageUrl(base, manage) });
  return enqueueEmail(db, { kind: "guest_reservation", lang: order.lang, relatedOrderId: order.id, to: order.buyer_email, ...mail });
}

// Attach every guest order of this account's email to it, ONLY when the account's
// email is confirmed (and the account is not disabled). Called where an email gets
// confirmed (routes/auth.js: the email link, a completed password reset) and at
// every login (an address confirmed earlier). An order already attached to an account
// is never moved. Resolves the number attached.
async function attachGuestOrders(db, userId) {
  const r = await db.query(
    `UPDATE orders o SET user_id = u.id
     FROM users u
     WHERE u.id = $1 AND u.email_verified_at IS NOT NULL AND NOT u.is_disabled
       AND o.is_guest AND o.user_id IS NULL AND lower(o.buyer_email) = lower(u.email)
     RETURNING o.id`,
    [userId]
  );
  // The order is now managed from the account (cancel, collect): the emailed no-account link must stop working
  // (a forwarded or leaked mail could otherwise still cancel it). The confirm link is left: an unconfirmed hold
  // can still be confirmed from its mail, and it is single use.
  if (r.rowCount) {
    await db.query(
      "UPDATE guest_order_tokens SET expires_at = now() WHERE purpose = 'manage' AND expires_at > now() AND order_id = ANY($1::int[])",
      [r.rows.map((x) => x.id)]
    );
  }
  return r.rowCount;
}

module.exports = {
  startGuestHold, assertGuestHoldCapacity, alertGuestLimit, setHoldLimits, peekConfirmToken, confirmGuestOrder, orderForManageToken, cancelWithManageToken, queueGuestResend,
  attachGuestOrders, confirmUrl, manageUrl, GUEST_CONFIRM_HOURS, MANAGE_DAYS, TOKEN_RE,
};
