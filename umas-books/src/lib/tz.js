// Uma's Books is in Albi: every date and time the admins type, and every
// one shown to people, means FRANCE time (Europe/Paris), not UTC. Render's
// servers run in UTC, which used to make a typed "18:00" be saved as 18:00Z
// (20:00 in Paris in summer) and shown inconsistently across pages.
//
// Setting the process timezone makes every `new Date("2026-07-15T18:00")`
// (typed, no offset) mean 18:00 Paris, and every local getter / default
// toLocale* format (calendar grouping, month maths, emails) use Paris time.
// Postgres still stores the exact instant (timestamptz); we just always hand
// it an unambiguous Date. Required first by index.js, db.js and the date
// libraries so even unit tests and scripts get the same behaviour.
const SITE_TIME_ZONE = "Europe/Paris";
if (process.env.TZ !== SITE_TIME_ZONE) process.env.TZ = SITE_TIME_ZONE;

// The Paris calendar date (YYYY-MM-DD) of an instant.
function parisDateString(date) {
  return new Date(date).toLocaleDateString("en-CA", { timeZone: SITE_TIME_ZONE });
}

// The instant at which a Paris wall-clock moment happens: parisInstant("2026-10-31") is the START of
// that day in Paris (22:00Z or 23:00Z the day before), parisInstant("2026-10-31", "18:30") is 18:30
// Paris time. A date-only string given to `new Date()` means UTC midnight, which is 01:00 or 02:00 in
// Paris: a post "published on the 31st" would appear in the middle of the night. Returns null when the
// date (or time) is not valid. Works whatever the process TZ is.
function parisInstant(dateStr, timeStr = "00:00") {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
  const t = /^(\d{2}):(\d{2})$/.exec(String(timeStr || "00:00"));
  if (!d || !t) return null;
  const [y, mo, da, hh, mi] = [d[1], d[2], d[3], t[1], t[2]].map(Number);
  const wall = Date.UTC(y, mo - 1, da, hh, mi);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== da || hh > 23 || mi > 59) return null;
  // Paris is UTC+1 (winter) or UTC+2 (summer): try the two offsets and keep the one that reads back as the same wall time.
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: SITE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const wallOf = (ms) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  };
  for (const offsetH of [2, 1]) {
    const candidate = wall - offsetH * 3600000;
    if (wallOf(candidate) === wall) return new Date(candidate);
  }
  return new Date(wall - 3600000); // a wall time that does not exist (spring-forward gap): the hour after
}

module.exports = { SITE_TIME_ZONE, parisDateString, parisInstant };
