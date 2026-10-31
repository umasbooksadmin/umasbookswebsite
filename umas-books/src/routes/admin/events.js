const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { parseWholeNumber, parseMoney } = require("../../lib/validation");
const { parseLocalDateTime } = require("../../lib/dates");
const { groupByDate, resolveCalendarRange, calendarBackQuery } = require("../../lib/calendar");
const frenchText = require("../../lib/frenchText");
const { setFlash, takeFlash } = require("../../lib/flash");
const { LIMITS, lengthProblem, timeRangeProblem, typedButInvalid, createOnce, DUPLICATE_WINDOW_SECONDS, findReversedRanges } = require("../../lib/adminForm");

const { validateIdParams } = require("../../middleware/idParams");

const router = express.Router();
// Garbage ids get the 404 page, not a Postgres 22P02 and a 500.
validateIdParams(router, "id", "signupId");

// ---------- Events (public sign-up) ----------

const asTyped = (raw) => (typeof raw === "string" ? raw.slice(0, 200) : "");

// A refused form answers with a redirect back to the calendar (Post/Redirect/Get):
// the message and what was typed are carried once in the session. `overlay` is
// { newDate | eventId, values } (display only, nothing in it is saved).
async function refuseAndRedirect(req, res, calendarQuery, state) {
  await setFlash(req, "events", state);
  const backQuery = calendarBackQuery(calendarQuery);
  res.redirect(303, backQuery ? `/admin/events?${backQuery}` : "/admin/events");
}

router.get("/admin/events", requireAdmin, async (req, res) => {
  const f = takeFlash(req, "events");
  const range = resolveCalendarRange(req.query, 0);
  const { rows: events } = await pool.query(
    `SELECT e.*, (SELECT COUNT(*) FROM event_signups s WHERE s.event_id = e.id) AS signup_count
     FROM events e WHERE e.starts_at >= $1 AND e.starts_at < $2 ORDER BY e.starts_at ASC`,
    [range.start, range.end]
  );
  const eventIds = events.map((e) => e.id);
  const { rows: signupRows } = eventIds.length
    ? await pool.query("SELECT * FROM event_signups WHERE event_id = ANY($1) ORDER BY created_at ASC", [eventIds])
    : { rows: [] };
  const signupsByEvent = {};
  for (const s of signupRows) {
    if (!signupsByEvent[s.event_id]) signupsByEvent[s.event_id] = [];
    signupsByEvent[s.event_id].push(s);
  }

  const weeks = range.buildWeeks(groupByDate(events, "starts_at"));
  const badRanges = await findReversedRanges(pool, "events");
  res.render("admin/events", { active: "events", fr: frenchText, error: f && f.error ? String(f.error) : null, formOverlay: (f && f.overlay) || null, badRanges, weeks, signupsByEvent, view: range.view, ...range.nav });
});

router.post("/admin/events", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim() || null;
  const location = (req.body.location || "").trim() || null;
  const date = req.body.date;
  const startTime = req.body.startTime;
  const endTime = req.body.endTime || null;
  // A capacity or price that is not a sensible number is refused with a message, instead of reaching Postgres.
  const capacityNum = parseWholeNumber(req.body.capacity, { min: 0, max: 100000, allowBlank: true, label: "Capacity" });
  const priceNum = parseMoney(req.body.price, { allowBlank: true, label: "Price" });
  const capacity = capacityNum.value == null ? null : capacityNum.value;
  const price = priceNum.value == null ? null : priceNum.value;
  const startsAt = date && startTime ? parseLocalDateTime(date, startTime) : null;
  const endsAt = endTime ? parseLocalDateTime(date, endTime) : null;

  const problem = capacityNum.error || priceNum.error
    || lengthProblem([["The title", title, LIMITS.title], ["The location", location, LIMITS.line], ["The description", description, LIMITS.text]])
    || (title && date && startTime && !startsAt ? "That date or start time is not a real date and time. Nothing was saved." : null)
    || (typedButInvalid(endTime, endsAt) ? "That end time is not a real time. Nothing was saved." : null)
    || timeRangeProblem(startsAt, endsAt, "An event");
  if (problem) {
    return refuseAndRedirect(req, res, req.body, {
      error: problem,
      overlay: {
        newDate: asTyped(date),
        values: { title, startTime: asTyped(startTime), endTime: asTyped(req.body.endTime), location: location || "", capacity: asTyped(req.body.capacity), price: asTyped(req.body.price) },
      },
    });
  }

  if (title && startsAt) {
    // The same form arriving twice in a minute (a double click) makes one event.
    await createOnce(
      pool, `event:${title}|${startsAt.toISOString()}`,
      `SELECT 1 FROM events WHERE title = $1 AND starts_at = $2 AND created_at > now() - interval '${DUPLICATE_WINDOW_SECONDS} seconds'`,
      [title, startsAt],
      (client) => client.query(
        `INSERT INTO events (title, description, location, starts_at, ends_at, capacity, price, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [title, description, location, startsAt, endsAt, capacity, price, req.session.user.id]
      )
    );
  }
  const backQuery = calendarBackQuery(req.body);
  res.redirect(backQuery ? `/admin/events?${backQuery}` : "/admin/events");
});

router.post("/admin/events/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim() || null;
  const location = (req.body.location || "").trim() || null;
  const startsAt = parseLocalDateTime(req.body.startsAt);
  const endsAt = req.body.endsAt ? parseLocalDateTime(req.body.endsAt) : null;
  const capacityNum = parseWholeNumber(req.body.capacity, { min: 0, max: 100000, allowBlank: true, label: "Capacity" });
  const priceNum = parseMoney(req.body.price, { allowBlank: true, label: "Price" });
  const capacity = capacityNum.value == null ? null : capacityNum.value;
  const price = priceNum.value == null ? null : priceNum.value;
  // The optional French version (title, description, place): "" is stored as NULL = no French for that part.
  const french = frenchText.readFrench("event", req.body);

  const problem = capacityNum.error || priceNum.error
    || lengthProblem([
      ["The title", title, LIMITS.title], ["The location", location, LIMITS.line], ["The description", description, LIMITS.text],
      ["The French title", french.title_fr, LIMITS.title], ["The French location", french.location_fr, LIMITS.line], ["The French description", french.description_fr, LIMITS.text],
    ])
    || (typedButInvalid(req.body.startsAt, startsAt) ? "That start is not a real date and time. Nothing was saved." : null)
    || (typedButInvalid(req.body.endsAt, endsAt) ? "That end is not a real date and time. Nothing was saved." : null)
    || timeRangeProblem(startsAt, endsAt, "An event");
  if (problem) {
    return refuseAndRedirect(req, res, req.query, {
      error: problem,
      overlay: {
        eventId: id,
        values: {
          title, description: description || "", location: location || "", startsAt: asTyped(req.body.startsAt), endsAt: asTyped(req.body.endsAt),
          capacity: asTyped(req.body.capacity), price: asTyped(req.body.price),
          title_fr: french.title_fr || "", description_fr: french.description_fr || "", location_fr: french.location_fr || "",
        },
      },
    });
  }

  if (title && startsAt) {
    await pool.query(
      `UPDATE events SET title=$1, description=$2, location=$3, starts_at=$4, ends_at=$5, capacity=$6, price=$7,
         title_fr=$9, description_fr=$10, location_fr=$11
       WHERE id = $8`,
      [title, description, location, startsAt, endsAt, capacity, price, id, french.title_fr, french.description_fr, french.location_fr]
    );
  }
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/events?${backQuery}` : "/admin/events");
});

router.post("/admin/events/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM events WHERE id = $1", [Number(req.params.id)]);
  await audit(req, { action: "event.delete", targetType: "event", targetId: Number(req.params.id) });
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/events?${backQuery}` : "/admin/events");
});

router.post("/admin/events/:id/signups/:signupId/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM event_signups WHERE id = $1 AND event_id = $2", [Number(req.params.signupId), Number(req.params.id)]);
  await audit(req, { action: "event.signup_delete", targetType: "event_signup", targetId: Number(req.params.signupId) });
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/events?${backQuery}` : "/admin/events");
});

module.exports = router;
