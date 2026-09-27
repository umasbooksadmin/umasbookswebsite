const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { groupByDate, resolveCalendarRange, calendarBackQuery } = require("../lib/calendar");

const router = express.Router();

router.get("/volunteer", requireAuth, async (req, res) => {
  const userId = req.session.user.id;
  const range = resolveCalendarRange(req.query, 0);

  const { rows: shifts } = await pool.query(
    `SELECT s.*, (SELECT COUNT(*) FROM volunteer_signups g WHERE g.shift_id = s.id) AS signup_count
     FROM volunteer_shifts s WHERE s.starts_at >= $1 AND s.starts_at < $2 ORDER BY s.starts_at ASC`,
    [range.start, range.end]
  );
  const { rows: mySignups } = await pool.query(
    `SELECT s.* FROM volunteer_signups g
     JOIN volunteer_shifts s ON s.id = g.shift_id
     WHERE g.user_id = $1 AND s.starts_at >= now() ORDER BY s.starts_at ASC LIMIT 5`,
    [userId]
  );
  const mySignedUpIds = new Set(
    (await pool.query("SELECT shift_id FROM volunteer_signups WHERE user_id = $1", [userId])).rows.map((r) => r.shift_id)
  );

  const weeks = range.buildWeeks(groupByDate(shifts, "starts_at"));
  res.render("volunteer", { weeks, mySignedUpIds, myShifts: mySignups, view: range.view, ...range.nav });
});

router.post("/volunteer/:id/signup", requireAuth, async (req, res) => {
  const shiftId = Number(req.params.id);
  const userId = req.session.user.id;
  const backQuery = calendarBackQuery(req.query);
  const redirectUrl = backQuery ? `/volunteer?${backQuery}` : "/volunteer";

  const { rows: shiftRows } = await pool.query("SELECT * FROM volunteer_shifts WHERE id = $1", [shiftId]);
  const shift = shiftRows[0];
  if (!shift) return res.status(404).send("Shift not found.");

  const { rows: countRows } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM volunteer_signups WHERE shift_id = $1", [shiftId]
  );
  if (countRows[0].n >= shift.capacity) {
    return res.redirect(redirectUrl);
  }

  await pool.query(
    "INSERT INTO volunteer_signups (shift_id, user_id) VALUES ($1, $2) ON CONFLICT (shift_id, user_id) DO NOTHING",
    [shiftId, userId]
  );
  res.redirect(redirectUrl);
});

router.post("/volunteer/:id/cancel", requireAuth, async (req, res) => {
  const shiftId = Number(req.params.id);
  const userId = req.session.user.id;
  await pool.query("DELETE FROM volunteer_signups WHERE shift_id = $1 AND user_id = $2", [shiftId, userId]);
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/volunteer?${backQuery}` : "/volunteer");
});

module.exports = router;
