// Emails an admin when something breaks in production. There's no
// dedicated error-tracking service (Sentry or similar) wired in — this
// piggybacks on the Gmail credentials already configured for the site
// (see mailer.js), which is free and needs no new account, at the cost
// of being far less capable than a real APM. Good enough to know
// something broke without waiting for a customer to say so; revisit if
// error volume ever justifies a real tool.
//
// Throttled to one email per window regardless of source (a route
// error, an unhandled rejection, or an uncaught exception all share the
// same clock) so an incident that fails repeatedly — e.g. the database
// is down — sends one alert, not one per request.
const { sendMail } = require("../mailer");

const ALERT_TO = process.env.CONTACT_TO || "admin@umasbooks.org";
const THROTTLE_MS = 15 * 60 * 1000;

let lastSentAt = 0;
let suppressedCount = 0;

function alertOnError(label, err) {
  const now = Date.now();
  if (now - lastSentAt < THROTTLE_MS) {
    suppressedCount++;
    return Promise.resolve();
  }
  const suppressedNote = suppressedCount > 0
    ? `\n\n(${suppressedCount} further error(s) suppressed in the last ${Math.round(THROTTLE_MS / 60000)} minutes — check the Render logs for the full picture.)`
    : "";
  lastSentAt = now;
  suppressedCount = 0;

  return sendMail({
    to: ALERT_TO,
    subject: `[umas-books] ${label}`,
    text: `${err && err.stack ? err.stack : String(err)}${suppressedNote}`,
  }).catch((mailErr) => console.error("Error-alert email itself failed:", mailErr.message));
}

module.exports = { alertOnError };
