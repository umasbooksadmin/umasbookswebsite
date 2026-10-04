const express = require("express");
const { pool } = require("../db");
const { orderItemLabel } = require("../lib/orderItems");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Orders (books and paid drop-in seats alike — see src/routes/cart.js)
// are a guest checkout flow, so the table has no user_id — the only
// link back to an account is the email address, matched
// case-insensitively since HelloAsso/browsers don't normalize case on
// what a buyer types in.
//
// Because that link is *only* the email address, the orders list is shown
// only once the account has proven it controls that address (email_verified_at,
// see migrations/032_email_verification.sql). Signup doesn't verify
// anything (an account can log in before it ever follows the emailed
// link), so without this check anyone could register a victim's email and read their order history. The email is read fresh from
// the users row (not the session copy, which goes stale after an admin
// edits it).
router.get("/account", requireAuth, async (req, res) => {
  const { rows: userRows } = await pool.query("SELECT email, email_verified_at FROM users WHERE id = $1", [req.session.user.id]);
  const { email, email_verified_at: verifiedAt } = userRows[0];

  if (!verifiedAt) {
    return res.render("account", { orders: [], email, emailVerified: false });
  }

  const { rows: orders } = await pool.query(
    `SELECT o.*, (
       SELECT json_agg(json_build_object('title', i.item_title, 'price', i.price, 'classTitle', c.title, 'classStartsAt', c.starts_at, 'condition', bc.condition) ORDER BY i.id)
       FROM order_items i
       LEFT JOIN book_copies bc ON bc.id = i.book_copy_id
       LEFT JOIN class_dropin_seats s ON s.id = i.class_dropin_seat_id
       LEFT JOIN classes c ON c.id = s.class_id
       WHERE i.order_id = o.id
     ) AS items
     FROM orders o
     WHERE lower(o.buyer_email) = lower($1)
     ORDER BY o.created_at DESC`,
    [email]
  );

  for (const o of orders) o.items = (o.items || []).map((i) => ({ title: orderItemLabel(i, req.lang), price: i.price }));
  res.render("account", { orders, email, emailVerified: true });
});

module.exports = router;
