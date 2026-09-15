const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/volunteer", requireAuth, async (req, res) => {
  const userId = req.session.user.id;

  const { rows: shifts } = await pool.query(
    `SELECT s.*, (SELECT COUNT(*) FROM volunteer_signups g WHERE g.shift_id = s.id) AS signup_count
     FROM volunteer_shifts s WHERE s.starts_at >= now() ORDER BY s.starts_at ASC`
  );
  const { rows: mySignups } = await pool.query(
    "SELECT shift_id FROM volunteer_signups WHERE user_id = $1", [userId]
  );
  const mySignedUpIds = new Set(mySignups.map((r) => r.shift_id));

  res.render("volunteer", { shifts, mySignedUpIds });
});

router.post("/volunteer/:id/signup", requireAuth, async (req, res) => {
  const shiftId = Number(req.params.id);
  const userId = req.session.user.id;

  const { rows: shiftRows } = await pool.query("SELECT * FROM volunteer_shifts WHERE id = $1", [shiftId]);
  const shift = shiftRows[0];
  if (!shift) return res.status(404).send("Shift not found.");

  const { rows: countRows } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM volunteer_signups WHERE shift_id = $1", [shiftId]
  );
  if (countRows[0].n >= shift.capacity) {
    return res.redirect("/volunteer");
  }

  await pool.query(
    "INSERT INTO volunteer_signups (shift_id, user_id) VALUES ($1, $2) ON CONFLICT (shift_id, user_id) DO NOTHING",
    [shiftId, userId]
  );
  res.redirect("/volunteer");
});

router.post("/volunteer/:id/cancel", requireAuth, async (req, res) => {
  const shiftId = Number(req.params.id);
  const userId = req.session.user.id;
  await pool.query("DELETE FROM volunteer_signups WHERE shift_id = $1 AND user_id = $2", [shiftId, userId]);
  res.redirect("/volunteer");
});

module.exports = router;
