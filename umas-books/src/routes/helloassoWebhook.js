const express = require("express");
const rateLimit = require("express-rate-limit");
const { pool } = require("../db");
const { reconcileOrder, adoptCheckoutIntent } = require("../lib/cart");
const { syncMembershipForEmail } = require("../lib/membership");

const router = express.Router();

// This route has no signature to verify a call actually came from
// HelloAsso (see below), so its membership branch amounts to "anyone can
// ask us to re-check any email against HelloAsso's real API, as often as
// they like." findMembershipOrdersByEmail's exact-match check and
// syncMembershipForEmail's verified-email check (lib/helloasso.js,
// lib/membership.js) are what stop that from being able to misattribute
// anything — this is just a cap on how much of that re-checking one
// caller can force, since it costs a real outbound API call each time.
// Comfortably above anything a small shop's real transaction volume
// would ever hit.
const webhookLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// Looks up a dotted path across a couple of possible shapes: an "Order"
// event has formType directly under data, while a "Payment" event nests
// it under data.order instead — payer.email, though, sits at data.payer
// in both (see dev.helloasso.com's Order/Payment notification examples).
function pick(obj, paths) {
  for (const path of paths) {
    const value = path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (value != null) return value;
  }
  return undefined;
}

// HelloAsso calls this after Order/Payment events (configured from the
// organization's HelloAsso dashboard under Mon Compte > Intégrations et
// API, pointed at <this app's URL>/webhooks/helloasso). It's an external
// POST with no CSRF token, so this router is mounted before
// app.use(csrfProtection) in index.js rather than after with the rest of
// the app's routes.
//
// HelloAsso's docs don't publish the exact payload shape or a signature
// to verify it with, so this handler never trusts the body's content —
// it only uses it to find which of our orders to re-check, then asks
// HelloAsso's own API (with our own credentials) for the real payment
// state via reconcileOrder. That means a forged webhook call can, at
// worst, make us re-verify an order we'd have re-verified anyway on the
// periodic backstop (see reconcilePendingOrders in index.js) — it can
// never mark anything paid on its own.
//
// Same idea for the Membership branch below: the payer.email pulled from
// the body is never trusted directly either — syncMembershipForEmail
// re-asks HelloAsso's API for that email's real Authorized orders (now
// filtered to an exact payer-email match, not HelloAsso's own fuzzy
// userSearchKey — see lib/helloasso.js) and only ever applies them to a
// local account whose email is itself verified (lib/membership.js). A
// forged call here can, at worst, force an early re-check of one email
// against HelloAsso's real records — never attribute a payment to an
// account that hasn't proven it owns that email.
router.post("/webhooks/helloasso", webhookLimiter, express.json(), async (req, res) => {
  res.status(200).end(); // ack immediately — HelloAsso retries on non-200/timeout

  const body = req.body || {};
  const orderId = Number(
    (body.metadata && body.metadata.orderId) ||
    (body.data && body.data.metadata && body.data.metadata.orderId) ||
    body.orderId
  );
  const checkoutIntentId = String(
    body.checkoutIntentId || (body.data && body.data.checkoutIntentId) || body.id || ""
  );

  try {
    let order = null;
    if (orderId) {
      const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [orderId]);
      order = rows[0];
    } else if (checkoutIntentId) {
      const { rows } = await pool.query("SELECT * FROM orders WHERE checkout_intent_id = $1", [checkoutIntentId]);
      order = rows[0];
    }
    if (!order) {
      // Not one of our own shop/checkout orders — check whether it's a
      // payment on the HelloAsso-hosted membership form instead (those
      // aren't created through our API, so there's no local order row
      // to match in the first place).
      const formType = pick(body, ["data.formType", "data.order.formType"]);
      const payerEmail = pick(body, ["data.payer.email"]);
      if (formType === "Membership" && payerEmail) {
        await syncMembershipForEmail(pool, payerEmail);
      } else {
        console.warn("HelloAsso webhook: couldn't match a local order to this notification:", JSON.stringify(body).slice(0, 500));
      }
      return;
    }
    // The order can predate its intent id being saved (see
    // persistCheckoutIntentId in lib/cart.js); adopt it from the webhook
    // only if HelloAsso itself confirms the intent belongs to this order.
    if (!order.checkout_intent_id && checkoutIntentId) {
      order = await adoptCheckoutIntent(pool, order, checkoutIntentId);
    }
    // Also covers orders we already expired/cancelled but that were paid
    // late — reconcileOrder handles those (see "LATE PAYMENTS" there).
    await reconcileOrder(pool, order);
  } catch (err) {
    console.error("HelloAsso webhook handling failed:", err.message);
  }
});

// A body that express.json rejects (malformed JSON, a bare scalar like
// `null`, an oversized or unsupported-encoding payload) never reaches the
// handler above, so it used to fall through to the app's 500 handler — and
// HelloAsso, seeing a non-200, retries the identical body again and again.
// There is nothing to act on in such a body (the handler never trusts the
// body's content anyway), so acknowledge it and log it. Anything that is not
// a body-parser rejection still goes to the normal error handler.
router.use("/webhooks/helloasso", (err, req, res, next) => {
  const rejectedBody = err && (String(err.type || "").startsWith("entity.") || [400, 413, 415].includes(err.status));
  if (!rejectedBody || res.headersSent) return next(err);
  console.warn(
    `HelloAsso webhook: ignored an unreadable body (${err.type || err.status}):`,
    String(err.body || "").slice(0, 200)
  );
  res.status(200).end();
});

module.exports = router;
