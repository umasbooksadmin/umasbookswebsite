const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Book orders are a guest checkout flow (see src/routes/cart.js) and
// session sign-ups predate requiring login (see src/routes/sessions.js),
// so neither table has a user_id. The only link back to an account is
// the email address, matched case-insensitively since HelloAsso/browsers
// don't normalize case on what a buyer types in.
router.get("/account", requireAuth, async (req, res) => {
  const email = req.session.user.email;

  const [{ rows: orders }, { rows: signups }] = await Promise.all([
    pool.query(
      `SELECT o.*, (
         SELECT json_agg(json_build_object('title', i.book_title, 'price', i.price) ORDER BY i.id)
         FROM order_items i WHERE i.order_id = o.id
       ) AS items
       FROM orders o
       WHERE lower(o.buyer_email) = lower($1)
       ORDER BY o.created_at DESC`,
      [email]
    ),
    pool.query(
      `SELECT s.id, s.created_at, c.title, c.starts_at, c.location
       FROM class_signups s JOIN classes c ON c.id = s.class_id
       WHERE lower(s.email) = lower($1)
       ORDER BY c.starts_at DESC`,
      [email]
    ),
  ]);

  res.render("account", { orders, signups });
});

module.exports = router;
