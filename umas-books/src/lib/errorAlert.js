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
const config = require("./config");
const { scrubPersonalData } = require("./scrub");

// Where alerts go. ALERT_TO may be ONE address or several separated by commas
// ("shop@example.org, someone@other-provider.example"): nodemailer sends one
// message to all of them. A second address on a DIFFERENT provider than the one
// the alert mail is sent from is the point: if the Google account is locked, the
// alert still reaches somebody. The same variable is used by the GitHub
// workflows (repository variable ALERT_TO). CONTACT_TO is the older fallback.
const ALERT_TO = config.get("ALERT_TO") || config.get("CONTACT_TO");
const THROTTLE_MS = 15 * 60 * 1000;
const MAX_ALERTS_PER_WINDOW = 6;

// Alerts go straight through the mailer (not the outbox: the outbox's own
// failure alert uses this, and a queue that alerts through itself would hide
// exactly the outage it reports). One retry after a short pause covers a blip.
let retryDelayMs = 2000;
const setAlertRetryDelay = (ms) => { retryDelayMs = ms; };

// Resolves true when the alert mail went out, false when both tries failed
// (never throws).
async function sendAdminAlert({ subject, text }) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await sendMail({ to: ALERT_TO, subject, text });
      return true;
    } catch (err) {
      console.error(`Admin alert email failed (attempt ${attempt}/2):`, err.message);
      if (attempt === 1 && retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  return false;
}

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
  if (force) {
    // Money alerts are NOT scrubbed: the admin needs the buyer's email and
    // the order/intent ids to refund by hand, and they only go to her own inbox.
    return sendAdminAlert({ subject: `[umas-books] ${label}`, text: describe(err) });
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

  return sendAdminAlert({ subject, text: `${body(err)}${suppressedNote}` });
}

module.exports = { alertOnError, sendAdminAlert, setAlertRetryDelay, MAX_ALERTS_PER_WINDOW, ALERT_TO };
