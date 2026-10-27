"use strict";

// Database size monitoring (lib/dbSize.js): the Diagnostics card, the thresholds (69/70/90/100%),
// the unknown limit, the weekly snapshot (trimmed to 120), the job registration and the alert
// throttle (one email a week per level). Alert mail goes to a stub.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");

const h = adminHarness("dbsize", ["dashboard", "diagnostics"], { isolated: true });
const dbSize = require("../../src/lib/dbSize");
const { jobSpecs } = require("../../src/jobs");

before(() => h.start());
after(() => h.stop());
beforeEach(async () => {
  delete process.env.DB_PLAN_STORAGE_MB;
  await h.q("DELETE FROM db_size_snapshots");
  await h.q("DELETE FROM alert_flags WHERE key LIKE 'db-size-%'");
});

const MB = 1024 * 1024;

test("assess: unknown limit, then 69 / 70 / 89.9 / 90 / 100 / 120 percent", () => {
  assert.equal(dbSize.assess(500 * MB, 0).level, "unknown");
  assert.equal(dbSize.assess(500 * MB, 0).percent, null);
  const at = (pct) => dbSize.assess(pct * 10 * MB, 1000); // limit 1000 MB
  assert.equal(at(69).level, "ok");
  assert.equal(dbSize.assess(700 * MB - 1, 1000).level, "ok", "69.99% is not a warning");
  assert.equal(at(70).level, "warning");
  assert.equal(at(70).percent, 70);
  assert.equal(at(89).level, "warning");
  assert.equal(dbSize.assess(900 * MB - 1, 1000).level, "warning");
  assert.equal(at(90).level, "critical");
  assert.equal(at(100).level, "critical");
  assert.equal(at(120).level, "critical");
  assert.equal(at(120).percent, 120);
});

test("the Database size page: sizes with an unknown limit show the hint and no warning", async () => {
  const { res, text } = await h.get("/admin/diagnostics/database");
  assert.equal(res.status, 200);
  assert.match(text, /Database size/);
  assert.match(text, /id="db-total"/);
  assert.match(text, /Images table \(covers and photos\)/);
  assert.match(text, /set <code>DB_PLAN_STORAGE_MB<\/code> in Render to get a warning/);
  assert.match(text, /No snapshot yet/);
  assert.match(text, /The 5 biggest tables/);
  assert.equal((text.match(/<tr><th scope="row"><code>/g) || []).length, 5, "top 5 tables");
  assert.doesNotMatch(text, /Over (70|90)% full/);
  assert.equal((await h.get("/admin/diagnostics/database", null)).res.status !== 200, true, "anonymous refused");
  assert.equal((await h.get("/admin/diagnostics/database", h.member)).res.status !== 200, true, "member refused");
});

test("the page and the dashboard with a limit: ok below 70%, warning from 70%, critical from 90%", async () => {
  const { rows } = await h.pool.query("SELECT pg_database_size(current_database())::bigint AS b");
  const bytes = Number(rows[0].b);
  const mbFor = (pct) => Math.ceil((bytes * 100) / (pct * MB)); // a limit that makes the database about `pct` percent
  process.env.DB_PLAN_STORAGE_MB = String(mbFor(40) + 1);
  let page = (await h.get("/admin/diagnostics/database")).text;
  assert.match(page, /Below the 70% warning level/);
  assert.doesNotMatch((await h.get("/admin")).text, /database is \d/i);
  process.env.DB_PLAN_STORAGE_MB = String(mbFor(80));
  page = (await h.get("/admin/diagnostics/database")).text;
  assert.match(page, /Over 70% full/);
  assert.match((await h.get("/admin")).text, /The database is [\d.]+% full/);
  process.env.DB_PLAN_STORAGE_MB = String(Math.max(1, Math.floor((bytes * 100) / (95 * MB))));
  page = (await h.get("/admin/diagnostics/database")).text;
  assert.match(page, /Over 90% full/);
  assert.match((await h.get("/admin")).text, /Upgrade the database plan in Render now/);
});

test("the images table size and count are shown", async () => {
  await h.q("INSERT INTO images (id, data, content_type, byte_size) VALUES (md5(random()::text) || md5(random()::text), $1, 'image/png', 2000)", [Buffer.alloc(2000, 1)]);
  const sizes = await dbSize.readSizes(h.pool);
  assert.ok(sizes.imageCount >= 1);
  assert.ok(sizes.imagesBytes > 0);
  const { text } = await h.get("/admin/diagnostics/database");
  assert.match(text, new RegExp(`${sizes.imageCount} image\\(s\\)`));
});

test("snapshots: growth is shown against the last one; only the newest 120 are kept", async () => {
  await h.q("INSERT INTO db_size_snapshots (taken_at, db_bytes, images_bytes) VALUES (now() - interval '7 days', 1000, 500)");
  const { text } = await h.get("/admin/diagnostics/database");
  assert.match(text, /id="db-growth"[\s\S]*?\+[\d.]+ (MB|KB|GB) since/);
  await h.q("DELETE FROM db_size_snapshots");
  for (let i = 0; i < 125; i++) {
    await h.q("INSERT INTO db_size_snapshots (taken_at, db_bytes, images_bytes) VALUES (now() - ($1 * interval '1 day'), $1, 1)", [i + 1]);
  }
  await dbSize.takeSnapshot(h.pool);
  const rows = await h.q("SELECT db_bytes::int AS b, taken_at FROM db_size_snapshots ORDER BY taken_at DESC");
  assert.equal(rows.length, 120);
  assert.ok(!rows.some((r) => r.b >= 120 && r.b < 1000), "the oldest rows (the test ones numbered 120-125) were dropped");
  assert.ok(rows.some((r) => r.b === 119), "the 120th newest is still there");
  assert.ok(Number(rows[0].b) > 1000, "the newest (real) snapshot is kept");
});

test("the weekly job is registered once, every 7 days, and takes at most one snapshot a week", async () => {
  const spec = jobSpecs(h.pool).find((s) => s.name === "Database size check");
  assert.ok(spec);
  assert.equal(spec.everyMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(jobSpecs(h.pool).filter((s) => /Database size/.test(s.name)).length, 1);
  const sent = [];
  const send = async (m) => { sent.push(m); return true; };
  const r1 = await dbSize.runDbSizeCheck(h.pool, { send });
  assert.equal(r1.snapshot, true);
  const r2 = await dbSize.runDbSizeCheck(h.pool, { send });
  assert.equal(r2.snapshot, false, "a snapshot under 6 days old exists: a restart does not add another");
  assert.equal((await h.q("SELECT count(*)::int AS n FROM db_size_snapshots"))[0].n, 1);
  assert.equal(sent.length, 0, "limit unknown: no alert");
});

test("alerts: nothing below 70%; one email a week at 70%; a separate one at 90%; released when the mail fails", async () => {
  const { rows } = await h.pool.query("SELECT pg_database_size(current_database())::bigint AS b");
  const bytes = Number(rows[0].b);
  const sent = [];
  const send = async (m) => { sent.push(m); return true; };
  const run = (limitMb) => dbSize.runDbSizeCheck(h.pool, { send, limitMb });

  await run(Math.ceil(bytes / MB / 0.69) + 1);
  assert.equal(sent.length, 0, "below 70%");

  const warnLimit = Math.floor(bytes / MB / 0.75); // about 75%
  const w = await run(warnLimit);
  assert.equal(w.level, "warning");
  assert.equal(w.alerted, "warning");
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Database has reached \d+(\.\d)?% of its plan/);
  assert.match(sent[0].text, /upgrade the plan/);
  assert.match(sent[0].text, /DB_PLAN_STORAGE_MB/);
  await run(warnLimit);
  await run(warnLimit);
  assert.equal(sent.length, 1, "throttled: once a week");

  const critLimit = Math.max(1, Math.floor(bytes / MB / 0.95));
  const c = await run(critLimit);
  assert.equal(c.level, "critical");
  assert.equal(c.alerted, "critical");
  assert.equal(sent.length, 2, "the 90% alert is its own, not swallowed by the 70% one");
  assert.match(sent[1].subject, /full: upgrade the plan now/);
  await run(critLimit);
  assert.equal(sent.length, 2);

  // a week later it speaks again
  await h.q("UPDATE alert_flags SET last_sent_at = now() - interval '8 days' WHERE key LIKE 'db-size-%'");
  await run(critLimit);
  assert.equal(sent.length, 3);

  // a failed send frees the slot so the next run tries again
  await h.q("DELETE FROM alert_flags WHERE key LIKE 'db-size-%'");
  const failing = await dbSize.runDbSizeCheck(h.pool, { send: async () => false, limitMb: warnLimit });
  assert.equal(failing.alerted, null);
  assert.equal((await h.q("SELECT 1 FROM alert_flags WHERE key = 'db-size-warning'")).length, 0);
});
