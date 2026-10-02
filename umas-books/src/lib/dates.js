// Display formatting helpers, exposed to every EJS view via app.locals.
// Fixed to en-GB (DD/MM/YYYY, 24-hour clock) in Europe/Paris rather than
// relying on the server's default locale or timezone, since Uma's Books is
// in France (see lib/tz.js). Values fed to <input type="date"> still use ISO
// (YYYY-MM-DD) elsewhere — that's an HTML input requirement, not a display
// choice, so it's untouched here.
const { SITE_TIME_ZONE } = require("./tz");

function formatDate(d) {
  return new Date(d).toLocaleDateString("en-GB", { timeZone: SITE_TIME_ZONE });
}

function formatDateTime(d) {
  return new Date(d).toLocaleString("en-GB", {
    timeZone: SITE_TIME_ZONE,
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function formatTime(d) {
  return new Date(d).toLocaleTimeString("en-GB", { timeZone: SITE_TIME_ZONE, hour: "2-digit", minute: "2-digit" });
}

// A date and time typed in an admin form ("2026-07-15" + "18:00", or a
// datetime-local value "2026-07-15T18:00") as a real instant, read as Paris
// time. Returns null for anything that isn't a valid date/time so callers can
// skip the write instead of storing garbage.
function parseLocalDateTime(dateOrDateTime, time) {
  if (typeof dateOrDateTime !== "string" || !dateOrDateTime) return null;
  const text = time ? `${dateOrDateTime}T${time}` : dateOrDateTime;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(text)) return null;
  const d = new Date(text); // no offset in the string => process timezone => Paris
  return Number.isNaN(d.getTime()) ? null : d;
}

// The same Paris wall-clock time on each of `weeks` consecutive weeks.
// Adding 7*24h to an instant would drift an hour across a clock change (an
// 18:00 shift would become 17:00 after the last Sunday of October); building
// each week from calendar fields keeps it at 18:00.
function weeklyDateTimes(date, time, weeks) {
  const first = parseLocalDateTime(date, time);
  if (!first) return [];
  const out = [];
  for (let i = 0; i < weeks; i++) {
    out.push(new Date(first.getFullYear(), first.getMonth(), first.getDate() + 7 * i, first.getHours(), first.getMinutes()));
  }
  return out;
}

module.exports = { formatDate, formatDateTime, formatTime, parseLocalDateTime, weeklyDateTimes };
