// Emails an admin when something breaks in production. There's no
// dedicated error-tracking service (Sentry or similar) wired in — this
// piggybacks on the Gmail credentials already configured for the site
// (see mailer.js), which is free and needs no new account, at the cost
// of being far less capable than a real APM. Good enough to know
// something broke without waiting for a customer to say so; revisit if
// error volume ever justifies a real tool.
//
// Throttling, so an incident that fails repeatedly (e.g. the database is
// down) sends a few alerts, not one per request:
//   - per error signature (first line of the message, digits normalised): the same error is emailed at most once per window, so
//     one harmless repeated 500 cannot hide a *different*, real error;
//   - overall: at most MAX_ALERTS_PER_WINDOW emails per window whatever
//     the signatures, so a storm of distinct errors cannot flood the inbox.
//
// Alert text is scrubbed (non-forced alerts only, see `force` below) of email
// addresses and long digit runs (phone numbers) before it leaves the server: an error message can quote user
// input. Stack frames are kept.
const { sendMail } = require("../mailer");
const { scrubPersonalData } = require("./scrub");

const ALERT_TO = process.env.CONTACT_TO || "admin@umasbooks.org";
const THROTTLE_MS = 15 * 60 * 1000;
const MAX_ALERTS_PER_WINDOW = 6;

const lastSentBySignature = new Map();
let sentTimes = [];
let suppressedCount = 0;

function describe(err) {
  return err && err.stack ? err.stack : String(err);
}

function signatureOf(err) {
  const message = err && err.message !== undefined ? String(err.message) : String(err);
  const firstLine = message.split("\n")[0].replace(/\d+/g, "N").slice(0, 200);
  return firstLine;
}

function body(err) {
  return scrubPersonalData(describe(err));
}

// `force` skips the throttle (and leaves its clocks alone): for the rare
// alert that must not be swallowed because an unrelated error alert went
// out a few minutes earlier — e.g. "a customer's money was taken but the
// order can't be fulfilled" (lib/cart.js).
function alertOnError(label, err, { force = false } = {}) {
  const subject = `[umas-books] ${scrubPersonalData(label)}`;
  const fail = (mailErr) => console.error("Error-alert email itself failed:", mailErr.message);
  if (force) {
    // Money alerts are NOT scrubbed: the admin needs the buyer's email and
    // the order/intent ids to refund by hand, and they only go to her own inbox.
    return sendMail({ to: ALERT_TO, subject: `[umas-books] ${label}`, text: describe(err) }).catch(fail);
  }
  const now = Date.now();
  sentTimes = sentTimes.filter((t) => now - t < THROTTLE_MS);
  for (const [sig, at] of lastSentBySignature) {
    if (now - at >= THROTTLE_MS) lastSentBySignature.delete(sig);
  }
  const sig = signatureOf(err);
  if (lastSentBySignature.has(sig) || sentTimes.length >= MAX_ALERTS_PER_WINDOW) {
    suppressedCount++;
    return Promise.resolve();
  }
  const suppressedNote = suppressedCount > 0
    ? `\n\n(${suppressedCount} further error(s) suppressed in the last ${Math.round(THROTTLE_MS / 60000)} minutes — check the Render logs for the full picture.)`
    : "";
  lastSentBySignature.set(sig, now);
  sentTimes.push(now);
  suppressedCount = 0;

  return sendMail({ to: ALERT_TO, subject, text: `${body(err)}${suppressedNote}` }).catch(fail);
}

module.exports = { alertOnError, MAX_ALERTS_PER_WINDOW, ALERT_TO };
