const express = require("express");
const { pool } = require("../db");
const helloasso = require("../lib/helloasso");
const { releaseCartHold, reconcileOrder } = require("../lib/cart");
const { expireStaleReservations } = require("../lib/reservations");

const router = express.Router();

// Public — no login required (matches /books). The cart itself is just
// a list of copy ids in the session; nothing is locked in the database
// until checkout actually starts (see src/lib/cart.js for why).

function baseUrl(req) {
  return process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get("host")}`;
}

function getCart(req) {
  if (!Array.isArray(req.session.cart)) req.session.cart = [];
  return req.session.cart;
}

async function loadCartCopies(cart) {
  if (!cart.length) return [];
  const { rows } = await pool.query(
    `SELECT c.id, c.price, c.condition, b.title, b.authors, b.cover_url
     FROM book_copies c JOIN books b ON b.id = c.book_id
     WHERE c.id = ANY($1::int[]) AND c.status = 'in_stock'
     ORDER BY c.id ASC`,
    [cart]
  );
  return rows;
}

router.get("/cart", async (req, res) => {
  await expireStaleReservations(pool);
  const cart = getCart(req);
  const copies = await loadCartCopies(cart);
  // Drop anything that's no longer actually available (someone else
  // bought/reserved it while it sat in this cart) so the total shown
  // always matches what checkout would actually charge.
  req.session.cart = copies.map((c) => c.id);
  const total = copies.reduce((sum, c) => sum + Number(c.price || 0), 0);
  res.render("cart", { copies, total, error: null, helloassoReady: helloasso.isConfigured() });
});

router.post("/cart/add", async (req, res) => {
  const copyId = Number(req.body.copyId);
  const backTo = req.body.backTo && req.body.backTo.startsWith("/") ? req.body.backTo : "/cart";
  if (copyId) {
    const { rows } = await pool.query("SELECT id FROM book_copies WHERE id = $1 AND status = 'in_stock'", [copyId]);
    if (rows.length) {
      const cart = getCart(req);
      if (!cart.includes(copyId)) cart.push(copyId);
    }
  }
  res.redirect(backTo);
});

router.post("/cart/remove", (req, res) => {
  const copyId = Number(req.body.copyId);
  const cart = getCart(req);
  req.session.cart = cart.filter((id) => id !== copyId);
  res.redirect("/cart");
});

router.post("/cart/checkout", async (req, res) => {
  const cart = getCart(req);
  const name = (req.body.name || "").trim();
  const email = (req.body.email || "").trim().toLowerCase();
  const phone = (req.body.phone || "").trim() || null;

  const copies = await loadCartCopies(cart);
  req.session.cart = copies.map((c) => c.id);

  if (!copies.length) {
    return res.render("cart", { copies: [], total: 0, error: "Your cart is empty.", helloassoReady: helloasso.isConfigured() });
  }
  if (!name || !email) {
    const total = copies.reduce((sum, c) => sum + Number(c.price || 0), 0);
    return res.render("cart", { copies, total, error: "Name and email are required.", helloassoReady: helloasso.isConfigured() });
  }
  if (!helloasso.isConfigured()) {
    const total = copies.reduce((sum, c) => sum + Number(c.price || 0), 0);
    return res.render("cart", {
      copies, total, helloassoReady: false,
      error: "Online payment isn't set up yet — please check back soon, or come by the shop in person.",
    });
  }

  const total = copies.reduce((sum, c) => sum + Number(c.price || 0), 0);
  const client = await pool.connect();
  let order;
  try {
    await client.query("BEGIN");
    const { rows: orderRows } = await client.query(
      `INSERT INTO orders (buyer_name, buyer_email, buyer_phone, total_amount) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, email, phone, total]
    );
    order = orderRows[0];
    for (const c of copies) {
      await client.query(
        "INSERT INTO order_items (order_id, book_copy_id, book_title, price) VALUES ($1, $2, $3, $4)",
        [order.id, c.id, c.title, c.price]
      );
    }
    const { rows: locked } = await client.query(
      `UPDATE book_copies SET status = 'in_cart', cart_order_id = $1, cart_added_at = now(), updated_at = now()
       WHERE id = ANY($2::int[]) AND status = 'in_stock' RETURNING id`,
      [order.id, copies.map((c) => c.id)]
    );
    if (locked.length !== copies.length) {
      // Someone else bought/reserved a copy in the moment between our
      // read above and this write — bail out cleanly rather than charge
      // for fewer books than were actually locked.
      await client.query("ROLLBACK");
      const fresh = await loadCartCopies(cart);
      req.session.cart = fresh.map((c) => c.id);
      const freshTotal = fresh.reduce((sum, c) => sum + Number(c.price || 0), 0);
      return res.render("cart", {
        copies: fresh, total: freshTotal, helloassoReady: true,
        error: "Sorry, one of the books in your cart was just bought by someone else. Please review your cart and try again.",
      });
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Checkout failed to create order:", err.message);
    return res.render("cart", { copies, total, error: "Something went wrong starting checkout. Please try again.", helloassoReady: true });
  } finally {
    client.release();
  }

  const returnUrl = `${baseUrl(req)}/cart/return?order=${order.id}`;
  const [firstName, ...rest] = name.split(" ");
  const lastName = rest.join(" ") || ".";

  let intent;
  try {
    intent = await helloasso.createCheckoutIntent({
      amountCents: Math.round(total * 100),
      itemName: copies.map((c) => c.title).join(", ").slice(0, 250),
      backUrl: `${baseUrl(req)}/cart`,
      errorUrl: returnUrl,
      returnUrl,
      payer: { firstName, lastName, email },
      metadata: { orderId: order.id },
    });
  } catch (err) {
    console.error(`HelloAsso checkout-intent creation failed for order ${order.id}:`, err.message);
    await releaseCartHold(pool, order.id, "cancelled");
    return res.render("cart", {
      copies, total, helloassoReady: true,
      error: "Couldn't reach the payment provider right now. Please try again in a moment.",
    });
  }

  await pool.query("UPDATE orders SET checkout_intent_id = $1 WHERE id = $2", [String(intent.id), order.id]);
  req.session.cart = [];
  res.redirect(intent.redirectUrl);
});

router.get("/cart/return", async (req, res) => {
  const orderId = Number(req.query.order);
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [orderId]);
  const order = rows[0];
  if (!order) return res.status(404).render("404");

  const status = order.status === "pending" ? await reconcileOrder(pool, order) : order.status;

  const { rows: items } = await pool.query("SELECT book_title, price FROM order_items WHERE order_id = $1", [order.id]);
  res.render("cart_return", { order, items, status });
});

module.exports = router;
