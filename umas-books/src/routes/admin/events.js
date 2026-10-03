const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { parseLocalDateTime } = require("../../lib/dates");
const { groupByDate, resolveCalendarRange, calendarBackQuery } = require("../../lib/calendar");

const { validateIdParams } = require("../../middleware/idParams");

const router = express.Router();
// Garbage ids get the 404 page, not a Postgres 22P02 and a 500.
validateIdParams(router, "id", "signupId");

// ---------- Events (public sign-up) ----------

router.get("/admin/events", requireAdmin, async (req, res) => {
  const range = resolveCalendarRange(req.query, 0);
  const { rows: events } = await pool.query(
    `SELECT e.*, (SELECT COUNT(*) FROM event_signups s WHERE s.event_id = e.id) AS signup_count
     FROM events e WHERE e.starts_at >= $1 AND e.starts_at < $2 ORDER BY e.starts_at ASC`,
    [range.start, range.end]
  );
  const eventIds = events.map((e) => e.id);
  const { rows: signupRows } = eventIds.length
    ? await pool.query("SELECT * FROM event_signups WHERE event_id = ANY($1) ORDER BY created_at ASC", [eventIds])
    : { rows: [] };
  const signupsByEvent = {};
  for (const s of signupRows) {
    if (!signupsByEvent[s.event_id]) signupsByEvent[s.event_id] = [];
    signupsByEvent[s.event_id].push(s);
  }

  const weeks = range.buildWeeks(groupByDate(events, "starts_at"));
  res.render("admin/events", { active: "events", weeks, signupsByEvent, view: range.view, ...range.nav });
});

router.post("/admin/events", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim() || null;
  const location = (req.body.location || "").trim() || null;
  const date = req.body.date;
  const startTime = req.body.startTime;
  const endTime = req.body.endTime || null;
  const capacity = req.body.capacity ? Number(req.body.capacity) : null;
  const price = req.body.price ? Number(req.body.price) : null;

  if (title && date && startTime) {
    const startsAt = parseLocalDateTime(date, startTime);
    const endsAt = endTime ? parseLocalDateTime(date, endTime) : null;
    if (!startsAt) return res.redirect("/admin/events");
    await pool.query(
      `INSERT INTO events (title, description, location, starts_at, ends_at, capacity, price, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [title, description, location, startsAt, endsAt, capacity, price, req.session.user.id]
    );
  }
  const backQuery = calendarBackQuery(req.body);
  res.redirect(backQuery ? `/admin/events?${backQuery}` : "/admin/events");
});

router.post("/admin/events/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim() || null;
  const location = (req.body.location || "").trim() || null;
  const startsAt = parseLocalDateTime(req.body.startsAt);
  const endsAt = req.body.endsAt ? parseLocalDateTime(req.body.endsAt) : null;
  const capacity = req.body.capacity ? Number(req.body.capacity) : null;
  const price = req.body.price ? Number(req.body.price) : null;

  if (title && startsAt) {
    await pool.query(
      `UPDATE events SET title=$1, description=$2, location=$3, starts_at=$4, ends_at=$5, capacity=$6, price=$7
       WHERE id = $8`,
      [title, description, location, startsAt, endsAt, capacity, price, id]
    );
  }
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/events?${backQuery}` : "/admin/events");
});

router.post("/admin/events/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM events WHERE id = $1", [Number(req.params.id)]);
  await audit(req, { action: "event.delete", targetType: "event", targetId: Number(req.params.id) });
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/events?${backQuery}` : "/admin/events");
});

router.post("/admin/events/:id/signups/:signupId/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM event_signups WHERE id = $1 AND event_id = $2", [Number(req.params.signupId), Number(req.params.id)]);
  await audit(req, { action: "event.signup_delete", targetType: "event_signup", targetId: Number(req.params.signupId) });
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/events?${backQuery}` : "/admin/events");
});

module.exports = router;
