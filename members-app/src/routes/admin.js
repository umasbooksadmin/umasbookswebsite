const express = require("express");
const { pool } = require("../db");
const { requireAdmin } = require("../middleware/auth");
const { sendResetLink } = require("../lib/passwordReset");

const router = express.Router();

function baseUrl(req) {
  return process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get("host")}`;
}

async function loadAdminData() {
  const [events, rounds, shifts, members] = await Promise.all([
    pool.query("SELECT * FROM events ORDER BY starts_at DESC LIMIT 10"),
    pool.query("SELECT * FROM charity_rounds ORDER BY opens_at DESC LIMIT 5"),
    pool.query(
      `SELECT s.*, (SELECT COUNT(*) FROM volunteer_signups g WHERE g.shift_id = s.id) AS signup_count
       FROM volunteer_shifts s WHERE s.starts_at >= now() ORDER BY s.starts_at ASC LIMIT 15`
    ),
    pool.query("SELECT id, email, display_name, is_admin FROM users ORDER BY created_at DESC LIMIT 50"),
  ]);
  return { events: events.rows, rounds: rounds.rows, shifts: shifts.rows, members: members.rows };
}

router.get("/admin", requireAdmin, async (req, res) => {
  const data = await loadAdminData();
  res.render("admin", { ...data, error: null, notice: null });
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

router.post("/admin/volunteer-shifts", requireAdmin, async (req, res) => {
  const role = (req.body.role || "").trim();
  const startsAt = req.body.startsAt;
  const endsAt = req.body.endsAt;
  const capacity = Math.max(1, Number(req.body.capacity) || 1);
  const notes = (req.body.notes || "").trim() || null;
  const repeatWeeks = Math.max(1, Math.min(52, Number(req.body.repeatWeeks) || 1));

  if (role && startsAt && endsAt) {
    const start = new Date(startsAt);
    const end = new Date(endsAt);
    const weekMs = 7 * 24 * 60 * 60 * 1000;

    for (let i = 0; i < repeatWeeks; i++) {
      const s = new Date(start.getTime() + i * weekMs);
      const e = new Date(end.getTime() + i * weekMs);
      await pool.query(
        `INSERT INTO volunteer_shifts (role, starts_at, ends_at, capacity, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [role, s.toISOString(), e.toISOString(), capacity, notes, req.session.user.id]
      );
    }
  }
  res.redirect("/admin");
});

router.post("/admin/volunteer-shifts/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM volunteer_shifts WHERE id = $1", [Number(req.params.id)]);
  res.redirect("/admin");
});

router.post("/admin/members/reset-password", requireAdmin, async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const data = await loadAdminData();

  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  const member = rows[0];
  if (!member) {
    return res.status(400).render("admin", { ...data, error: "No member found with that email.", notice: null });
  }

  await sendResetLink(member, baseUrl(req));
  res.render("admin", { ...data, error: null, notice: `Reset email sent to ${member.email}.` });
});

module.exports = router;
