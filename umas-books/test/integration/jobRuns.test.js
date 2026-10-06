// Background-job tracking: lib/jobGuard.js + lib/jobRuns.js + the job_runs table
// (migration 066), the admin page /admin/diagnostics/jobs and the dashboard's
// "Needs attention" item. Failing job stubs; alert mail goes to a stub.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");

const h = adminHarness("job_runs", ["dashboard", "diagnostics"], { isolated: true });

const mailer = require("../../src/mailer");
const sent = [];
mailer.sendMail = async (opts) => { sent.push(opts); };

const errorAlert = require("../../src/lib/errorAlert");
const { guardJob } = require("../../src/lib/jobGuard");
const { recordJobRun, listJobRuns, jobAttention } = require("../../src/lib/jobRuns");
const { purgeExpiredPersonalData } = require("../../src/lib/privacy");

before(() => h.start());
after(() => h.stop());
beforeEach(async () => {
  sent.length = 0;
  errorAlert.setAlertRetryDelay(0);
  await h.q("DELETE FROM job_runs");
});

const quiet = async (fn) => {
  const e = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = e; }
};
const jobRow = async (name) => (await h.q("SELECT * FROM job_runs WHERE name = $1", [name]))[0];

test("a failing job: recorded each time, ONE alert on the third failure in a row, none after that", async () => {
  const job = guardJob("Failing stub", async () => { throw new Error("boom for jane.doe@example.org 0612345678"); }, { pool: h.pool, intervalMs: 60000 });
  await quiet(() => job());
  await quiet(() => job());
  assert.equal(sent.length, 0, "two failures: no email yet");
  let r = await jobRow("Failing stub");
  assert.equal(r.consecutive_failures, 2);
  assert.equal(r.last_success_at, null);
  assert.ok(r.last_run_at);
  await quiet(() => job());
  assert.equal(sent.length, 1, "third failure: one alert");
  assert.match(sent[0].subject, /Background job failing: Failing stub/);
  assert.match(sent[0].text, /failed 3 times in a row/);
  await quiet(() => job());
  await quiet(() => job());
  assert.equal(sent.length, 1, "no further alerts while it keeps failing");
  r = await jobRow("Failing stub");
  assert.equal(r.consecutive_failures, 5);
  assert.doesNotMatch(r.last_error, /jane\.doe@example\.org|0612345678/, "error text is scrubbed of personal data");
  assert.doesNotMatch(sent[0].text, /jane\.doe@example\.org|0612345678/);
});

test("recovery: one note, counter back to zero, error cleared", async () => {
  let fail = true;
  const job = guardJob("Flaky stub", async () => { if (fail) throw new Error("down"); }, { pool: h.pool, intervalMs: 60000 });
  for (let i = 0; i < 3; i++) await quiet(() => job());
  assert.equal(sent.length, 1);
  fail = false;
  await job();
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /recovered: Flaky stub/);
  const r = await jobRow("Flaky stub");
  assert.deepEqual([r.consecutive_failures, r.last_error, r.alerted_at], [0, null, null]);
  assert.ok(r.last_success_at);
  await job();
  assert.equal(sent.length, 2, "a normal success sends nothing");
  // a fresh outage alerts again
  fail = true;
  for (let i = 0; i < 3; i++) await quiet(() => job());
  assert.equal(sent.length, 3);
});

test("a job that fails twice and then succeeds never alerts", async () => {
  let n = 0;
  const job = guardJob("Blip stub", async () => { if (++n <= 2) throw new Error("blip"); }, { pool: h.pool, intervalMs: 60000 });
  await quiet(() => job());
  await quiet(() => job());
  await job();
  assert.equal(sent.length, 0);
  assert.equal((await jobRow("Blip stub")).consecutive_failures, 0);
});

test("guardJob without a pool still logs and never throws; overlapping runs are skipped", async () => {
  const quietJob = guardJob("No pool", async () => { throw new Error("x"); });
  await quiet(() => quietJob());
  let release;
  const slow = guardJob("Slow", () => new Promise((r) => { release = r; }), { pool: h.pool, intervalMs: 1000 });
  const first = slow();
  const w = console.warn;
  console.warn = () => {};
  try { await slow(); } finally { console.warn = w; }
  release();
  await first;
  assert.equal((await jobRow("Slow")).consecutive_failures, 0);
});

test("when the database is down the in-memory count still raises the alert", async () => {
  const brokenPool = { query: async () => { throw new Error("db down"); } };
  const job = guardJob("Memory stub", async () => { throw new Error("later boom"); }, { pool: brokenPool, intervalMs: 60000 });
  for (let i = 0; i < 4; i++) await quiet(() => job());
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Memory stub/);
});

test("each privacy-purge step is reported; a failing step is recorded and alerts after 3 days of failures", async () => {
  // the 'tokens' step fails because its table is renamed away for the duration
  await h.q("ALTER TABLE password_reset_tokens RENAME TO password_reset_tokens_off");
  try {
    for (let day = 0; day < 3; day++) {
      await quiet(() => purgeExpiredPersonalData(h.pool, {
        onStep: (step, err) => recordJobRun(h.pool, `Retention purge: ${step}`, { intervalMs: 86400000, error: err }),
      }));
    }
  } finally {
    await h.q("ALTER TABLE password_reset_tokens_off RENAME TO password_reset_tokens");
  }
  const tokens = await jobRow("Retention purge: tokens");
  assert.equal(tokens.consecutive_failures, 3);
  assert.match(tokens.last_error, /password_reset_tokens/);
  const signups = await jobRow("Retention purge: signups");
  assert.equal(signups.consecutive_failures, 0);
  assert.ok(signups.last_success_at);
  assert.equal(sent.filter((m) => /Retention purge: tokens/.test(m.subject)).length, 1);
});

test("the admin page lists every job; admin only", async () => {
  await quiet(() => guardJob("Page stub", async () => { throw new Error("visible problem"); }, { pool: h.pool, intervalMs: 3600000 })());
  await guardJob("Healthy page stub", async () => {}, { pool: h.pool, intervalMs: 3600000 })();
  const { res, text } = await h.get("/admin/diagnostics/jobs");
  assert.equal(res.status, 200);
  assert.match(text, /Page stub/);
  assert.match(text, /visible problem/);
  assert.match(text, /Healthy page stub/);
  assert.match(text, /1 hour\(s\)/);
  const anon = await h.get("/admin/diagnostics/jobs", null);
  assert.notEqual(anon.res.status, 200);
  const member = await h.get("/admin/diagnostics/jobs", h.member);
  assert.notEqual(member.res.status, 200);
});

test("'Needs attention': a job with no success for 3x its interval, or 3 failures in a row; healthy jobs show nothing", async () => {
  await guardJob("Fresh job", async () => {}, { pool: h.pool, intervalMs: 3600000 })();
  assert.deepEqual(await jobAttention(h.pool), []);
  let { text } = await h.get("/admin");
  assert.doesNotMatch(text, /background job/i);

  await h.q("UPDATE job_runs SET last_success_at = now() - interval '2 hours' WHERE name = 'Fresh job'");
  assert.deepEqual(await jobAttention(h.pool), [], "2 h < 3 x 1 h");
  await h.q("UPDATE job_runs SET last_success_at = now() - interval '4 hours' WHERE name = 'Fresh job'");
  const items = await jobAttention(h.pool);
  assert.equal(items.length, 1);
  assert.match(items[0].text, /Fresh job/);
  ({ text } = await h.get("/admin"));
  assert.match(text, /id="needs-attention"/);
  assert.match(text, /background job\(s\) are failing/);
  assert.match(text, /\/admin\/diagnostics\/jobs/);

  await h.q("DELETE FROM job_runs");
  await h.q("INSERT INTO job_runs (name, interval_seconds, last_run_at, last_success_at, consecutive_failures, last_error) VALUES ('Failing job', 86400, now(), now(), 3, 'x')");
  assert.equal((await jobAttention(h.pool)).length, 1, "3 failures flag it even if it succeeded recently");
  const rows = await listJobRuns(h.pool);
  assert.equal(rows[0].needs_attention, true);
});

test("a job removed long ago does not nag forever", async () => {
  await h.q("INSERT INTO job_runs (name, interval_seconds, last_run_at, last_success_at, consecutive_failures) VALUES ('Removed job', 300, now() - interval '40 days', now() - interval '40 days', 0)");
  assert.deepEqual(await jobAttention(h.pool), []);
});

test("the launch banner renders on admin pages when the live site is misconfigured", async () => {
  const ejs = require("ejs");
  const path = require("node:path");
  const html = await ejs.renderFile(path.join(__dirname, "../../views/partials/admin_header.ejs"), {
    active: "x", title: "t", launchAlerts: [{ label: "APP_BASE_URL missing", message: "APP_BASE_URL is not set" }],
  });
  assert.match(html, /The live site is not set up correctly/);
  assert.match(html, /APP_BASE_URL is not set/);
  const none = await ejs.renderFile(path.join(__dirname, "../../views/partials/admin_header.ejs"), { active: "x", title: "t", launchAlerts: [] });
  assert.doesNotMatch(none, /not set up correctly/);
});
