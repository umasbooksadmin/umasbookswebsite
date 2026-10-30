const { parisDateString } = require("./tz");

// Checks shared by the admin create/edit forms (events, sessions, meetings,
// volunteer shifts, announcements, charity, blog). Admin screens are English
// only, so the messages are too.

// Longest text a form field accepts. Generous for anything a person types, and
// well under what a paste of a whole web page would be.
const LIMITS = {
  title: 200, // a title, a name, a role
  line: 200, // a location, a label
  text: 5000, // a description, an agenda, notes
  longText: 50000, // meeting minutes
  richText: 100000, // an announcement or blog body (HTML, after cleaning)
};

// fields: [[label, value, max], ...]. The first one over its limit gives the
// sentence to show; null when all fit. Nothing is ever cut off silently.
function lengthProblem(fields) {
  for (const [label, value, max] of fields) {
    if (typeof value === "string" && value.length > max) {
      return `${label} is too long (${value.length.toLocaleString("en-GB")} characters; the limit is ${max.toLocaleString("en-GB")}). Nothing was saved.`;
    }
  }
  return null;
}

// An end must be after its start. `endsAt` is optional (null = no end time).
function timeRangeProblem(startsAt, endsAt, what = "It") {
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
    return `${what} must end after it starts: the end time is not later than the start time. Nothing was saved.`;
  }
  return null;
}

// Whether a typed value is present but not a real date/time (so it can be told
// apart from "left blank").
const typedButInvalid = (raw, parsed) => typeof raw === "string" && raw.trim() !== "" && !parsed;

// Creates a row once even when the same form arrives twice (a double click, a
// slow connection and a second tap): under an advisory lock for `key`, `existsSql`
// looks for an identical row made in the last minute and `insert(client)` runs
// only when there is none. Resolves true when the row was made, false for a repeat.
// existsSql must select something for a repeat and refer to its parameters as $1...
const DUPLICATE_WINDOW_SECONDS = 60;
async function createOnce(pool, key, existsSql, existsParams, insert) {
  const { withTransaction } = require("../db");
  return withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
    const { rows } = await client.query(existsSql, existsParams);
    if (rows.length) return false;
    await insert(client);
    return true;
  });
}

// Rows already saved with an end that is not after the start (made before the
// form checked it). Read-only: nothing is changed. Table names are fixed here.
const RANGE_TABLES = {
  classes: { label: "Session", column: "title", path: "/admin/sessions", editable: true },
  events: { label: "Event", column: "title", path: "/admin/events", editable: true },
  volunteer_shifts: { label: "Volunteer shift", column: "role", path: "/admin/volunteer-shifts", editable: false },
};
async function findReversedRanges(pool, table) {
  const t = RANGE_TABLES[table];
  if (!t) throw new Error(`findReversedRanges: unknown table ${table}`);
  const { rows } = await pool.query(
    `SELECT id, ${t.column} AS name, starts_at, ends_at FROM ${table}
     WHERE ends_at IS NOT NULL AND ends_at <= starts_at ORDER BY starts_at DESC LIMIT 20`
  );
  return rows.map((r) => ({ ...r, month: parisDateString(r.starts_at).slice(0, 7) }));
}

module.exports = { LIMITS, lengthProblem, timeRangeProblem, typedButInvalid, createOnce, DUPLICATE_WINDOW_SECONDS, findReversedRanges, RANGE_TABLES };
