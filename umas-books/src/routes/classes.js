const express = require("express");
const { pool } = require("../db");
const { parseMonthParam, monthRange, monthGrid, groupByDate, monthNav } = require("../lib/calendar");

const router = express.Router();

// Public — no login required. Anyone can view the calendar and sign up.

router.get("/classes", async (req, res) => {
  const { year, month } = parseMonthParam(req.query.month);
  const { start, end } = monthRange(year, month);

  const { rows: classes } = await pool.query(
    `SELECT c.*, (SELECT COUNT(*) FROM class_signups s WHERE s.class_id = c.id) AS signup_count
     FROM classes c WHERE c.starts_at >= $1 AND c.starts_at < $2 ORDER BY c.starts_at ASC`,
    [start, end]
  );

  const weeks = monthGrid(year, month, groupByDate(classes, "starts_at"));
  res.render("classes", { weeks, ...monthNav(year, month) });
});

router.post("/classes/:id/signup", async (req, res) => {
  const classId = Number(req.params.id);
  const name = (req.body.name || "").trim();
  const email = (req.body.email || "").trim().toLowerCase();
  const redirectUrl = req.query.month ? `/classes?month=${req.query.month}` : "/classes";

  if (!name || !email) return res.redirect(redirectUrl);

  const { rows: classRows } = await pool.query("SELECT * FROM classes WHERE id = $1", [classId]);
  const cls = classRows[0];
  if (!cls) return res.status(404).send("Program not found.");

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
