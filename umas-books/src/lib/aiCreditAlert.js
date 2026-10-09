// Email alert when the Anthropic API credit runs out (the AI features stop with "credit balance is too low").
//
// aiUsageStats.js calls creditOutOf() for every call that Anthropic refused for lack of credit and creditWorking() for
// every successful call. Same "send once per period" machinery as the other alerts (lib/alertFlags.js, table
// alert_flags): the flag below is claimed atomically, so at most ONE mail goes out per 24 hours while the problem
// lasts, across restarts and instances. A successful call deletes the flag, so the next outage alerts again at once.
// The flag's presence also drives the red line on the dashboard and the row on /admin/diagnostics/jobs.
//
// NEVER in the way of a call or a save: both hooks return at once (the work runs in the background) and swallow
// every error (logged once). The mail holds no key, no response body and no data about people.
const { claimAlertSlot } = require("./alertFlags");
const { SITE_TIME_ZONE } = require("./tz");

const FLAG = "anthropic-credit";
const TEST_FLAG = "anthropic-credit-test";
const EVERY_MINUTES = 24 * 60;
const TEST_EVERY_MINUTES = 1;
const SUBJECT = "[umas-books] Anthropic API credit has run out";

const parisTime = (ms) => new Date(ms).toLocaleString("en-GB", { timeZone: SITE_TIME_ZONE, dateStyle: "long", timeStyle: "short" });

function alertText({ at, test = false, base = (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "") }) {
  return (
    (test ? "THIS IS A TEST. Nothing is wrong: you pressed \"Send a test credit alert\" to check that this email reaches you.\n\n" : "") +
    `The Anthropic API credit has run out (${parisTime(at)}, Paris time).\n\n` +
    "The AI helpers of the site have stopped working until credit is added:\n" +
    "  - book descriptions\n  - the French translation of descriptions\n  - genre suggestions\n  - reading a book from a cover photo\n  - the AI price check\n\n" +
    "Everything else keeps working as usual: scanning by ISBN, saving books (a book saved meanwhile simply has no description; press Generate later), the till and reservations.\n\n" +
    "How to fix it:\n" +
    "  1. Go to console.anthropic.com and sign in.\n" +
    "  2. Open Settings > Billing.\n" +
    "  3. Add credit. Also turn on auto-reload and set a monthly limit, so it does not run dry again.\n" +
    "Nothing needs to be changed in Render, and nothing needs restarting: the AI features come back by themselves once there is credit.\n\n" +
    `More detail (what the AI used, per feature and day): ${base}/admin/reports/lookup-sources\n\n` +
    (test ? "" : "You get at most one of these emails every 24 hours while the problem lasts. When a call works again, the next outage will alert you again.\n")
  );
}

function createCreditAlert({
  getPool = () => require("../db").pool,
  send = (m) => require("./errorAlert").sendAdminAlert(m),
  now = Date.now,
  minGapMs = 60 * 1000, // this process looks at the database at most this often while the credit is out
  log = (m) => console.warn(m),
} = {}) {
  let busy = false;
  let lastTryAt = 0;
  let mayHaveFlag = true; // unknown after a start: the first successful call checks once
  let warned = false;
  const warnOnce = (err) => {
    if (warned) return;
    warned = true;
    try { log(`Anthropic credit alert: ${String((err && err.message) || err).slice(0, 120)}. The AI features and saving are not affected.`); } catch { /* ignore */ }
  };

  async function attempt() {
    const pool = getPool();
    mayHaveFlag = true;
    if (!(await claimAlertSlot(pool, FLAG, EVERY_MINUTES))) return false;
    const ok = await send({ subject: SUBJECT, text: alertText({ at: now() }) });
    if (!ok) {
      // Keep the flag (the dashboard still shows the outage) but make the next credit error try to send again.
      await pool.query("UPDATE alert_flags SET last_sent_at = now() - ($2 * interval '1 minute') - interval '1 second' WHERE key = $1", [FLAG, EVERY_MINUTES]);
    }
    return ok;
  }

  // Fire and forget. Returns a promise only so that tests can wait for it; callers ignore it.
  function creditOutOf() {
    try {
      const t = now();
      if (busy || t - lastTryAt < minGapMs) return Promise.resolve(false);
      busy = true;
      lastTryAt = t;
      return Promise.resolve().then(attempt).catch((err) => { warnOnce(err); return false; }).finally(() => { busy = false; });
    } catch (err) { warnOnce(err); return Promise.resolve(false); }
  }

  // A call worked: the credit is back, so the next outage must alert again.
  function creditWorking() {
    try {
      if (!mayHaveFlag) return Promise.resolve(false);
      mayHaveFlag = false;
      return Promise.resolve()
        .then(() => getPool().query("DELETE FROM alert_flags WHERE key = $1", [FLAG]))
        .then(() => true)
        .catch((err) => { mayHaveFlag = true; warnOnce(err); return false; });
    } catch (err) { warnOnce(err); return Promise.resolve(false); }
  }

  return { creditOutOf, creditWorking };
}

// The "Send a test credit alert" button: the same mail with [TEST] in the subject, at most once a minute.
// Resolves { sent: boolean, limited: boolean }; never throws.
async function sendTestAlert(pool, { send = (m) => require("./errorAlert").sendAdminAlert(m), now = Date.now } = {}) {
  try {
    if (!(await claimAlertSlot(pool, TEST_FLAG, TEST_EVERY_MINUTES))) return { sent: false, limited: true };
    const sent = await send({ subject: `[TEST] ${SUBJECT}`, text: alertText({ at: now(), test: true }) });
    return { sent: Boolean(sent), limited: false };
  } catch { return { sent: false, limited: false }; }
}

// For the dashboard and /admin/diagnostics/jobs: { active, at, lastSentAt } (active = a credit error was alerted and no
// call has worked since). `at` is the latest refused call when known, else the alert time.
async function creditAlertState(db) {
  const { rows } = await db.query(
    `SELECT f.last_sent_at, (SELECT max(last_credit_error_at) FROM ai_usage_stats WHERE last_credit_error_at >= f.last_sent_at - interval '25 hours') AS last_refused
       FROM alert_flags f WHERE f.key = $1`,
    [FLAG]
  );
  if (!rows.length) return { active: false, at: null, lastSentAt: null };
  return { active: true, at: rows[0].last_refused || rows[0].last_sent_at, lastSentAt: rows[0].last_sent_at };
}

let current = null;
const getCreditAlert = () => current || (current = createCreditAlert());
const setCreditAlert = (a) => { current = a; };

module.exports = { createCreditAlert, getCreditAlert, setCreditAlert, sendTestAlert, creditAlertState, alertText, parisTime, FLAG, TEST_FLAG, EVERY_MINUTES, SUBJECT };
