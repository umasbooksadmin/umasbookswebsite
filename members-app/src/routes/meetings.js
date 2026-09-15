const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/meetings", requireAuth, async (req, res) => {
  const { rows: upcoming } = await pool.query(
    "SELECT * FROM meetings WHERE scheduled_at >= now() ORDER BY scheduled_at ASC"
  );
  const { rows: past } = await pool.query(
    "SELECT * FROM meetings WHERE scheduled_at < now() ORDER BY scheduled_at DESC LIMIT 20"
  );
  res.render("meetings", { upcoming, past });
});

module.exports = router;
