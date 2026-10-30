const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { parseLocalDateTime } = require("../../lib/dates");
const { setFlash, takeFlash } = require("../../lib/flash");
const { LIMITS, lengthProblem, createOnce, DUPLICATE_WINDOW_SECONDS } = require("../../lib/adminForm");
const { groupByDate, resolveCalendarRange, calendarBackQuery } = require("../../lib/calendar");

const { validateIdParams } = require("../../middleware/idParams");

const router = express.Router();
// Garbage ids get the 404 page, not a Postgres 22P02 and a 500.
validateIdParams(router, "id");

// ---------- Meetings ----------

const asTyped = (raw) => (typeof raw === "string" ? raw.slice(0, 200) : "");

router.get("/admin/meetings", requireAdmin, async (req, res) => {
  const f = takeFlash(req, "meetings");
  const range = resolveCalendarRange(req.query, 0);
  const { rows: meetings } = await pool.query(
    `SELECT m.*, (SELECT COUNT(*) FROM meeting_rsvps r WHERE r.meeting_id = m.id) AS rsvp_count
     FROM meetings m WHERE m.scheduled_at >= $1 AND m.scheduled_at < $2 ORDER BY m.scheduled_at ASC`,
    [range.start, range.end]
  );
  const weeks = range.buildWeeks(groupByDate(meetings, "scheduled_at"));
  res.render("admin/meetings", { active: "meetings", error: f && f.error ? String(f.error) : null, formOverlay: (f && f.overlay) || null, weeks, view: range.view, ...range.nav });
});

router.post("/admin/meetings", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const date = req.body.date;
  const time = req.body.time;
  const location = (req.body.location || "").trim() || null;
  const agenda = (req.body.agenda || "").trim() || null;

  if (title && date && time) {
    const scheduledAt = parseLocalDateTime(date, time);
    const problem = lengthProblem([["The title", title, LIMITS.title], ["The location", location, LIMITS.line], ["The agenda", agenda, LIMITS.text]])
      || (!scheduledAt ? "That date or time is not a real date and time. Nothing was saved." : null);
    if (problem) {
      await setFlash(req, "meetings", {
        error: problem,
        overlay: { newDate: asTyped(date), values: { title, time: asTyped(time), location: location || "", agenda: agenda || "" } },
      });
      const back = calendarBackQuery(req.body);
      return res.redirect(303, back ? `/admin/meetings?${back}` : "/admin/meetings");
    }
    // The same form arriving twice in a minute (a double click) makes one meeting.
    await createOnce(
      pool, `meeting:${title}|${scheduledAt.toISOString()}`,
      `SELECT 1 FROM meetings WHERE title = $1 AND scheduled_at = $2 AND created_at > now() - interval '${DUPLICATE_WINDOW_SECONDS} seconds'`,
      [title, scheduledAt],
      (client) => client.query(
        `INSERT INTO meetings (title, scheduled_at, location, agenda, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [title, scheduledAt, location, agenda, req.session.user.id]
      )
    );
  }
  const backQuery = calendarBackQuery(req.body);
  res.redirect(backQuery ? `/admin/meetings?${backQuery}` : "/admin/meetings");
});

router.post("/admin/meetings/:id/minutes", requireAdmin, async (req, res) => {
  const minutes = (req.body.minutes || "").trim() || null;
  const tooLong = lengthProblem([["The minutes", minutes, LIMITS.longText]]);
  if (tooLong) {
    await setFlash(req, "meetings", { error: tooLong });
    const back = calendarBackQuery(req.query);
    return res.redirect(303, back ? `/admin/meetings?${back}` : "/admin/meetings");
  }
  await pool.query("UPDATE meetings SET minutes = $1 WHERE id = $2", [minutes, Number(req.params.id)]);
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/meetings?${backQuery}` : "/admin/meetings");
});

router.post("/admin/meetings/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM meetings WHERE id = $1", [Number(req.params.id)]);
  await audit(req, { action: "meeting.delete", targetType: "meeting", targetId: Number(req.params.id) });
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/meetings?${backQuery}` : "/admin/meetings");
});

module.exports = router;
