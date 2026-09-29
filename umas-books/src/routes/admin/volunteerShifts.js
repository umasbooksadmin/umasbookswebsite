const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { groupByDate, resolveCalendarRange, calendarBackQuery } = require("../../lib/calendar");

const router = express.Router();

// ---------- Volunteer shifts ----------

router.get("/admin/volunteer-shifts", requireAdmin, async (req, res) => {
  const range = resolveCalendarRange(req.query, 0);
  const { rows: shifts } = await pool.query(
    `SELECT s.*, (SELECT COUNT(*) FROM volunteer_signups g WHERE g.shift_id = s.id) AS signup_count
     FROM volunteer_shifts s WHERE s.starts_at >= $1 AND s.starts_at < $2 ORDER BY s.starts_at ASC`,
    [range.start, range.end]
  );
  const weeks = range.buildWeeks(groupByDate(shifts, "starts_at"));
  res.render("admin/volunteer", { active: "volunteer", weeks, view: range.view, ...range.nav });
});

router.post("/admin/volunteer-shifts", requireAdmin, async (req, res) => {
  const role = (req.body.role || "").trim();
  const date = req.body.date;
  const startTime = req.body.startTime;
  const endTime = req.body.endTime;
  const notes = (req.body.notes || "").trim() || null;
  const repeatWeeks = Math.max(1, Math.min(52, Number(req.body.repeatWeeks) || 1));

  if (role && date && startTime && endTime) {
    const start = new Date(`${date}T${startTime}`);
    const end = new Date(`${date}T${endTime}`);
    const weekMs = 7 * 24 * 60 * 60 * 1000;

    for (let i = 0; i < repeatWeeks; i++) {
      const s = new Date(start.getTime() + i * weekMs);
      const e = new Date(end.getTime() + i * weekMs);
      await pool.query(
        `INSERT INTO volunteer_shifts (role, starts_at, ends_at, capacity, notes, created_by)
         VALUES ($1, $2, $3, 1, $4, $5)`,
        [role, s.toISOString(), e.toISOString(), notes, req.session.user.id]
      );
    }
  }
  const backQuery = calendarBackQuery(req.body);
  res.redirect(backQuery ? `/admin/volunteer-shifts?${backQuery}` : "/admin/volunteer-shifts");
});

router.post("/admin/volunteer-shifts/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM volunteer_shifts WHERE id = $1", [Number(req.params.id)]);
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/volunteer-shifts?${backQuery}` : "/admin/volunteer-shifts");
});

module.exports = router;
