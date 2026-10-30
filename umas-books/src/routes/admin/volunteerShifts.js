const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { weeklyDateTimes, parseLocalDateTime } = require("../../lib/dates");
const { setFlash, takeFlash } = require("../../lib/flash");
const { LIMITS, lengthProblem, timeRangeProblem, createOnce, DUPLICATE_WINDOW_SECONDS, findReversedRanges } = require("../../lib/adminForm");
const { groupByDate, resolveCalendarRange, calendarBackQuery } = require("../../lib/calendar");

const { validateIdParams } = require("../../middleware/idParams");

const router = express.Router();
// Garbage ids get the 404 page, not a Postgres 22P02 and a 500.
validateIdParams(router, "id");

// ---------- Volunteer shifts ----------

const asTyped = (raw) => (typeof raw === "string" ? raw.slice(0, 200) : "");

router.get("/admin/volunteer-shifts", requireAdmin, async (req, res) => {
  const f = takeFlash(req, "volunteerShifts");
  const range = resolveCalendarRange(req.query, 0);
  const { rows: shifts } = await pool.query(
    `SELECT s.*, (SELECT COUNT(*) FROM volunteer_signups g WHERE g.shift_id = s.id) AS signup_count
     FROM volunteer_shifts s WHERE s.starts_at >= $1 AND s.starts_at < $2 ORDER BY s.starts_at ASC`,
    [range.start, range.end]
  );
  const weeks = range.buildWeeks(groupByDate(shifts, "starts_at"));
  const badRanges = await findReversedRanges(pool, "volunteer_shifts");
  res.render("admin/volunteer", { active: "volunteer", error: f && f.error ? String(f.error) : null, formOverlay: (f && f.overlay) || null, badRanges, weeks, view: range.view, ...range.nav });
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

    const problem = lengthProblem([["The role", role, LIMITS.title], ["The notes", notes, LIMITS.text]])
      || (!starts.length ? "That date or start time is not a real date and time. Nothing was saved." : null)
      || (!parseLocalDateTime(date, endTime) ? "That end time is not a real time. Nothing was saved." : null)
      || timeRangeProblem(starts[0], ends[0], "A shift");
    if (problem) {
      await setFlash(req, "volunteerShifts", {
        error: problem,
        overlay: { newDate: asTyped(date), values: { role, startTime: asTyped(startTime), endTime: asTyped(endTime), repeatWeeks: asTyped(req.body.repeatWeeks), notes: notes || "" } },
      });
      const back = calendarBackQuery(req.body);
      return res.redirect(303, back ? `/admin/volunteer-shifts?${back}` : "/admin/volunteer-shifts");
    }

    // The same form arriving twice in a minute (a double click) makes the shifts once; all the weeks go in together.
    await createOnce(
      pool, `shift:${role}|${starts[0].toISOString()}`,
      `SELECT 1 FROM volunteer_shifts WHERE role = $1 AND starts_at = $2 AND created_at > now() - interval '${DUPLICATE_WINDOW_SECONDS} seconds'`,
      [role, starts[0]],
      async (client) => {
        for (let i = 0; i < starts.length && i < ends.length; i++) {
          await client.query(
            `INSERT INTO volunteer_shifts (role, starts_at, ends_at, capacity, notes, created_by)
             VALUES ($1, $2, $3, 1, $4, $5)`,
            [role, starts[i].toISOString(), ends[i].toISOString(), notes, req.session.user.id]
          );
        }
      }
    );
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
