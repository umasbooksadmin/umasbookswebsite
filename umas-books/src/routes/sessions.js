const express = require("express");
const { pool } = require("../db");
const { groupByDate, resolveCalendarRange } = require("../lib/calendar");
const { seatsTakenExpr } = require("../lib/classCapacity");

const router = express.Router();

// Fully public, no login required — Drop-In Immersion seats are bought
// the same way books are (see src/routes/cart.js): add to cart, pay via
// HelloAsso at checkout, no account needed. Weekly Immersion is a
// separate, off-calendar flow (see pre-registration.html).
router.get("/sessions", async (req, res) => {
  const range = resolveCalendarRange(req.query, 1);

  const { rows: classes } = await pool.query(
    `SELECT c.*, ${seatsTakenExpr("c")}::int AS seats_taken
     FROM classes c WHERE c.starts_at >= $1 AND c.starts_at < $2 ORDER BY c.starts_at ASC`,
    [range.start, range.end]
  );

  const weeks = range.buildWeeks(groupByDate(classes, "starts_at"));
  res.render("sessions", { weeks, view: range.view, ...range.nav });
});

// A separate, fully public read-only calendar for the marketing site's
// English Immersion page (see /immersion.html) — same schedule as
// /sessions, but no seats-left info and no Add to Cart, since it's meant
// to be linked to from outside the shop as a quick "what's on" preview.
router.get("/immersion/calendar", async (req, res) => {
  const range = resolveCalendarRange(req.query, 1);

  const { rows: classes } = await pool.query(
    `SELECT c.* FROM classes c WHERE c.starts_at >= $1 AND c.starts_at < $2 ORDER BY c.starts_at ASC`,
    [range.start, range.end]
  );

  const weeks = range.buildWeeks(groupByDate(classes, "starts_at"));
  res.render("immersion_calendar", { weeks, view: range.view, ...range.nav });
});

module.exports = router;
