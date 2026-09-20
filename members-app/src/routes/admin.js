const express = require("express");
const { pool } = require("../db");
const { requireAdmin } = require("../middleware/auth");
const { parseMonthParam, monthRange, monthGrid, groupByDate, monthNav } = require("../lib/calendar");

const router = express.Router();

// ---------- Overview ----------

router.get("/admin", requireAdmin, async (req, res) => {
  const [memberCount, upcomingShifts, activeRound, nextMeeting] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS n FROM users"),
    pool.query("SELECT COUNT(*)::int AS n FROM volunteer_shifts WHERE starts_at >= now()"),
    pool.query("SELECT * FROM charity_rounds WHERE is_active = TRUE ORDER BY opens_at DESC LIMIT 1"),
    pool.query("SELECT * FROM meetings WHERE scheduled_at >= now() ORDER BY scheduled_at ASC LIMIT 1"),
  ]);

  res.render("admin/index", {
    active: "overview",
    memberCount: memberCount.rows[0].n,
    upcomingShiftCount: upcomingShifts.rows[0].n,
    activeRound: activeRound.rows[0] || null,
    nextMeeting: nextMeeting.rows[0] || null,
  });
});

// ---------- Members ----------

router.get("/admin/members", requireAdmin, async (req, res) => {
  const { rows: members } = await pool.query("SELECT id, email, display_name, is_admin FROM users ORDER BY created_at DESC LIMIT 200");
  res.render("admin/members", { active: "members", members });
});

// ---------- Announcements ----------

router.get("/admin/announcements", requireAdmin, async (req, res) => {
  const { rows: announcements } = await pool.query("SELECT * FROM announcements ORDER BY published_at DESC LIMIT 20");
  res.render("admin/announcements", { active: "announcements", announcements });
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
  res.redirect("/admin/announcements");
});

// ---------- Volunteer shifts ----------

router.get("/admin/volunteer-shifts", requireAdmin, async (req, res) => {
  const { year, month } = parseMonthParam(req.query.month);
  const { start, end } = monthRange(year, month);
  const { rows: shifts } = await pool.query(
    `SELECT s.*, (SELECT COUNT(*) FROM volunteer_signups g WHERE g.shift_id = s.id) AS signup_count
     FROM volunteer_shifts s WHERE s.starts_at >= $1 AND s.starts_at < $2 ORDER BY s.starts_at ASC`,
    [start, end]
  );
  const weeks = monthGrid(year, month, groupByDate(shifts, "starts_at"));
  res.render("admin/volunteer", { active: "volunteer", weeks, ...monthNav(year, month) });
});

router.post("/admin/volunteer-shifts", requireAdmin, async (req, res) => {
  const role = (req.body.role || "").trim();
  const startsAt = req.body.startsAt;
  const endsAt = req.body.endsAt;
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
         VALUES ($1, $2, $3, 1, $4, $5)`,
        [role, s.toISOString(), e.toISOString(), notes, req.session.user.id]
      );
    }
  }
  res.redirect(req.body.month ? `/admin/volunteer-shifts?month=${req.body.month}` : "/admin/volunteer-shifts");
});

router.post("/admin/volunteer-shifts/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM volunteer_shifts WHERE id = $1", [Number(req.params.id)]);
  res.redirect(req.query.month ? `/admin/volunteer-shifts?month=${req.query.month}` : "/admin/volunteer-shifts");
});

// ---------- Meetings ----------

router.get("/admin/meetings", requireAdmin, async (req, res) => {
  const { year, month } = parseMonthParam(req.query.month);
  const { start, end } = monthRange(year, month);
  const { rows: meetings } = await pool.query(
    `SELECT m.*, (SELECT COUNT(*) FROM meeting_rsvps r WHERE r.meeting_id = m.id) AS rsvp_count
     FROM meetings m WHERE m.scheduled_at >= $1 AND m.scheduled_at < $2 ORDER BY m.scheduled_at ASC`,
    [start, end]
  );
  const weeks = monthGrid(year, month, groupByDate(meetings, "scheduled_at"));
  res.render("admin/meetings", { active: "meetings", weeks, ...monthNav(year, month) });
});

router.post("/admin/meetings", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const scheduledAt = req.body.scheduledAt;
  const location = (req.body.location || "").trim() || null;
  const agenda = (req.body.agenda || "").trim() || null;

  if (title && scheduledAt) {
    await pool.query(
      `INSERT INTO meetings (title, scheduled_at, location, agenda, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [title, scheduledAt, location, agenda, req.session.user.id]
    );
  }
  res.redirect(req.body.month ? `/admin/meetings?month=${req.body.month}` : "/admin/meetings");
});

router.post("/admin/meetings/:id/minutes", requireAdmin, async (req, res) => {
  const minutes = (req.body.minutes || "").trim() || null;
  await pool.query("UPDATE meetings SET minutes = $1 WHERE id = $2", [minutes, Number(req.params.id)]);
  res.redirect(req.query.month ? `/admin/meetings?month=${req.query.month}` : "/admin/meetings");
});

router.post("/admin/meetings/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM meetings WHERE id = $1", [Number(req.params.id)]);
  res.redirect(req.query.month ? `/admin/meetings?month=${req.query.month}` : "/admin/meetings");
});

// ---------- Charity vote ----------

router.get("/admin/charity", requireAdmin, async (req, res) => {
  const { rows: rounds } = await pool.query("SELECT * FROM charity_rounds ORDER BY opens_at DESC LIMIT 10");
  res.render("admin/charity", { active: "charity", rounds });
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
  res.redirect("/admin/charity");
});

router.post("/admin/charity-rounds/:id/close", requireAdmin, async (req, res) => {
  await pool.query(
    "UPDATE charity_rounds SET is_active = FALSE, closes_at = now() WHERE id = $1",
    [Number(req.params.id)]
  );
  res.redirect("/admin/charity");
});

module.exports = router;
