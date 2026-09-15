const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/dashboard", requireAuth, async (req, res) => {
  const userId = req.session.user.id;

  const [announcements, upcomingEvents, myRsvps, activeRound, forumThreads] = await Promise.all([
    pool.query("SELECT * FROM announcements ORDER BY published_at DESC LIMIT 5"),
    pool.query("SELECT * FROM events WHERE starts_at >= now() ORDER BY starts_at ASC LIMIT 5"),
    pool.query("SELECT event_id FROM event_rsvps WHERE user_id = $1", [userId]),
    pool.query("SELECT * FROM charity_rounds WHERE is_active = TRUE ORDER BY opens_at DESC LIMIT 1"),
    pool.query(
      `SELECT t.*, u.display_name AS author_name,
              (SELECT COUNT(*) FROM forum_replies r WHERE r.thread_id = t.id) AS reply_count
       FROM forum_threads t LEFT JOIN users u ON u.id = t.author_id
       ORDER BY t.created_at DESC LIMIT 5`
    ),
  ]);

  const rsvpedEventIds = new Set(myRsvps.rows.map((r) => r.event_id));

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
    events: upcomingEvents.rows,
    rsvpedEventIds,
    charity,
    forumThreads: forumThreads.rows,
  });
});

module.exports = router;
