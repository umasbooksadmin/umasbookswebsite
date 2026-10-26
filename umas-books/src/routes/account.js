const express = require("express");
const { pool } = require("../db");
const { orderItemLabel, orderItemParts } = require("../lib/orderItems");
const { requireAuth } = require("../middleware/auth");
const { activeRequestsForUser } = require("../lib/bookRequests");
const { SEAT_CANCEL_HOURS } = require("../lib/legal");
const { reservationLastDay } = require("../lib/orderItems");

const router = express.Router();

// Reservations and orders (books and drop-in seats alike — see
// src/routes/cart.js) require an account, and orders.user_id records which
// one. Orders placed before that (guest checkout) have user_id NULL, so
// this page still finds those by the account's email address, matched
// case-insensitively since browsers don't normalize case on what a person
// types in. A reserved order is listed with its deadline and a
// "Cancel reservation" button (POST /cart/reservations/:id/cancel).
//
// Because that link is *only* the email address, the orders list is shown
// only once the account has proven it controls that address (email_verified_at,
// see migrations/032_email_verification.sql). Signup doesn't verify
// anything (an account can log in before it ever follows the emailed
// link), so without this check anyone could register a victim's email and read their order history. The email is read fresh from
// the users row (not the session copy, which goes stale after an admin
// edits it).
const NOTICES = {
  "reservation-cancelled": ["Your reservation was cancelled and its items are available again.", "Votre réservation a été annulée et ses articles sont de nouveau disponibles."],
  "reservation-too-late": ["A drop-in seat can only be cancelled online until {hours} hours before the session. Please contact the shop.", "Une place « drop-in » ne peut être annulée en ligne que jusqu’à {hours} heures avant la séance. Merci de contacter la boutique."],
  "reservation-not-open": ["That reservation is no longer open, so there was nothing to cancel.", "Cette réservation n’est plus en cours : il n’y avait rien à annuler."],
};

router.get("/account", requireAuth, async (req, res) => {
  const n = NOTICES[String(req.query.notice || "")];
  const notice = n ? req.tr(n[0], n[1], { hours: SEAT_CANCEL_HOURS }) : null;
  const { rows: userRows } = await pool.query("SELECT email, email_verified_at FROM users WHERE id = $1", [req.session.user.id]);
  const { email, email_verified_at: verifiedAt } = userRows[0];

  // Book requests (see routes/bookRequests.js): made while logged in, or under
  // the verified email address. Not a membership perk.
  const bookRequests = await activeRequestsForUser(pool, req.session.user.id);

  if (!verifiedAt) {
    return res.render("account", { orders: [], email, emailVerified: false, bookRequests, notice, lastDay: reservationLastDay });
  }

  const { rows: orders } = await pool.query(
    `SELECT o.*, (
       SELECT json_agg(json_build_object('title', i.item_title, 'price', i.price, 'classTitle', c.title, 'classTitleFr', c.title_fr, 'classStartsAt', c.starts_at, 'condition', bc.condition) ORDER BY i.id)
       FROM order_items i
       LEFT JOIN book_copies bc ON bc.id = i.book_copy_id
       LEFT JOIN class_dropin_seats s ON s.id = i.class_dropin_seat_id
       LEFT JOIN classes c ON c.id = s.class_id
       WHERE i.order_id = o.id
     ) AS items
     FROM orders o
     WHERE o.user_id = $2 OR (o.user_id IS NULL AND lower(o.buyer_email) = lower($1))
     ORDER BY o.created_at DESC`,
    [email, req.session.user.id]
  );

  for (const o of orders) o.items = (o.items || []).map((i) => ({ title: orderItemLabel(i, req.lang), ...orderItemParts(i, req.lang), price: i.price, isSeat: i.classStartsAt != null }));
  res.render("account", { orders, email, emailVerified: true, bookRequests, notice, lastDay: reservationLastDay });
});

module.exports = router;
