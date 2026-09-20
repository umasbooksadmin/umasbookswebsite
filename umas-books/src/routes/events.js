const express = require("express");
const { pool } = require("../db");
const { parseMonthParam, monthRange, monthGrid, groupByDate, monthNav } = require("../lib/calendar");

const router = express.Router();

// Public — no login required. Anyone can view the calendar and sign up.

router.get("/events", async (req, res) => {
  const { year, month } = parseMonthParam(req.query.month);
  const { start, end } = monthRange(year, month);

  const { rows: events } = await pool.query(
    `SELECT e.*, (SELECT COUNT(*) FROM event_signups s WHERE s.event_id = e.id) AS signup_count
     FROM events e WHERE e.starts_at >= $1 AND e.starts_at < $2 ORDER BY e.starts_at ASC`,
    [start, end]
  );

  const weeks = monthGrid(year, month, groupByDate(events, "starts_at"));
  res.render("events", { weeks, ...monthNav(year, month) });
});

router.post("/events/:id/signup", async (req, res) => {
  const eventId = Number(req.params.id);
  const name = (req.body.name || "").trim();
  const email = (req.body.email || "").trim().toLowerCase();
  const redirectUrl = req.query.month ? `/events?month=${req.query.month}` : "/events";

  if (!name || !email) return res.redirect(redirectUrl);

  const { rows: eventRows } = await pool.query("SELECT * FROM events WHERE id = $1", [eventId]);
  const event = eventRows[0];
  if (!event) return res.status(404).send("Event not found.");

  if (event.capacity != null) {
    const { rows: countRows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM event_signups WHERE event_id = $1", [eventId]
    );
    if (countRows[0].n >= event.capacity) {
      return res.redirect(redirectUrl);
    }
  }

  await pool.query(
    "INSERT INTO event_signups (event_id, name, email) VALUES ($1, $2, $3) ON CONFLICT (event_id, email) DO NOTHING",
    [eventId, name, email]
  );
  res.redirect(redirectUrl);
});

module.exports = router;
