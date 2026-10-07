// Operations alerts against a real database:
//  - production with Gmail unset: sendMail throws, so the outbox KEEPS the message
//    (pending, retried) instead of marking it 'sent' and blanking a login link;
//  - an email waiting more than an hour raises ONE alert per 6 hours, no personal data;
//  - the launch-guard alerts are sent at most once per 24 hours (alert_flags), and
//    handed back when the alert mail itself fails.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");

const h = adminHarness("ops_alerts", ["dashboard"], { isolated: true });

const mailer = require("../../src/mailer");
const realSendMail = mailer.sendMail;
const sent = [];
let impl = async (opts) => { sent.push(opts); };
mailer.sendMail = (opts) => impl(opts);

const outbox = require("../../src/lib/outbox");
const errorAlert = require("../../src/lib/errorAlert");
const { sendLaunchAlerts, validateEnv } = require("../../src/lib/env");
const { claimAlertSlot } = require("../../src/lib/alertFlags");

before(() => h.start());
after(() => h.stop());
beforeEach(async () => {
  sent.length = 0;
  impl = async (opts) => { sent.push(opts); };
  errorAlert.setAlertRetryDelay(0);
  await h.q("DELETE FROM email_outbox");
  await h.q("DELETE FROM alert_flags");
});

const msg = (over = {}) => ({ to: `buyer-${h.uniq()}@example.test`, subject: "Secret subject", text: "Click https://umasbooks.org/verify/TOKEN123", kind: "verification", ...over });
const quiet = async (fn) => {
  const e = console.error, w = console.warn;
  console.error = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.error = e; console.warn = w; }
};

test("production without Gmail credentials: the outbox keeps the message pending instead of marking it sent", async () => {
  const saved = { env: process.env.NODE_ENV, u: process.env.GMAIL_USER, p: process.env.GMAIL_APP_PASSWORD };
  const MAILER = require.resolve("../../src/mailer");
  process.env.NODE_ENV = "production";
  delete process.env.GMAIL_USER;
  delete process.env.GMAIL_APP_PASSWORD;
  impl = (opts) => { // the real mailer, freshly loaded so its transporter cache is unset
    delete require.cache[MAILER];
    return require(MAILER).sendMail(opts);
  };
  try {
    const r = await quiet(() => outbox.sendEmail(msg()));
    assert.equal(r.sent, false);
    const [row] = await h.q("SELECT status, attempts, last_error, body_text FROM email_outbox WHERE id = $1", [r.id]);
    assert.equal(row.status, "pending", "not 'sent'");
    assert.equal(row.attempts, 1);
    assert.match(row.last_error, /not configured/i);
    assert.match(row.body_text, /TOKEN123/, "the login link body is NOT blanked");
  } finally {
    process.env.NODE_ENV = saved.env;
    if (saved.u !== undefined) process.env.GMAIL_USER = saved.u;
    if (saved.p !== undefined) process.env.GMAIL_APP_PASSWORD = saved.p;
    delete require.cache[MAILER];
    mailer.sendMail = (opts) => impl(opts);
    assert.ok(realSendMail);
  }
});

test("stuck email alert: nothing under an hour; one alert over an hour, listing counts only, not repeated for 6 hours", async () => {
  const a = await outbox.enqueueEmail(h.pool, msg({ to: "private.person@example.test", subject: "Very private subject" }));
  await outbox.enqueueEmail(h.pool, msg({ kind: "contact" }));
  await h.q("UPDATE email_outbox SET created_at = now() - interval '59 minutes'");
  assert.equal(await outbox.alertStuckEmails(h.pool), false, "under an hour: quiet");
  assert.equal(sent.length, 0);

  await h.q("UPDATE email_outbox SET created_at = now() - interval '61 minutes'");
  await h.q("UPDATE email_outbox SET last_error = 'Invalid login for someone@example.test 0612345678', attempts = 2 WHERE id = $1", [a]);
  assert.equal(await outbox.alertStuckEmails(h.pool), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /2 emails are stuck in the outbox/);
  assert.match(sent[0].text, /verification: 1/);
  assert.match(sent[0].text, /contact: 1/);
  assert.match(sent[0].text, /Invalid login/);
  assert.doesNotMatch(sent[0].text, /private\.person|Very private|someone@example|0612345678/, "no personal data");

  assert.equal(await outbox.alertStuckEmails(h.pool), false, "throttled");
  assert.equal(sent.length, 1);
  await h.q("UPDATE alert_flags SET last_sent_at = now() - interval '361 minutes'");
  assert.equal(await outbox.alertStuckEmails(h.pool), true, "after 6 hours it may repeat");
  assert.equal(sent.length, 2);
});

test("stuck email alert: sent rows and rows already failed are not 'stuck'; a failed alert mail is retried next tick", async () => {
  const id = await outbox.enqueueEmail(h.pool, msg());
  await h.q("UPDATE email_outbox SET status = 'sent', sent_at = now(), created_at = now() - interval '3 hours' WHERE id = $1", [id]);
  assert.equal(await outbox.alertStuckEmails(h.pool), false);
  await h.q("UPDATE email_outbox SET status = 'pending', sent_at = NULL WHERE id = $1", [id]);
  impl = async () => { throw new Error("smtp down"); };
  assert.equal(await quiet(() => outbox.alertStuckEmails(h.pool)), false);
  impl = async (opts) => { sent.push(opts); };
  assert.equal(await outbox.alertStuckEmails(h.pool), true, "the slot was handed back, so the next tick alerts");
});

test("the worker tick runs the stuck-email check", async () => {
  const id = await outbox.enqueueEmail(h.pool, msg());
  await h.q("UPDATE email_outbox SET created_at = now() - interval '2 hours', next_try_at = now() + interval '3 hours' WHERE id = $1", [id]);
  await outbox.processOutbox(h.pool);
  assert.equal(sent.filter((m) => /stuck in the outbox/.test(m.subject)).length, 1);
});

test("launch alerts: each is emailed at most once per 24 h (not once per deploy); handed back if the mail fails", async () => {
  const alerts = validateEnv({
    NODE_ENV: "production", SESSION_SECRET: "s", DATABASE_URL: "d", TOTP_ENCRYPTION_KEY: "t",
    GMAIL_USER: "g", GMAIL_APP_PASSWORD: "p", APP_BASE_URL: "https://umasbooks.example",
    HELLOASSO_API_BASE: "https://api.helloasso-sandbox.com/v5",
  }).alerts;
  assert.ok(alerts.length >= 1);
  const calls = [];
  const send = async (label, message, opts) => { calls.push({ label, opts }); return true; };

  await sendLaunchAlerts(alerts, send, h.pool); // first deploy
  assert.equal(calls.length, alerts.length);
  assert.ok(calls.every((c) => c.opts.force === true));
  await sendLaunchAlerts(alerts, send, h.pool); // a restart an hour later
  await sendLaunchAlerts(alerts, send, h.pool); // and another deploy
  assert.equal(calls.length, alerts.length, "no more emails within 24 h");

  await h.q("UPDATE alert_flags SET last_sent_at = now() - interval '25 hours'");
  await sendLaunchAlerts(alerts, send, h.pool);
  assert.equal(calls.length, alerts.length * 2, "after 24 h it is sent again");

  await h.q("DELETE FROM alert_flags");
  const failing = [];
  await sendLaunchAlerts(alerts, async (label) => { failing.push(label); return false; }, h.pool);
  await sendLaunchAlerts(alerts, send, h.pool);
  assert.equal(failing.length, alerts.length);
  assert.equal(calls.length, alerts.length * 3, "a failed send does not use up the day's slot");
});

test("claimAlertSlot is atomic: of two racing callers exactly one wins", async () => {
  const results = await Promise.all([claimAlertSlot(h.pool, "race", 60), claimAlertSlot(h.pool, "race", 60), claimAlertSlot(h.pool, "race", 60)]);
  assert.equal(results.filter(Boolean).length, 1);
});
