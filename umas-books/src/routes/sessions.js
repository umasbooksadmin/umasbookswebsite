const express = require("express");
const { pool } = require("../db");
const { groupByDate, resolveCalendarRange } = require("../lib/calendar");
const { seatsTakenExpr } = require("../lib/classCapacity");

const router = express.Router();

// Fully public, no login required — Drop-In Immersion seats are bought
// the same way books are (see src/routes/cart.js): add to cart, pay via
// HelloAsso at checkout (checkout needs an account; browsing and the cart do not). Weekly Immersion is a
// separate, off-calendar flow (see pre-registration.html). This used to
// be duplicated as its own page at /immersion/calendar (same query,
// different view) for people arriving from immersion.html — merged
// back into this one route; see the redirect below. ?type=dropin filters
// to just the bookable sessions, for anyone who only wants to see what
// they can drop in on right now rather than the full program schedule.
router.get("/sessions", async (req, res) => {
  const range = resolveCalendarRange(req.query, 1, req.lang);
  const dropinOnly = req.query.type === "dropin";

  const { rows: classes } = await pool.query(
    `SELECT c.*, ${seatsTakenExpr("c")}::int AS seats_taken
     FROM classes c WHERE c.starts_at >= $1 AND c.starts_at < $2 ${dropinOnly ? "AND c.dropin_price IS NOT NULL" : ""} ORDER BY c.starts_at ASC`,
    [range.start, range.end]
  );

  const weeks = range.buildWeeks(groupByDate(classes, "starts_at"));
  res.render("sessions", { weeks, view: range.view, dropinOnly, ...range.nav });
});

// immersion.html and programs.html still link here — keep the URL alive
// rather than editing every marketing page, same as the /classes and
// /programs redirects in src/index.js.
router.get("/immersion/calendar", (req, res) => {
  const i = req.originalUrl.indexOf("?");
  const qs = i === -1 ? "" : req.originalUrl.slice(i);
  res.redirect(301, "/sessions" + qs);
});

module.exports = router;
