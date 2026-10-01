const express = require("express");
const { pool } = require("../db");
const { requireMember } = require("../middleware/auth");
const { groupByDate, resolveCalendarRange, calendarBackQuery } = require("../lib/calendar");

const { validateIdParams } = require("../middleware/idParams");

const router = express.Router();
// Garbage ids get the 404 page, not a Postgres 22P02 and a 500.
validateIdParams(router, "id");

router.get("/meetings", requireMember, async (req, res) => {
  const userId = req.session.user.id;
  const range = resolveCalendarRange(req.query, 0);

  const { rows: meetings } = await pool.query(
    `SELECT m.*, (SELECT COUNT(*) FROM meeting_rsvps r WHERE r.meeting_id = m.id) AS rsvp_count
     FROM meetings m WHERE m.scheduled_at >= $1 AND m.scheduled_at < $2 ORDER BY m.scheduled_at ASC`,
    [range.start, range.end]
  );
  const { rows: myRsvpRows } = await pool.query("SELECT meeting_id FROM meeting_rsvps WHERE user_id = $1", [userId]);
  const rsvpedMeetingIds = new Set(myRsvpRows.map((r) => r.meeting_id));

  const { rows: past } = await pool.query(
    "SELECT * FROM meetings WHERE scheduled_at < now() ORDER BY scheduled_at DESC LIMIT 20"
  );

  const weeks = range.buildWeeks(groupByDate(meetings, "scheduled_at"));
  res.render("meetings", { weeks, rsvpedMeetingIds, past, view: range.view, ...range.nav });
});

router.post("/meetings/:id/rsvp", requireMember, async (req, res) => {
  const meetingId = Number(req.params.id);
  const userId = req.session.user.id;
  await pool.query(
    "INSERT INTO meeting_rsvps (meeting_id, user_id) VALUES ($1, $2) ON CONFLICT (meeting_id, user_id) DO NOTHING",
    [meetingId, userId]
  );
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/meetings?${backQuery}` : "/meetings");
});

router.post("/meetings/:id/unrsvp", requireMember, async (req, res) => {
  const meetingId = Number(req.params.id);
  const userId = req.session.user.id;
  await pool.query("DELETE FROM meeting_rsvps WHERE meeting_id = $1 AND user_id = $2", [meetingId, userId]);
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/meetings?${backQuery}` : "/meetings");
});

module.exports = router;
