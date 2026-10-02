const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { parseLocalDateTime } = require("../../lib/dates");
const { groupByDate, resolveCalendarRange, calendarBackQuery } = require("../../lib/calendar");
const { seatsTakenExpr } = require("../../lib/classCapacity");

const { validateIdParams } = require("../../middleware/idParams");

const router = express.Router();
// Garbage ids get the 404 page, not a Postgres 22P02 and a 500.
validateIdParams(router, "id", "signupId");

// ---------- Sessions (public sign-up) ----------

const PROGRAM_TYPES = ["Little Explorers", "Éveil English", "Young Adventurers", "Young Readers", "Teen Literature", "English Café"];

router.get("/admin/sessions", requireAdmin, async (req, res) => {
  const range = resolveCalendarRange(req.query, 0);
  const { rows: classes } = await pool.query(
    `SELECT c.*, ${seatsTakenExpr("c")}::int AS seats_taken
     FROM classes c WHERE c.starts_at >= $1 AND c.starts_at < $2 ORDER BY c.starts_at ASC`,
    [range.start, range.end]
  );
  const classIds = classes.map((c) => c.id);
  const { rows: signupRows } = classIds.length
    ? await pool.query("SELECT * FROM class_signups WHERE class_id = ANY($1) ORDER BY created_at ASC", [classIds])
    : { rows: [] };
  const signupsByClass = {};
  for (const s of signupRows) {
    if (!signupsByClass[s.class_id]) signupsByClass[s.class_id] = [];
    signupsByClass[s.class_id].push(s);
  }

  const { rows: dropinRows } = classIds.length
    ? await pool.query(
        `SELECT d.id, d.class_id, o.buyer_name, o.buyer_email, d.created_at
         FROM class_dropin_seats d JOIN orders o ON o.id = d.order_id
         WHERE d.class_id = ANY($1) AND d.status = 'sold' ORDER BY d.created_at ASC`,
        [classIds]
      )
    : { rows: [] };
  const dropinByClass = {};
  for (const d of dropinRows) {
    if (!dropinByClass[d.class_id]) dropinByClass[d.class_id] = [];
    dropinByClass[d.class_id].push(d);
  }

  const weeks = range.buildWeeks(groupByDate(classes, "starts_at"));
  res.render("admin/sessions", { active: "sessions", weeks, signupsByClass, dropinByClass, programTypes: PROGRAM_TYPES, view: range.view, ...range.nav });
});

router.post("/admin/sessions", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim() || null;
  const location = (req.body.location || "").trim() || null;
  const date = req.body.date;
  const startTime = req.body.startTime;
  const endTime = req.body.endTime || null;
  const capacity = req.body.capacity ? Number(req.body.capacity) : 5;
  const dropinPrice = req.body.dropinPrice ? Number(req.body.dropinPrice) : null;
  const programType = PROGRAM_TYPES.includes(req.body.programType) ? req.body.programType : null;

  if (title && date && startTime) {
    const startsAt = parseLocalDateTime(date, startTime);
    const endsAt = endTime ? parseLocalDateTime(date, endTime) : null;
    if (!startsAt) return res.redirect("/admin/sessions");
    await pool.query(
      `INSERT INTO classes (title, description, location, starts_at, ends_at, capacity, dropin_price, program_type, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [title, description, location, startsAt, endsAt, capacity, dropinPrice, programType, req.session.user.id]
    );
  }
  const backQuery = calendarBackQuery(req.body);
  res.redirect(backQuery ? `/admin/sessions?${backQuery}` : "/admin/sessions");
});

router.post("/admin/sessions/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim() || null;
  const location = (req.body.location || "").trim() || null;
  const startsAt = parseLocalDateTime(req.body.startsAt);
  const endsAt = req.body.endsAt ? parseLocalDateTime(req.body.endsAt) : null;
  const capacity = req.body.capacity ? Number(req.body.capacity) : null;
  const dropinPrice = req.body.dropinPrice ? Number(req.body.dropinPrice) : null;
  const programType = PROGRAM_TYPES.includes(req.body.programType) ? req.body.programType : null;

  if (title && startsAt) {
    await pool.query(
      `UPDATE classes SET title=$1, description=$2, location=$3, starts_at=$4, ends_at=$5, capacity=$6, dropin_price=$7, program_type=$8
       WHERE id = $9`,
      [title, description, location, startsAt, endsAt, capacity, dropinPrice, programType, id]
    );
  }
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/sessions?${backQuery}` : "/admin/sessions");
});

router.post("/admin/sessions/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM classes WHERE id = $1", [Number(req.params.id)]);
  await audit(req, { action: "session.delete", targetType: "class", targetId: Number(req.params.id) });
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/sessions?${backQuery}` : "/admin/sessions");
});

router.post("/admin/sessions/:id/signups/:signupId/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM class_signups WHERE id = $1 AND class_id = $2", [Number(req.params.signupId), Number(req.params.id)]);
  await audit(req, { action: "session.signup_delete", targetType: "class_signup", targetId: Number(req.params.signupId) });
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/sessions?${backQuery}` : "/admin/sessions");
});

module.exports = router;
