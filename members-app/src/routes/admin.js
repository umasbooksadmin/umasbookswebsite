const express = require("express");
const { pool } = require("../db");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

router.get("/admin", requireAdmin, async (req, res) => {
  const [events, rounds] = await Promise.all([
    pool.query("SELECT * FROM events ORDER BY starts_at DESC LIMIT 10"),
    pool.query("SELECT * FROM charity_rounds ORDER BY opens_at DESC LIMIT 5"),
  ]);
  res.render("admin", { events: events.rows, rounds: rounds.rows, error: null, notice: null });
});

router.post("/admin/announcements", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const body = (req.body.body || "").trim();
  if (title && body) {
    await pool.query(
      "INSERT INTO announcements (title, body, created_by) VALUES ($1, $2, $3)",
      [title, body, req.session.user.id]
    );
  }
  res.redirect("/admin");
});

router.post("/admin/events", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim();
  const location = (req.body.location || "").trim();
  const startsAt = req.body.startsAt;
  const capacity = req.body.capacity ? Number(req.body.capacity) : null;
  if (title && startsAt) {
    await pool.query(
      `INSERT INTO events (title, description, location, starts_at, capacity, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [title, description, location, startsAt, capacity, req.session.user.id]
    );
  }
  res.redirect("/admin");
});

router.post("/admin/charity-rounds", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const optionNames = (req.body.options || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (title && optionNames.length) {
    await pool.query("UPDATE charity_rounds SET is_active = FALSE WHERE is_active = TRUE");
    const { rows } = await pool.query(
      "INSERT INTO charity_rounds (title, is_active) VALUES ($1, TRUE) RETURNING id",
      [title]
    );
    const roundId = rows[0].id;
    for (const name of optionNames) {
      await pool.query(
        "INSERT INTO charity_options (round_id, name) VALUES ($1, $2)",
        [roundId, name]
      );
    }
  }
  res.redirect("/admin");
});

router.post("/admin/charity-rounds/:id/close", requireAdmin, async (req, res) => {
  await pool.query(
    "UPDATE charity_rounds SET is_active = FALSE, closes_at = now() WHERE id = $1",
    [Number(req.params.id)]
  );
  res.redirect("/admin");
});

module.exports = router;
