const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");

const router = express.Router();

// Read-only view of the admin action log (see lib/audit.js).
router.get("/admin/audit", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT at, actor_user_id, actor_label, action, target_type, target_id, detail
     FROM admin_audit_log ORDER BY at DESC, id DESC LIMIT 200`
  );
  res.render("admin/audit", { active: "audit", entries: rows });
});

module.exports = router;
