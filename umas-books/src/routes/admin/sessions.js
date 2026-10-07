const express = require("express");
const { pool, withTransaction } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { parseLocalDateTime } = require("../../lib/dates");
const { groupByDate, resolveCalendarRange, calendarBackQuery } = require("../../lib/calendar");
const { seatsTakenExpr } = require("../../lib/classCapacity");
const { setFlash, takeFlash } = require("../../lib/flash");
const { parseMoney, parseWholeNumber } = require("../../lib/validation");

const { validateIdParams } = require("../../middleware/idParams");

const router = express.Router();
// Garbage ids get the 404 page, not a Postgres 22P02 and a 500.
validateIdParams(router, "id", "signupId");

// ---------- Sessions (public sign-up) ----------

const PROGRAM_TYPES = ["Little Explorers", "Éveil English", "Young Adventurers", "Young Readers", "Teen Literature", "English Café"];

// Capacity and drop-in price typed by an admin (see lib/validation.js). A blank
// drop-in price means "not sold as drop-in"; a drop-in price is at least 1 cent
// (0 would be a free seat the cart cannot charge for).
const MAX_CAPACITY = 1000;
const parseCapacity = (raw) => parseWholeNumber(raw, { min: 1, max: MAX_CAPACITY, allowBlank: true, label: "Capacity" });
const parseDropinPrice = (raw) => parseMoney(raw, { min: 0.01, allowBlank: true, label: "Drop-in price" });
const asTyped = (raw) => (typeof raw === "string" ? raw.slice(0, 200) : "");

// `overlay` keeps what was typed in a form that was refused: { classId | newDate,
// values } (display only, nothing in it is saved).
async function renderSessions(res, calendarQuery, { error = null, notice = null, overlay = null } = {}) {
  const range = resolveCalendarRange(calendarQuery, 0);
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
        `SELECT d.id, d.class_id, d.status, d.order_id, o.buyer_name, o.buyer_email, d.created_at
         FROM class_dropin_seats d JOIN orders o ON o.id = d.order_id
         WHERE d.class_id = ANY($1) AND d.status IN ('reserved', 'sold') ORDER BY d.created_at ASC`,
        [classIds]
      )
    : { rows: [] };
  const dropinByClass = {};
  for (const d of dropinRows) {
    if (!dropinByClass[d.class_id]) dropinByClass[d.class_id] = [];
    dropinByClass[d.class_id].push(d);
  }

  const weeks = range.buildWeeks(groupByDate(classes, "starts_at"));
  res.render("admin/sessions", { active: "sessions", notice, error, formOverlay: overlay, weeks, signupsByClass, dropinByClass, programTypes: PROGRAM_TYPES, view: range.view, ...range.nav });
}

// A refused form answers with a redirect back to the calendar (Post/Redirect/Get):
// the message and what was typed are carried once in the session.
async function refuseAndRedirect(req, res, calendarQuery, state) {
  await setFlash(req, "sessions", state);
  const backQuery = calendarBackQuery(calendarQuery);
  res.redirect(303, backQuery ? `/admin/sessions?${backQuery}` : "/admin/sessions");
}

router.get("/admin/sessions", requireAdmin, async (req, res) => {
  const f = takeFlash(req, "sessions");
  if (f && f.error) return renderSessions(res, req.query, { error: String(f.error), overlay: f.overlay || null });
  await renderSessions(res, req.query, {
    notice: req.query.notice === "has-orders" ? "This item has orders, so it can't be deleted (mark it sold/archived instead)." : null,
  });
});

router.post("/admin/sessions", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim() || null;
  const location = (req.body.location || "").trim() || null;
  const date = req.body.date;
  const startTime = req.body.startTime;
  const endTime = req.body.endTime || null;
  const capacityCheck = parseCapacity(req.body.capacity);
  const dropinCheck = parseDropinPrice(req.body.dropinPrice);
  // A new session with no capacity typed gets the form's default of 5.
  const capacity = capacityCheck.value ?? 5;
  const dropinPrice = dropinCheck.value ?? null;
  const programType = PROGRAM_TYPES.includes(req.body.programType) ? req.body.programType : null;

  const inputError = capacityCheck.error || dropinCheck.error;
  if (inputError) {
    return refuseAndRedirect(req, res, req.body, {
      error: inputError,
      overlay: {
        newDate: asTyped(date),
        values: { title, programType: programType || "", startTime: asTyped(startTime), endTime: asTyped(req.body.endTime), location: location || "", capacity: asTyped(req.body.capacity), dropinPrice: asTyped(req.body.dropinPrice) },
      },
    });
  }

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
  const capacityCheck = parseCapacity(req.body.capacity);
  const dropinCheck = parseDropinPrice(req.body.dropinPrice);
  const programType = PROGRAM_TYPES.includes(req.body.programType) ? req.body.programType : null;

  const refuse = (error) => {
    return refuseAndRedirect(req, res, req.query, {
      error,
      overlay: {
        classId: id,
        values: { title, description: description || "", location: location || "", programType: programType || "", capacity: asTyped(req.body.capacity), dropinPrice: asTyped(req.body.dropinPrice) },
      },
    });
  };
  const inputError = capacityCheck.error || dropinCheck.error;
  if (inputError) return refuse(inputError);

  let problem = null;
  if (title && startsAt) {
    // The class row is locked first: checkout locks it too before taking a seat,
    // so the seat counts below cannot change under this edit.
    await withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        `SELECT c.capacity, c.dropin_price, ${seatsTakenExpr("c")}::int AS seats_taken,
                (SELECT COUNT(*) FROM class_dropin_seats d WHERE d.class_id = c.id AND d.status IN ('in_cart', 'reserved', 'sold'))::int AS paid_seats
         FROM classes c WHERE c.id = $1 FOR UPDATE OF c`,
        [id]
      );
      const cur = rows[0];
      if (!cur) return;
      // A blank capacity keeps the current one: it must never silently turn a
      // session into an unlimited one (a new session defaults to 5).
      const capacity = capacityCheck.value ?? cur.capacity;
      const dropinPrice = dropinCheck.value;
      if (capacity != null && capacity < cur.seats_taken) {
        problem = `Capacity can't be lowered to ${capacity}: ${cur.seats_taken} seat${cur.seats_taken === 1 ? " is" : "s are"} already booked.`;
        return;
      }
      if (dropinPrice == null && cur.dropin_price != null && cur.paid_seats > 0) {
        problem = `The drop-in price can't be cleared: ${cur.paid_seats} drop-in seat${cur.paid_seats === 1 ? " is" : "s are"} already reserved or paid. Change the price instead.`;
        return;
      }
      await client.query(
        `UPDATE classes SET title=$1, description=$2, location=$3, starts_at=$4, ends_at=$5, capacity=$6, dropin_price=$7, program_type=$8
         WHERE id = $9`,
        [title, description, location, startsAt, endsAt, capacity, dropinPrice, programType, id]
      );
    });
  }
  if (problem) return refuse(problem);
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/sessions?${backQuery}` : "/admin/sessions");
});

router.post("/admin/sessions/:id/delete", requireAdmin, async (req, res) => {
  const backQuery = calendarBackQuery(req.query);
  try {
    await pool.query("DELETE FROM classes WHERE id = $1", [Number(req.params.id)]);
  } catch (err) {
    // Drop-in seats that were ever ordered are referenced by order_items.
    if (err.code !== "23503") throw err;
    return res.redirect(`/admin/sessions?${backQuery ? `${backQuery}&` : ""}notice=has-orders`);
  }
  await audit(req, { action: "session.delete", targetType: "class", targetId: Number(req.params.id) });
  res.redirect(backQuery ? `/admin/sessions?${backQuery}` : "/admin/sessions");
});

router.post("/admin/sessions/:id/signups/:signupId/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM class_signups WHERE id = $1 AND class_id = $2", [Number(req.params.signupId), Number(req.params.id)]);
  await audit(req, { action: "session.signup_delete", targetType: "class_signup", targetId: Number(req.params.signupId) });
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/sessions?${backQuery}` : "/admin/sessions");
});

module.exports = router;
