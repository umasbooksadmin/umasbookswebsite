const express = require("express");
const { pool, withTransaction } = require("../db");
const { requireVolunteer } = require("../middleware/auth");
const { groupByDate, resolveCalendarRange, calendarBackQuery } = require("../lib/calendar");
const { redirectWithFlash, takePageFlash } = require("../lib/postRedirect");

// What the calendar says after a sign-up (Post/Redirect/Get): 'signed_up' | 'full' | 'past', with the shift's role.
const SIGNUP_FLASH = "volunteerSignup";

const { validateIdParams } = require("../middleware/idParams");

const router = express.Router();
// Garbage ids get the 404 page, not a Postgres 22P02 and a 500.
validateIdParams(router, "id");

router.get("/volunteer", requireVolunteer, async (req, res) => {
  const userId = req.session.user.id;
  const range = resolveCalendarRange(req.query, 0, req.lang);

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
  const signupNotice = takePageFlash(req, res, SIGNUP_FLASH);
  res.render("volunteer", { weeks, mySignedUpIds, myShifts: mySignups, signupNotice, view: range.view, ...range.nav });
});

router.post("/volunteer/:id/signup", requireVolunteer, async (req, res) => {
  const shiftId = Number(req.params.id);
  const userId = req.session.user.id;
  const backQuery = calendarBackQuery(req.query);
  const redirectUrl = backQuery ? `/volunteer?${backQuery}` : "/volunteer";

  let shift;
  try {
    await withTransaction(pool, async (client) => {
      // Lock the shift row so two signups arriving at the same moment
      // can't both read the same "spots left" and both squeeze in —
      // same pattern as the event signup and the drop-in seat checkout
      // in lib/cart.js.
      const { rows: shiftRows } = await client.query("SELECT *, starts_at <= now() AS started FROM volunteer_shifts WHERE id = $1 FOR UPDATE", [shiftId]);
      shift = shiftRows[0];
      if (!shift) throw new Error("SHIFT_NOT_FOUND");
      // A shift that has started (or is over) takes no more sign-ups (review 6B L5).
      if (shift.started) throw new Error("SHIFT_STARTED");
      // Already on it (a double click): say so, not "full" when this volunteer took the last place.
      const { rows: mine } = await client.query("SELECT 1 FROM volunteer_signups WHERE shift_id = $1 AND user_id = $2", [shiftId, userId]);
      if (mine.length) return;

      const { rows: countRows } = await client.query(
        "SELECT COUNT(*)::int AS n FROM volunteer_signups WHERE shift_id = $1", [shiftId]
      );
      if (countRows[0].n >= shift.capacity) throw new Error("AT_CAPACITY");

      await client.query(
        "INSERT INTO volunteer_signups (shift_id, user_id) VALUES ($1, $2) ON CONFLICT (shift_id, user_id) DO NOTHING",
        [shiftId, userId]
      );
    });
  } catch (err) {
    if (err.message === "SHIFT_NOT_FOUND") return res.status(404).send(req.tr("Shift not found.", "Créneau introuvable."));
    if (err.message === "SHIFT_STARTED") return redirectWithFlash(req, res, redirectUrl, SIGNUP_FLASH, { outcome: "past", role: shift.role });
    if (err.message === "AT_CAPACITY") return redirectWithFlash(req, res, redirectUrl, SIGNUP_FLASH, { outcome: "full", role: shift.role });
    throw err;
  }
  return redirectWithFlash(req, res, redirectUrl, SIGNUP_FLASH, { outcome: "signed_up", role: shift.role });
});

router.post("/volunteer/:id/cancel", requireVolunteer, async (req, res) => {
  const shiftId = Number(req.params.id);
  const userId = req.session.user.id;
  await pool.query("DELETE FROM volunteer_signups WHERE shift_id = $1 AND user_id = $2", [shiftId, userId]);
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/volunteer?${backQuery}` : "/volunteer");
});

module.exports = router;
