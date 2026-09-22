const express = require("express");
const { pool } = require("../db");
const { parseMonthParam, monthRange, monthGrid, groupByDate, monthNav, monthParam } = require("../lib/calendar");

const router = express.Router();

// Public — no login required. Anyone can view the calendar and sign up.

// Public JSON, cross-origin — consumed by the marketing site's Events
// page so it can show the actual upcoming schedule inline instead of
// just linking out to it. Same CORS treatment as
// /api/books/latest-arrivals: Access-Control-Allow-Origin alone isn't
// enough, helmet's Cross-Origin-Resource-Policy: same-origin blocks the
// read independently of CORS unless relaxed here too.
router.get("/api/events/upcoming", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  const { rows } = await pool.query(
    `SELECT e.*, (SELECT COUNT(*) FROM event_signups s WHERE s.event_id = e.id) AS signup_count
     FROM events e WHERE e.starts_at >= now() ORDER BY e.starts_at ASC LIMIT 10`
  );
  res.json(
    rows.map((e) => {
      const starts = new Date(e.starts_at);
      return {
        id: e.id,
        title: e.title,
        description: e.description,
        location: e.location,
        startsAt: e.starts_at,
        endsAt: e.ends_at,
        capacity: e.capacity,
        signupCount: e.signup_count,
        url: `https://umas-books.onrender.com/events?month=${monthParam(starts.getFullYear(), starts.getMonth())}`,
      };
    })
  );
});

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
