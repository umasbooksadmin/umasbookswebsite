const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/events", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const { rows: events } = await pool.query(
    `SELECT e.*, (SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id = e.id) AS rsvp_count
     FROM events e ORDER BY e.starts_at ASC`
  );
  const { rows: myRsvps } = await pool.query("SELECT event_id FROM event_rsvps WHERE user_id = $1", [userId]);
  const rsvpedEventIds = new Set(myRsvps.map((r) => r.event_id));
  res.render("events", { events, rsvpedEventIds });
});

router.post("/events/:id/rsvp", requireAuth, async (req, res) => {
  const eventId = Number(req.params.id);
  const userId = req.session.user.id;

  const { rows: eventRows } = await pool.query("SELECT * FROM events WHERE id = $1", [eventId]);
  const event = eventRows[0];
  if (!event) return res.status(404).send("Event not found.");

  if (event.capacity != null) {
    const { rows: countRows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM event_rsvps WHERE event_id = $1", [eventId]
    );
    if (countRows[0].n >= event.capacity) {
      return res.redirect("/events");
    }
  }

  await pool.query(
    "INSERT INTO event_rsvps (event_id, user_id) VALUES ($1, $2) ON CONFLICT (event_id, user_id) DO NOTHING",
    [eventId, userId]
  );
  res.redirect("/events");
});

router.post("/events/:id/unrsvp", requireAuth, async (req, res) => {
  const eventId = Number(req.params.id);
  const userId = req.session.user.id;
  await pool.query("DELETE FROM event_rsvps WHERE event_id = $1 AND user_id = $2", [eventId, userId]);
  res.redirect("/events");
});

module.exports = router;
