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
    const options = await pool.query(
      `SELECT o.*, (SELECT COUNT(*) FROM charity_votes v WHERE v.option_id = o.id) AS vote_count
       FROM charity_options o WHERE o.round_id = $1 ORDER BY o.id ASC`,
      [round.id]
    );
    const myVote = await pool.query(
      "SELECT option_id FROM charity_votes WHERE round_id = $1 AND user_id = $2",
      [round.id, userId]
    );
    charity = {
      round,
      options: options.rows,
      myOptionId: myVote.rows[0] ? myVote.rows[0].option_id : null,
    };
  }

  res.render("dashboard", {
    announcements: announcements.rows,
    charity,
    latestArrivals: latestArrivals.rows,
    upcomingEvents: upcomingEvents.rows,
  });
});

module.exports = router;
