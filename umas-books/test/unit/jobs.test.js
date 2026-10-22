// The background-job registry (src/jobs.js): one declaration per job, the stale-job interval derived from the
// same everyMs as the timer, and stopAll() clearing every timer.
const { test, mock, afterEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/never_connected_jobs_test";
const { createJobRegistry, jobSpecs, startJobs } = require("../../src/jobs");

// A pool that records what the job bookkeeping writes to job_runs (what /admin/diagnostics/jobs reads).
function fakePool() {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };
}
const recorded = (pool) => pool.queries.filter((q) => /INSERT INTO job_runs/.test(q.sql)).map((q) => ({ name: q.params[0], seconds: q.params[1] }));
const silence = () => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  return () => Object.assign(console, saved);
};

// The names are user-visible (the diagnostics page, failure alerts, job_runs rows): renaming one orphans its history.
const EXPECTED_NAMES = [
  "Reservation expiry", "Pickup reminders", "Membership expiry", "Membership reconciliation",
  "Order follow-up", "Cart maintenance", "Email outbox",
  "Retention purge", "Order phone cleanup", "Contact mailbox reminder", "Image cleanup",
  "Lookup statistics retention", "AI usage statistics retention", "Guest session prune", "Awards check", "Cover backfill",
];

afterEach(() => { mock.timers.reset(); mock.restoreAll(); });

test("every job is declared once: unique names, positive interval, a run function", () => {
  const specs = jobSpecs(fakePool());
  const names = specs.flatMap((s) => (s.steps ? s.steps.map((x) => x.name) : [s.name]));
  assert.deepEqual(names, EXPECTED_NAMES);
  assert.equal(new Set([...names, ...specs.map((s) => s.name)].slice(0, names.length)).size, names.length, "unique job names");
  for (const s of specs) {
    assert.ok(Number.isFinite(s.everyMs) && s.everyMs > 0, `${s.name}: positive everyMs`);
    assert.ok(s.firstRunAfterMs === undefined || s.firstRunAfterMs >= 0, `${s.name}: firstRunAfterMs`);
    for (const step of s.steps || [s]) assert.equal(typeof step.run, "function", `${step.name}: run`);
    assert.ok(s.label, `${s.name}: has a label`);
  }
});

test("the intervals and first-run delays are the ones the app has always used", () => {
  const MIN = 60000, H = 60 * MIN, D = 24 * H;
  const byName = Object.fromEntries(jobSpecs(fakePool()).map((s) => [s.name, [s.everyMs, s.firstRunAfterMs]]));
  assert.deepEqual(byName, {
    "Reservation maintenance": [6 * H, 0],
    "Order follow-up": [6 * H, 5 * MIN],
    "Cart maintenance": [10 * MIN, 0],
    "Email outbox": [MIN, 15000],
    "Retention purge": [D, 0],
    "Order phone cleanup": [6 * H, MIN],
    "Contact mailbox reminder": [D, 90000],
    "Image cleanup": [D, 0],
    "Lookup statistics retention": [D, 0],
    "AI usage statistics retention": [D, 0],
    "Guest session prune": [15 * MIN, 20000],
    "Awards check": [2 * MIN, undefined],
    "Cover backfill": [5 * MIN, MIN],
  });
});

test("COVER_BACKFILL=off leaves the cover job unscheduled; anything else schedules it", () => {
  const saved = process.env.COVER_BACKFILL;
  try {
    process.env.COVER_BACKFILL = "off";
    assert.equal(jobSpecs(fakePool()).find((s) => s.name === "Cover backfill").enabled, false);
    delete process.env.COVER_BACKFILL;
    assert.equal(jobSpecs(fakePool()).find((s) => s.name === "Cover backfill").enabled, true);
    process.env.COVER_BACKFILL = "on";
    assert.equal(jobSpecs(fakePool()).find((s) => s.name === "Cover backfill").enabled, true);
  } finally {
    if (saved === undefined) delete process.env.COVER_BACKFILL; else process.env.COVER_BACKFILL = saved;
  }
});

test("each tracked job writes a job_runs row under its name, with the interval taken from its everyMs", async () => {
  const restore = silence();
  try {
    const pool = fakePool();
    const registry = createJobRegistry({ pool });
    for (const spec of jobSpecs(pool)) {
      // Same declaration, work stubbed: what is under test is the wiring (name + interval into the bookkeeping).
      const stub = async () => {};
      const { enabled: _enabled, ...rest } = spec;
      registry.schedule({ ...rest, enabled: false, run: stub, steps: spec.steps && spec.steps.map((x) => ({ ...x, run: stub })) });
    }
    for (const h of registry.handles) await h.tick();
    const rows = recorded(pool);
    const expectedTracked = EXPECTED_NAMES.filter((n) => n !== "Retention purge");
    assert.deepEqual(rows.map((r) => r.name).sort(), expectedTracked.sort(), "every tracked job, and nothing for the self-tracking purge");
    assert.deepEqual(registry.trackedNames().sort(), expectedTracked.sort());
    for (const spec of jobSpecs(pool)) {
      for (const step of spec.steps || [spec]) {
        if (step.name === "Retention purge") continue;
        assert.equal(rows.find((r) => r.name === step.name).seconds, Math.round(spec.everyMs / 1000), `${step.name}: stale-job interval = everyMs`);
      }
    }
  } finally { restore(); }
});

test("a job that records its own sub-steps (track: false) uses the same everyMs for them", async () => {
  const pool = fakePool();
  const registry = createJobRegistry({ pool });
  const h = registry.schedule({ name: "Purge", everyMs: 86400000, enabled: false, track: false, run: async (_p, { record }) => { await record("Purge: step", { error: undefined }); } });
  await h.tick();
  assert.deepEqual(recorded(pool), [{ name: "Purge: step", seconds: 86400 }]);
});

test("schedule rejects a duplicate name, a bad interval and a missing run", () => {
  const registry = createJobRegistry({ pool: fakePool() });
  const ok = { name: "A", everyMs: 1000, enabled: false, run: async () => {} };
  registry.schedule(ok);
  assert.throws(() => registry.schedule(ok), /duplicate job name "A"/);
  assert.throws(() => registry.schedule({ ...ok, name: "B", everyMs: 0 }), /everyMs/);
  assert.throws(() => registry.schedule({ ...ok, name: "C", everyMs: NaN }), /everyMs/);
  assert.throws(() => registry.schedule({ name: "D", everyMs: 1000 }), /run is required/);
  assert.throws(() => registry.schedule({ ...ok, name: "E", steps: [{ name: "A", run() {} }] }), /duplicate job name "A"/);
});

test("first-run semantics: 0 = now, N = after N ms, omitted = first interval tick; enabled:false = never", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const registry = createJobRegistry({ pool: null });
  const calls = [];
  const mk = (name, extra) => registry.schedule({ name, everyMs: 1000, run: async () => { calls.push(name); }, ...extra });
  mk("now", { firstRunAfterMs: 0 });
  mk("later", { firstRunAfterMs: 400 });
  mk("none", {});
  mk("off", { firstRunAfterMs: 0, enabled: false });
  assert.deepEqual(calls, ["now"], "only the boot run happened synchronously");
  const flush = () => new Promise((r) => setImmediate(r)); // let the guarded runs finish so the next tick is not skipped as overlapping
  await flush();
  mock.timers.tick(399);
  assert.deepEqual(calls, ["now"]);
  mock.timers.tick(1);
  await flush();
  assert.deepEqual(calls, ["now", "later"]);
  mock.timers.tick(600); // t = 1000: every enabled job's first interval tick
  await flush();
  assert.deepEqual(calls.slice(2).sort(), ["later", "none", "now"]);
  registry.stopAll();
});

test("stopAll() stops every job, including ones whose first run is still pending", () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const registry = createJobRegistry({ pool: null });
  let runs = 0;
  const run = async () => { runs++; };
  registry.schedule({ name: "boot", everyMs: 1000, firstRunAfterMs: 0, run });
  registry.schedule({ name: "delayed", everyMs: 1000, firstRunAfterMs: 5000, run });
  registry.schedule({ name: "plain", everyMs: 1000, run });
  assert.equal(runs, 1);
  registry.stopAll();
  mock.timers.tick(60 * 60 * 1000);
  assert.equal(runs, 1, "no interval tick and no delayed first run after stopAll()");
});

test("startJobs() schedules every real job, and stopAll() leaves no job timer running", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const restore = silence();
  const pool = fakePool();
  let registry;
  try {
    registry = startJobs(pool);
    const started = registry.handles.filter((h) => h.enabled);
    assert.equal(started.length, registry.handles.length - (process.env.COVER_BACKFILL === "off" ? 1 : 0));
    assert.ok(started.every((h) => h.interval), "every enabled job has an interval timer");
    assert.deepEqual(registry.list().map((j) => j.name), jobSpecs(pool).map((s) => s.name));
    await new Promise((r) => setImmediate(r)); // let the boot runs settle
    registry.stopAll();
    const before = pool.queries.length;
    mock.timers.tick(30 * 24 * 60 * 60 * 1000);
    await new Promise((r) => setImmediate(r));
    assert.equal(pool.queries.length, before, "no job ran after stopAll()");
  } finally {
    if (registry) registry.stopAll();
    // startJobs() also starts the two in-memory statistics flushers (stopped separately at shutdown, by src/index.js).
    await require("../../src/lib/lookupStats").getStats().stop().catch(() => {});
    await require("../../src/lib/aiUsageStats").getStats().stop().catch(() => {});
    restore();
  }
});
