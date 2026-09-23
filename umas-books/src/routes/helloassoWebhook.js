const express = require("express");
const { pool } = require("../db");
const { reconcileOrder } = require("../lib/cart");

const router = express.Router();

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
      console.warn("HelloAsso webhook: couldn't match a local order to this notification:", JSON.stringify(body).slice(0, 500));
      return;
    }
    await reconcileOrder(pool, order);
  } catch (err) {
    console.error("HelloAsso webhook handling failed:", err.message);
  }
});

module.exports = router;
