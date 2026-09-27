const express = require("express");
const { pool } = require("../db");
const { reconcileOrder } = require("../lib/cart");
const { syncMembershipForEmail } = require("../lib/membership");

const router = express.Router();

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
router.post("/webhooks/helloasso", express.json(), async (req, res) => {
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
    await reconcileOrder(pool, order);
  } catch (err) {
    console.error("HelloAsso webhook handling failed:", err.message);
  }
});

module.exports = router;
