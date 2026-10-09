// Email alert when the Anthropic credit runs out (lib/aiCreditAlert.js) against a real database, mailer injected:
// one mail per 24 h while the problem lasts, a successful call re-arms it, 429/500 never alert, the test button, no
// secrets in the text, send failures never throw, and the dashboard / diagnostics lines.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");

const h = adminHarness("ai_credit_alert", ["dashboard", "reports", "diagnostics"], { isolated: true });

const mailer = require("../../src/mailer");
const sent = [];
let impl = async (opts) => { sent.push(opts); };
mailer.sendMail = (opts) => impl(opts);

const errorAlert = require("../../src/lib/errorAlert");
const ai = require("../../src/lib/aiUsageStats");
const { createCreditAlert, sendTestAlert, alertText, FLAG } = require("../../src/lib/aiCreditAlert");

const CREDIT_BODY = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } });
const SECRET_KEY = "sk-ant-api03-SECRETSECRETSECRET";

let stats;
let alert;
before(async () => {
  await h.start();
  errorAlert.setAlertRetryDelay(0);
  process.env.ANTHROPIC_API_KEY = SECRET_KEY;
});
after(async () => { delete process.env.ANTHROPIC_API_KEY; ai.setStats(null); await h.stop(); });
beforeEach(async () => {
  sent.length = 0;
  impl = async (opts) => { sent.push(opts); };
  await h.q("DELETE FROM alert_flags");
  await h.q("DELETE FROM ai_usage_stats");
  alert = createCreditAlert({ getPool: () => h.pool, minGapMs: 0, log: () => {} });
  stats = ai.createAiUsageStats({ getPool: () => h.pool, log: () => {}, alert });
});
// recordCall fires the hook itself (in the background): settle lets that work finish.
const credit = async () => { stats.recordCall("description", { status: 400, bodyText: CREDIT_BODY, ms: 5 }); await settle(); };
const settle = () => new Promise((r) => setTimeout(r, 150));
const flag = async () => (await h.q("SELECT last_sent_at FROM alert_flags WHERE key = $1", [FLAG]))[0];

test("the first credit error sends ONE mail to the alert address; the second within 24 hours does not", async () => {
  stats.recordCall("description", { status: 400, bodyText: CREDIT_BODY, ms: 5 });
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, errorAlert.ALERT_TO);
  assert.equal(sent[0].subject, "[umas-books] Anthropic API credit has run out");
  stats.recordCall("genre", { status: 402, bodyText: CREDIT_BODY, ms: 5 });
  stats.recordCall("cover", { status: 400, bodyText: CREDIT_BODY, ms: 5 });
  await settle();
  assert.equal(sent.length, 1, "still one");
  assert.ok(await flag());
});

test("after 24 hours the next credit error sends again", async () => {
  await credit();
  assert.equal(sent.length, 1);
  await h.q("UPDATE alert_flags SET last_sent_at = now() - interval '23 hours' WHERE key = $1", [FLAG]);
  await credit();
  assert.equal(sent.length, 1, "23 h: no");
  await h.q("UPDATE alert_flags SET last_sent_at = now() - interval '25 hours' WHERE key = $1", [FLAG]);
  await credit();
  assert.equal(sent.length, 2, "25 h: yes");
});

test("a successful call clears the flag, so the next outage alerts again at once", async () => {
  await credit();
  assert.equal(sent.length, 1);
  stats.recordCall("description", { status: 200, data: { usage: { input_tokens: 1, output_tokens: 1 } }, ms: 5 });
  await settle();
  assert.equal(await flag(), undefined, "flag cleared");
  await credit();
  assert.equal(sent.length, 2, "a new outage alerts again");
});

test("non-credit errors (429, 500, 529, a timeout, another 400) never alert", async () => {
  for (const o of [{ status: 429, bodyText: CREDIT_BODY }, { status: 500, bodyText: "oops" }, { status: 529, bodyText: "{}" }, { failed: true }, { status: 400, bodyText: JSON.stringify({ error: { type: "invalid_request_error", message: "max_tokens required" } }) }]) {
    stats.recordCall("description", { ...o, ms: 5 });
  }
  await settle();
  assert.equal(sent.length, 0);
  assert.equal(await flag(), undefined);
});

test("the mail is plain English, has the fix, the report link and the time, and no secret", async () => {
  await credit();
  const { subject, text } = sent[0];
  assert.doesNotMatch(subject, /TEST/);
  for (const re of [/descriptions/, /French translation/, /genre suggestions/, /cover photo/, /price check/i, /scanning by ISBN/, /the till/, /reservations/, /console\.anthropic\.com/, /Settings > Billing/, /auto-reload/, /monthly limit/, /nothing needs to be changed in Render/i, /\/admin\/reports\/lookup-sources/, /Paris time/]) assert.match(text, re);
  assert.doesNotMatch(text + subject, /sk-ant|SECRET|Please go to Plans|credit balance is too low to access|invalid_request_error/);
  assert.doesNotMatch(alertText({ at: Date.now() }), /sk-ant|ANTHROPIC_API_KEY/);
});

test("a mail that cannot be sent never throws, is retried by the next credit error, and keeps the dashboard line", async () => {
  impl = async () => { throw new Error("smtp down"); };
  const err = console.error; console.error = () => {};
  try {
    assert.equal(await alert.creditOutOf(), false);
    assert.ok(await flag(), "flag kept for the dashboard");
    impl = async (opts) => { sent.push(opts); };
    assert.equal(await alert.creditOutOf(), true, "sent on the next error, not after 24 h");
    assert.equal(sent.length, 1);
  } finally { console.error = err; }
  // a broken database is swallowed and logged once
  const logs = [];
  const bad = createCreditAlert({ getPool: () => ({ query: async () => { throw new Error("db gone"); } }), minGapMs: 0, log: (m) => logs.push(m) });
  assert.equal(await bad.creditOutOf(), false);
  assert.equal(await bad.creditOutOf(), false);
  assert.equal(await bad.creditWorking(), false);
  assert.equal(logs.length, 1, "logged once");
  assert.doesNotThrow(() => createCreditAlert({ getPool: () => { throw new Error("no pool"); }, log: () => {} }).creditOutOf());
});

test("recordCall returns at once and does not wait for the mail", async () => {
  impl = () => new Promise(() => {}); // never answers
  const t0 = Date.now();
  stats.recordCall("description", { status: 400, bodyText: CREDIT_BODY, ms: 5 });
  assert.ok(Date.now() - t0 < 50);
  await settle(); // let the background attempt reach the (never answering) mailer before the next test swaps it
});

test("the test button: admin only, sends [TEST] once, refuses a second press within a minute, is audited, leaves the real flag alone", async () => {
  assert.equal((await h.post("/admin/reports/lookup-sources/test-credit-alert", {}, { user: h.member })).res.status, 403);
  assert.notEqual((await h.post("/admin/reports/lookup-sources/test-credit-alert", {}, { user: null })).res.status, 200);
  assert.equal(sent.length, 0);

  const first = await h.post("/admin/reports/lookup-sources/test-credit-alert");
  assert.match(first.text, /Test email sent/);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /^\[TEST\] \[umas-books\] Anthropic API credit has run out$/);
  assert.match(sent[0].text, /THIS IS A TEST/);
  const second = await h.post("/admin/reports/lookup-sources/test-credit-alert");
  assert.match(second.text, /less than a minute ago/);
  assert.equal(sent.length, 1);
  assert.equal(await flag(), undefined, "no outage is recorded by a test");
  const audits = await h.q("SELECT detail FROM admin_audit_log WHERE action = 'ai.credit_alert_test' ORDER BY id");
  assert.equal(audits.length, 2);
  assert.match(audits[0].detail, /sent/);
  await h.q("UPDATE alert_flags SET last_sent_at = now() - interval '2 minutes' WHERE key = 'anthropic-credit-test'");
  assert.equal((await sendTestAlert(h.pool)).sent, true);
  impl = async () => { throw new Error("smtp down"); };
  await h.q("DELETE FROM alert_flags");
  const err = console.error; console.error = () => {};
  try { assert.deepEqual(await sendTestAlert(h.pool), { sent: false, limited: false }); } finally { console.error = err; }
  assert.match((await h.get("/admin/reports/lookup-sources")).text, /Send a test credit alert/);
  assert.equal((await h.get("/admin/reports/lookup-sources", h.member)).res.status === 200 && /Send a test credit alert/.test((await h.get("/admin/reports/lookup-sources", h.member)).text), false);
});

test("dashboard and diagnostics show the outage while the flag exists, and not after a successful call", async () => {
  assert.doesNotMatch((await h.get("/admin")).text, /Anthropic API credit ran out/);
  stats.recordCall("description", { status: 400, bodyText: CREDIT_BODY, ms: 5 });
  await settle();
  await stats.flush();
  const dash = (await h.get("/admin")).text;
  assert.match(dash, /id="needs-attention"[\s\S]*Anthropic API credit ran out at [^<]+\(Paris time\)/);
  const diag = (await h.get("/admin/diagnostics/jobs")).text;
  assert.match(diag, /Anthropic API credit ran out/);
  stats.recordCall("description", { status: 200, data: {}, ms: 5 });
  await settle();
  assert.doesNotMatch((await h.get("/admin")).text, /Anthropic API credit ran out/);
  assert.doesNotMatch((await h.get("/admin/diagnostics/jobs")).text, /Anthropic API credit ran out/);
});
