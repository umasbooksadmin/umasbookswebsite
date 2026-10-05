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

module.exports = { SITE_TIME_ZONE };
