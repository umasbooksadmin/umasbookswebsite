const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Orders (books and paid drop-in seats alike — see src/routes/cart.js)
// are a guest checkout flow, so the table has no user_id — the only
// link back to an account is the email address, matched
// case-insensitively since HelloAsso/browsers don't normalize case on
// what a buyer types in.
router.get("/account", requireAuth, async (req, res) => {
  const email = req.session.user.email;

  const { rows: orders } = await pool.query(
    `SELECT o.*, (
       SELECT json_agg(json_build_object('title', i.item_title, 'price', i.price) ORDER BY i.id)
       FROM order_items i WHERE i.order_id = o.id
     ) AS items
     FROM orders o
     WHERE lower(o.buyer_email) = lower($1)
     ORDER BY o.created_at DESC`,
    [email]
  );

  res.render("account", { orders });
});

module.exports = router;
