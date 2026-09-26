const express = require("express");
const { pool } = require("../db");
const { requireMember } = require("../middleware/auth");

const router = express.Router();

router.get("/dashboard", requireMember, async (req, res) => {
  const userId = req.session.user.id;

  const [announcements, activeRound, forumThreads, upcomingShifts, myShiftSignups, upcomingMeetings, myMeetingRsvps] = await Promise.all([
    pool.query("SELECT * FROM announcements ORDER BY published_at DESC LIMIT 5"),
    pool.query("SELECT * FROM charity_rounds WHERE is_active = TRUE ORDER BY opens_at DESC LIMIT 1"),
    pool.query(
      `SELECT t.*, u.display_name AS author_name,
              (SELECT COUNT(*) FROM forum_replies r WHERE r.thread_id = t.id) AS reply_count
       FROM forum_threads t LEFT JOIN users u ON u.id = t.author_id
       ORDER BY t.created_at DESC LIMIT 5`
    ),
    pool.query(
      `SELECT s.*, (SELECT COUNT(*) FROM volunteer_signups g WHERE g.shift_id = s.id) AS signup_count
       FROM volunteer_shifts s WHERE s.starts_at >= now() ORDER BY s.starts_at ASC LIMIT 5`
    ),
    pool.query("SELECT shift_id FROM volunteer_signups WHERE user_id = $1", [userId]),
    pool.query("SELECT * FROM meetings WHERE scheduled_at >= now() ORDER BY scheduled_at ASC LIMIT 3"),
    pool.query("SELECT meeting_id FROM meeting_rsvps WHERE user_id = $1", [userId]),
  ]);

  const mySignedUpShiftIds = new Set(myShiftSignups.rows.map((r) => r.shift_id));
  const rsvpedMeetingIds = new Set(myMeetingRsvps.rows.map((r) => r.meeting_id));

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
    forumThreads: forumThreads.rows,
    shifts: upcomingShifts.rows,
    mySignedUpShiftIds,
    meetings: upcomingMeetings.rows,
    rsvpedMeetingIds,
  });
});

module.exports = router;
