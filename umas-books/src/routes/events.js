const express = require("express");
const { pool, withTransaction } = require("../db");
const { groupByDate, monthParam, resolveCalendarRange, calendarBackQuery } = require("../lib/calendar");
const { baseUrl } = require("../lib/baseUrl");
const { isEmail, clean } = require("../lib/validation");
const { eventSignupLimiter } = require("../middleware/rateLimits");

const { validateIdParams } = require("../middleware/idParams");

const router = express.Router();
// Garbage ids get the 404 page, not a Postgres 22P02 and a 500.
validateIdParams(router, "id");

// Public — no login required. Anyone can view the calendar and sign up.

// Public JSON, cross-origin — consumed by the marketing site's Events
// page so it can show the actual upcoming schedule inline instead of
// just linking out to it. Same CORS treatment as
// /api/books/latest-arrivals: Access-Control-Allow-Origin alone isn't
// enough, helmet's Cross-Origin-Resource-Policy: same-origin blocks the
// read independently of CORS unless relaxed here too.
router.get("/api/events/upcoming", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  res.set("Cache-Control", "public, max-age=60");
  const { rows } = await pool.query(
    `SELECT e.*, (SELECT COUNT(*) FROM event_signups s WHERE s.event_id = e.id) AS signup_count
     FROM events e WHERE e.starts_at >= now() ORDER BY e.starts_at ASC LIMIT 10`
  );
  res.json(
    rows.map((e) => {
      const starts = new Date(e.starts_at);
      return {
        id: e.id,
        title: e.title,
        description: e.description,
        location: e.location,
        startsAt: e.starts_at,
        endsAt: e.ends_at,
        capacity: e.capacity,
        signupCount: e.signup_count,
        url: `${baseUrl(req)}/events?month=${monthParam(starts.getFullYear(), starts.getMonth())}`,
      };
    })
  );
});

router.get("/events", async (req, res) => {
  const range = resolveCalendarRange(req.query, 1, req.lang);

  const { rows: events } = await pool.query(
    `SELECT e.*, (SELECT COUNT(*) FROM event_signups s WHERE s.event_id = e.id) AS signup_count
     FROM events e WHERE e.starts_at >= $1 AND e.starts_at < $2 ORDER BY e.starts_at ASC`,
    [range.start, range.end]
  );

  const weeks = range.buildWeeks(groupByDate(events, "starts_at"));
  res.render("events", { weeks, view: range.view, ...range.nav });
});

function icsDate(d) {
  return new Date(d).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}
function icsEscape(text) {
  return String(text || "").replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\r?\n/g, "\\n");
}

// "Add to My Calendar" — a plain .ics download rather than a Google/Apple/
// Outlook API integration, so it works with any calendar app the person
// already has and needs no OAuth or API keys. Public, like the rest of
// the events feature: no account needed to sign up, so none is needed to
// save the date either.
router.get("/events/:id/ics", async (req, res) => {
  const eventId = Number(req.params.id);
  const { rows } = await pool.query("SELECT * FROM events WHERE id = $1", [eventId]);
  const event = rows[0];
  if (!event) return res.status(404).send(req.tr("Event not found.", "Événement introuvable."));

  const startsAt = new Date(event.starts_at);
  const endsAt = event.ends_at ? new Date(event.ends_at) : new Date(startsAt.getTime() + 60 * 60 * 1000);

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Uma's Books and Adventures//Events//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:event-${event.id}@umasbooks.org`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(startsAt)}`,
    `DTEND:${icsDate(endsAt)}`,
    `SUMMARY:${icsEscape(event.title)}`,
    event.description ? `DESCRIPTION:${icsEscape(event.description)}` : null,
    event.location ? `LOCATION:${icsEscape(event.location)}` : null,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);

  res.set("Content-Type", "text/calendar; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="${event.id}-${event.title.replace(/[^a-z0-9]+/gi, "-")}.ics"`);
  res.send(lines.join("\r\n"));
});

router.post("/events/:id/signup", eventSignupLimiter, async (req, res) => {
  const eventId = Number(req.params.id);
  const name = clean(req.body.name, 100);
  const email = clean(req.body.email, 200).toLowerCase();
  const backQuery = calendarBackQuery(req.query);
  const redirectUrl = backQuery ? `/events?${backQuery}` : "/events";

  if (!name || !isEmail(email)) return res.redirect(redirectUrl);

  try {
    await withTransaction(pool, async (client) => {
      // Lock the event row so two signups arriving at the same moment
      // can't both read the same "spots left" and both squeeze in — the
      // second one blocks here until the first commits, then re-reads
      // the count for real within its own transaction. Same pattern as
      // the drop-in seat checkout in lib/cart.js.
      const { rows: eventRows } = await client.query("SELECT * FROM events WHERE id = $1 FOR UPDATE", [eventId]);
      const event = eventRows[0];
      if (!event) throw new Error("EVENT_NOT_FOUND");

      if (event.capacity != null) {
        const { rows: countRows } = await client.query(
          "SELECT COUNT(*)::int AS n FROM event_signups WHERE event_id = $1", [eventId]
        );
        if (countRows[0].n >= event.capacity) throw new Error("AT_CAPACITY");
      }

      await client.query(
        "INSERT INTO event_signups (event_id, name, email) VALUES ($1, $2, $3) ON CONFLICT (event_id, email) DO NOTHING",
        [eventId, name, email]
      );
    });
  } catch (err) {
    if (err.message === "EVENT_NOT_FOUND") return res.status(404).send(req.tr("Event not found.", "Événement introuvable."));
    if (err.message === "AT_CAPACITY") return res.redirect(redirectUrl);
    throw err;
  }
  res.redirect(redirectUrl);
});

module.exports = router;
