const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { groupByDate, resolveCalendarRange, calendarBackQuery } = require("../../lib/calendar");

const router = express.Router();

// ---------- Meetings ----------

router.get("/admin/meetings", requireAdmin, async (req, res) => {
  const range = resolveCalendarRange(req.query, 0);
  const { rows: meetings } = await pool.query(
    `SELECT m.*, (SELECT COUNT(*) FROM meeting_rsvps r WHERE r.meeting_id = m.id) AS rsvp_count
     FROM meetings m WHERE m.scheduled_at >= $1 AND m.scheduled_at < $2 ORDER BY m.scheduled_at ASC`,
    [range.start, range.end]
  );
  const weeks = range.buildWeeks(groupByDate(meetings, "scheduled_at"));
  res.render("admin/meetings", { active: "meetings", weeks, view: range.view, ...range.nav });
});

router.post("/admin/meetings", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const date = req.body.date;
  const time = req.body.time;
  const location = (req.body.location || "").trim() || null;
  const agenda = (req.body.agenda || "").trim() || null;

  if (title && date && time) {
    const scheduledAt = `${date}T${time}`;
    await pool.query(
      `INSERT INTO meetings (title, scheduled_at, location, agenda, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [title, scheduledAt, location, agenda, req.session.user.id]
    );
  }
  const backQuery = calendarBackQuery(req.body);
  res.redirect(backQuery ? `/admin/meetings?${backQuery}` : "/admin/meetings");
});

router.post("/admin/meetings/:id/minutes", requireAdmin, async (req, res) => {
  const minutes = (req.body.minutes || "").trim() || null;
  await pool.query("UPDATE meetings SET minutes = $1 WHERE id = $2", [minutes, Number(req.params.id)]);
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/meetings?${backQuery}` : "/admin/meetings");
});

router.post("/admin/meetings/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM meetings WHERE id = $1", [Number(req.params.id)]);
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/meetings?${backQuery}` : "/admin/meetings");
});

module.exports = router;
