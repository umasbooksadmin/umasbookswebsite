const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { parseMonthParam, monthRange, monthGrid, groupByDate, monthNav } = require("../lib/calendar");

const router = express.Router();

router.get("/meetings", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const { year, month } = parseMonthParam(req.query.month);
  const { start, end } = monthRange(year, month);

  const { rows: meetings } = await pool.query(
    `SELECT m.*, (SELECT COUNT(*) FROM meeting_rsvps r WHERE r.meeting_id = m.id) AS rsvp_count
     FROM meetings m WHERE m.scheduled_at >= $1 AND m.scheduled_at < $2 ORDER BY m.scheduled_at ASC`,
    [start, end]
  );
  const { rows: myRsvpRows } = await pool.query("SELECT meeting_id FROM meeting_rsvps WHERE user_id = $1", [userId]);
  const rsvpedMeetingIds = new Set(myRsvpRows.map((r) => r.meeting_id));

  const { rows: past } = await pool.query(
    "SELECT * FROM meetings WHERE scheduled_at < now() ORDER BY scheduled_at DESC LIMIT 20"
  );

  const weeks = monthGrid(year, month, groupByDate(meetings, "scheduled_at"));
  res.render("meetings", { weeks, rsvpedMeetingIds, past, ...monthNav(year, month) });
});

router.post("/meetings/:id/rsvp", requireAuth, async (req, res) => {
  const meetingId = Number(req.params.id);
  const userId = req.session.user.id;
  await pool.query(
    "INSERT INTO meeting_rsvps (meeting_id, user_id) VALUES ($1, $2) ON CONFLICT (meeting_id, user_id) DO NOTHING",
    [meetingId, userId]
  );
  res.redirect(req.query.month ? `/meetings?month=${req.query.month}` : "/meetings");
});

router.post("/meetings/:id/unrsvp", requireAuth, async (req, res) => {
  const meetingId = Number(req.params.id);
  const userId = req.session.user.id;
  await pool.query("DELETE FROM meeting_rsvps WHERE meeting_id = $1 AND user_id = $2", [meetingId, userId]);
  res.redirect(req.query.month ? `/meetings?month=${req.query.month}` : "/meetings");
});

module.exports = router;
