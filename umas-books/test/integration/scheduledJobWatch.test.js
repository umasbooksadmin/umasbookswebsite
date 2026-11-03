// The app's own watch for "GitHub Actions stopped running our scheduled jobs" (lib/scheduledJobWatch.js):
// the workflows report in through an X-Umas-Probe header on /healthz; the app's hourly job emails when a report is
// overdue, at most once per 24 h per problem, with no new credentials.
//
// Port 3705 is reserved for this file.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { startTestApp } = require("../helpers/testApp");

const PORT = 3705;
let app;
let pool;
let check;
let WATCHED;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  pool = new Pool({ connectionString: app.databaseUrl });
  ({ checkScheduledJobs: check, WATCHED } = require("../../src/lib/scheduledJobWatch"));
});
after(async () => {
  await pool.end();
  await app.stop();
});
beforeEach(() => pool.query("DELETE FROM alert_flags WHERE key LIKE 'gha-%'"));

const setSeen = (name, hoursAgo) =>
  pool.query(
    "INSERT INTO alert_flags (key, last_sent_at) VALUES ($1, now() - ($2 * interval '1 hour')) ON CONFLICT (key) DO UPDATE SET last_sent_at = EXCLUDED.last_sent_at",
    [`gha-seen:${name}`, hoursAgo]
  );
const flag = async (key) => (await pool.query("SELECT last_sent_at FROM alert_flags WHERE key = $1", [key])).rows[0];
const mails = () => {
  const sent = [];
  return { sent, send: async (m) => { sent.push(m); return true; } };
};
const waitFor = async (fn) => { for (let i = 0; i < 40; i++) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

test("a probe header on /healthz is stamped; the answer is the same with or without it", async () => {
  const plain = await fetch(`${app.base}/healthz`);
  assert.equal(plain.status, 200);
  const plainBody = await plain.text();
  const probed = await fetch(`${app.base}/healthz`, { headers: { "x-umas-probe": "backup" } });
  assert.equal(probed.status, 200);
  assert.equal(await probed.text(), plainBody);
  assert.ok(await waitFor(() => flag("gha-seen:backup")), "the backup report was stamped");
  assert.equal(await flag("gha-seen:uptime"), undefined, "nothing else was stamped");
});

test("unknown or odd probe names are ignored; the three real names are stamped", async () => {
  for (const v of ["nonsense", "", "gha-seen:backup", "BACKUP ", "x".repeat(300)]) {
    await fetch(`${app.base}/healthz`, { headers: { "x-umas-probe": v } }).then((r) => r.text());
  }
  await new Promise((r) => setTimeout(r, 200));
  const rows = (await pool.query("SELECT key FROM alert_flags WHERE key LIKE 'gha-%' ORDER BY key")).rows.map((r) => r.key);
  assert.deepEqual(rows, ["gha-seen:backup"], "only the trimmed, lower-cased real name counts");
  for (const n of ["uptime", "inventory"]) await fetch(`${app.base}/healthz`, { headers: { "x-umas-probe": n } }).then((r) => r.text());
  assert.ok(await waitFor(async () => (await pool.query("SELECT 1 FROM alert_flags WHERE key LIKE 'gha-seen:%'")).rowCount === 3));
});

test("nothing has ever reported: no alert (the watch is armed by the first report)", async () => {
  const m = mails();
  const r = await check(pool, { send: m.send });
  assert.deepEqual(r.unarmed.sort(), ["backup", "inventory", "uptime"]);
  assert.equal(m.sent.length, 0);
});

test("fresh reports raise nothing; limits are 20 h for the throttled uptime check, 58 h for the 22:00 backup and 50 h for the inventory export", async () => {
  assert.deepEqual(WATCHED.map((w) => [w.name, w.maxAgeHours]), [["uptime", 20], ["backup", 58], ["inventory", 50]]);
  await setSeen("uptime", 19); await setSeen("backup", 49); await setSeen("inventory", 30);
  const m = mails();
  const r = await check(pool, { send: m.send });
  assert.deepEqual(r.ok.sort(), ["backup", "inventory", "uptime"]);
  assert.equal(m.sent.length, 0);
});

test("uptime: a 9.5 h gap (GitHub throttling) does NOT alert; 21 h does, naming the 20 h limit", async () => {
  await setSeen("backup", 1); await setSeen("inventory", 1);
  const m = mails();
  await setSeen("uptime", 9.5);
  assert.deepEqual((await check(pool, { send: m.send })).ok.includes("uptime"), true);
  assert.equal(m.sent.length, 0, "the biggest observed gap is not an outage");
  await setSeen("uptime", 21);
  assert.deepEqual((await check(pool, { send: m.send })).silent, ["uptime"]);
  assert.equal(m.sent.length, 1);
  assert.match(m.sent[0].subject, /No report from the site uptime check for 21 hours$/);
  assert.match(m.sent[0].text, /at least every 20 hours/);
  assert.doesNotMatch(m.sent[0].text, /hourly/);
});

test("a report that is overdue emails ALERT_TO once, plainly; the next hourly run stays quiet", async () => {
  await setSeen("backup", 60); await setSeen("uptime", 1); await setSeen("inventory", 1);
  const m = mails();
  const r1 = await check(pool, { send: m.send });
  assert.deepEqual(r1.silent, ["backup"]);
  assert.equal(m.sent.length, 1);
  assert.match(m.sent[0].subject, /^\[umas-books\] No report from the nightly database backup for 60 hours$/);
  assert.match(m.sent[0].text, /GitHub Actions has stopped running the scheduled jobs/);
  assert.match(m.sent[0].text, /Nightly database backup/);
  assert.match(m.sent[0].text, /Run workflow/);
  assert.doesNotMatch(m.sent[0].text, /postgres:|password|secret/i);
  const r2 = await check(pool, { send: m.send });
  assert.deepEqual(r2.quiet, ["backup"]);
  assert.equal(m.sent.length, 1, "at most once per day per problem");
});

test("after 24 h of continued silence it reminds once more; two problems send two separate emails", async () => {
  await setSeen("backup", 80); await setSeen("inventory", 80); await setSeen("uptime", 1);
  const m = mails();
  assert.deepEqual((await check(pool, { send: m.send })).silent, ["backup", "inventory"]);
  assert.equal(m.sent.length, 2);
  await pool.query("UPDATE alert_flags SET last_sent_at = now() - interval '25 hours' WHERE key = 'gha-silent:backup'");
  assert.deepEqual((await check(pool, { send: m.send })).silent, ["backup"]);
  assert.equal(m.sent.length, 3);
});

test("when the job reports again the flag is cleared, so the next outage alerts at once", async () => {
  await setSeen("uptime", 21); await setSeen("backup", 1); await setSeen("inventory", 1);
  const m = mails();
  await check(pool, { send: m.send });
  assert.equal(m.sent.length, 1);
  assert.ok(await flag("gha-silent:uptime"));
  await setSeen("uptime", 0);
  await check(pool, { send: m.send });
  assert.equal(await flag("gha-silent:uptime"), undefined);
  await setSeen("uptime", 21);
  await check(pool, { send: m.send });
  assert.equal(m.sent.length, 2, "a new outage alerts straight away");
});

test("if the alert mail cannot be sent, the next hourly run tries again", async () => {
  await setSeen("inventory", 99); await setSeen("backup", 1); await setSeen("uptime", 1);
  const r1 = await check(pool, { send: async () => false });
  assert.deepEqual(r1.silent, []);
  assert.equal(await flag("gha-silent:inventory"), undefined, "the slot was handed back");
  const m = mails();
  assert.deepEqual((await check(pool, { send: m.send })).silent, ["inventory"]);
});

test("the three workflows send the matching header, only after success, and never fail the job", () => {
  const wf = (f) => fs.readFileSync(path.join(__dirname, "..", "..", "..", ".github", "workflows", f), "utf8");
  const stepOf = (src) => src.split(/\n {6}- /).find((s) => /X-Umas-Probe/.test(s));
  const backup = stepOf(wf("nightly-db-backup.yml"));
  assert.match(backup, /X-Umas-Probe: backup/);
  assert.match(backup, /if: success\(\) && steps\.gate\.outputs\.run == 'true' && steps\.gate\.outputs\.manual != 'true'/, "a manual or skipped run is not the nightly backup");
  const inv = stepOf(wf("inventory-export.yml"));
  assert.match(inv, /X-Umas-Probe: inventory/);
  assert.match(inv, /steps\.gate\.outputs\.run == 'true' && steps\.gate\.outputs\.manual != 'true'/, "a manual or skipped run is not the nightly export");
  for (const s of [backup, inv]) {
    assert.match(s, /continue-on-error: true/);
    assert.match(s, /healthz/);
    assert.doesNotMatch(s, /secrets\./, "no secret is involved");
  }
  assert.match(wf("uptime-check.yml"), /-H "X-Umas-Probe: uptime"/);
});
