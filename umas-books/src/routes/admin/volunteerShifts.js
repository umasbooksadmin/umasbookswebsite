const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { weeklyDateTimes } = require("../../lib/dates");
const { groupByDate, resolveCalendarRange, calendarBackQuery } = require("../../lib/calendar");

const { validateIdParams } = require("../../middleware/idParams");

const router = express.Router();
// Garbage ids get the 404 page, not a Postgres 22P02 and a 500.
validateIdParams(router, "id");

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
    // Same Paris wall-clock time each week (no drift across a clock change).
    const starts = weeklyDateTimes(date, startTime, repeatWeeks);
    const ends = weeklyDateTimes(date, endTime, repeatWeeks);

    for (let i = 0; i < starts.length && i < ends.length; i++) {
      const s = starts[i];
      const e = ends[i];
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
  await audit(req, { action: "volunteer_shift.delete", targetType: "volunteer_shift", targetId: Number(req.params.id) });
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/volunteer-shifts?${backQuery}` : "/admin/volunteer-shifts");
});

module.exports = router;
