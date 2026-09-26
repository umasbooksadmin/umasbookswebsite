const express = require("express");
const { pool } = require("../db");
const { requireMember } = require("../middleware/auth");

const router = express.Router();

async function loadActiveRound(userId) {
  const { rows: roundRows } = await pool.query(
    "SELECT * FROM charity_rounds WHERE is_active = TRUE ORDER BY opens_at DESC LIMIT 1"
  );
  if (!roundRows.length) return null;
  const round = roundRows[0];
  const { rows: options } = await pool.query(
    `SELECT o.*, (SELECT COUNT(*) FROM charity_votes v WHERE v.option_id = o.id) AS vote_count
     FROM charity_options o WHERE o.round_id = $1 ORDER BY o.id ASC`,
    [round.id]
  );
  const { rows: myVote } = await pool.query(
    "SELECT option_id FROM charity_votes WHERE round_id = $1 AND user_id = $2",
    [round.id, userId]
  );
  return { round, options, myOptionId: myVote[0] ? myVote[0].option_id : null };
}

router.get("/charity", requireMember, async (req, res) => {
  const charity = await loadActiveRound(req.session.user.id);
  res.render("charity", { charity });
});

router.post("/charity/vote", requireMember, async (req, res) => {
  const optionId = Number(req.body.optionId);
  const userId = req.session.user.id;

  const { rows: optionRows } = await pool.query(
    "SELECT * FROM charity_options WHERE id = $1", [optionId]
  );
  const option = optionRows[0];
  if (!option) return res.status(400).send("Invalid option.");

  const { rows: roundRows } = await pool.query(
    "SELECT * FROM charity_rounds WHERE id = $1 AND is_active = TRUE", [option.round_id]
  );
  if (!roundRows.length) return res.status(400).send("Voting is not open.");

  await pool.query(
    `INSERT INTO charity_votes (round_id, option_id, user_id) VALUES ($1, $2, $3)
     ON CONFLICT (round_id, user_id) DO UPDATE SET option_id = EXCLUDED.option_id, created_at = now()`,
    [option.round_id, optionId, userId]
  );
  res.redirect("/charity");
});

module.exports = router;
