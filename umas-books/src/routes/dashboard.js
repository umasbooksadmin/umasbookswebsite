const express = require("express");
const { pool } = require("../db");
const { requireMember } = require("../middleware/auth");

const router = express.Router();

router.get("/dashboard", requireMember, async (req, res) => {
  const userId = req.session.user.id;

  const [announcements, activeRound, latestArrivals, upcomingEvents] = await Promise.all([
    // Only actually-live announcements. 'scheduled' is included as long
    // as its published_at has actually passed — there's no periodic job
    // flipping it to 'published' at that moment, so the date check alone
    // is what makes it visible (see /admin/announcements, where the
    // Scheduled tab may still show it briefly after that, purely as a
    // cosmetic lag until an admin touches it). Not past its optional
    // expiration; pinned ones lead regardless of date.
    pool.query(
      `SELECT * FROM announcements
       WHERE status IN ('published', 'scheduled') AND published_at <= now() AND (expires_at IS NULL OR expires_at > now())
       ORDER BY is_pinned DESC, published_at DESC LIMIT 3`
    ),
    pool.query("SELECT * FROM charity_rounds WHERE is_active = TRUE ORDER BY opens_at DESC LIMIT 1"),
    // Same "newest in-stock copy first" pick as the marketing site's
    // /api/books/latest-arrivals — this page is server-rendered, so it's
    // queried directly here instead of round-tripping through that API.
    pool.query(
      `SELECT b.id, b.title, b.authors, b.cover_url,
              (SELECT MIN(price) FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock') AS min_price,
              (SELECT MAX(c.created_at) FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock') AS newest_copy_at
       FROM books b
       WHERE EXISTS (SELECT 1 FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock')
       ORDER BY newest_copy_at DESC LIMIT 8`
    ),
    pool.query("SELECT * FROM events WHERE starts_at >= now() ORDER BY starts_at ASC LIMIT 3"),
  ]);

  let charity = null;
  if (activeRound.rows.length) {
    const round = activeRound.rows[0];
    // COALESCEs from the charity library the same way /admin/charity and
    // /charity do — a library-linked option's name/description can change
    // after the round was set up, and this always reflects that.
    const options = await pool.query(
      `SELECT o.id, COALESCE(c.name, o.name) AS name, COALESCE(c.description, o.description) AS description,
              (SELECT COUNT(*) FROM charity_votes v WHERE v.option_id = o.id)::int AS vote_count
       FROM charity_options o LEFT JOIN charities c ON c.id = o.charity_id
       WHERE o.round_id = $1 ORDER BY o.id ASC`,
      [round.id]
    );
    charity = { round, options: options.rows };
  }

  res.render("dashboard", {
    announcements: announcements.rows,
    charity,
    latestArrivals: latestArrivals.rows,
    upcomingEvents: upcomingEvents.rows,
  });
});

module.exports = router;
