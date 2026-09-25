const express = require("express");
const { pool } = require("../db");
const { parseMonthParam, monthRange, monthGrid, groupByDate, monthNav } = require("../lib/calendar");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// The calendar itself is public, but signing up now requires an account —
// there's no name/email form any more, so a sign-up is always recorded
// under the logged-in member's own name and email (see the signup route
// below).

router.get("/sessions", async (req, res) => {
  const { year, month } = parseMonthParam(req.query.month);
  const { start, end } = monthRange(year, month);

  const { rows: classes } = await pool.query(
    `SELECT c.*, (SELECT COUNT(*) FROM class_signups s WHERE s.class_id = c.id) AS signup_count
     FROM classes c WHERE c.starts_at >= $1 AND c.starts_at < $2 ORDER BY c.starts_at ASC`,
    [start, end]
  );

  let mySignedUpClassIds = new Set();
  if (req.session.user) {
    const { rows: mySignups } = await pool.query(
      "SELECT class_id FROM class_signups WHERE lower(email) = lower($1)", [req.session.user.email]
    );
    mySignedUpClassIds = new Set(mySignups.map((r) => r.class_id));
  }

  const weeks = monthGrid(year, month, groupByDate(classes, "starts_at"));
  res.render("sessions", { weeks, mySignedUpClassIds, ...monthNav(year, month) });
});

router.post("/sessions/:id/signup", requireAuth, async (req, res) => {
  const classId = Number(req.params.id);
  const name = req.session.user.displayName;
  const email = req.session.user.email.toLowerCase();
  const redirectUrl = req.query.month ? `/sessions?month=${req.query.month}` : "/sessions";

  const { rows: classRows } = await pool.query("SELECT * FROM classes WHERE id = $1", [classId]);
  const cls = classRows[0];
  if (!cls) return res.status(404).send("Session not found.");

  if (cls.capacity != null) {
    const { rows: countRows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM class_signups WHERE class_id = $1", [classId]
    );
    if (countRows[0].n >= cls.capacity) {
      return res.redirect(redirectUrl);
    }
  }

  await pool.query(
    "INSERT INTO class_signups (class_id, name, email) VALUES ($1, $2, $3) ON CONFLICT (class_id, email) DO NOTHING",
    [classId, name, email]
  );
  res.redirect(redirectUrl);
});

module.exports = router;
