// The background-job registry: every periodic job of the app is declared ONCE, in
// jobSpecs() below, and wired by schedule(). To add a job, add one entry there.
//
// schedule({ name, label, everyMs, firstRunAfterMs, run, enabled }) does, for you:
//   - wraps `run` in guardJob (lib/jobGuard.js): no overlapping runs, a failure never
//     throws out of a timer, every run is written to job_runs (lib/jobRuns.js), so the
//     admin page /admin/diagnostics/jobs, the dashboard's "Needs attention" box and the
//     3-failures alert all know the job by `name`;
//   - hands that bookkeeping the SAME `everyMs` it sets the timer with, so the
//     "no success for 3x the interval" staleness check can never drift from the real
//     schedule (it used to be typed twice per job);
//   - starts the first run per `firstRunAfterMs`: 0 = right now (at boot), a number =
//     that long after boot (unref'd timer: it never keeps the process alive; a
//     restart-heavy host does not repeat the work on every restart), omitted = none,
//     the first run is the first interval tick;
//   - remembers the timers so stopAll() (graceful shutdown) clears every one of them.
//
// Nothing here runs at require time: startJobs(pool) is called by src/index.js after
// the server is listening, and tests build their own registry (createJobRegistry).
const config = require("./lib/config");
const { guardJob } = require("./lib/jobGuard");
const { recordJobRun } = require("./lib/jobRuns");

const MINUTE = 60 * 1000;
const SIX_HOURS = 6 * 60 * MINUTE;
const DAY = 24 * 60 * MINUTE;

// A registry owns the timers of the jobs scheduled through it. `pool` is what the
// guard records runs into and what `run(pool)` receives.
function createJobRegistry({ pool = null } = {}) {
  const handles = [];

  // spec:
  //   name             unique; the job_runs name shown on /admin/diagnostics/jobs and in alerts
  //   label            one plain sentence: what it does (documentation, shown nowhere else)
  //   everyMs          interval, > 0
  //   firstRunAfterMs  0 = at boot, > 0 = that long after boot, undefined = no separate first run
  //   run(pool)        the work; throws/rejects on failure
  //   enabled          false = not scheduled at all (an env toggle such as COVER_BACKFILL=off);
  //                    default true
  //   steps            alternative to `run`: [{ name, run }], several tracked jobs sharing ONE
  //                    timer and run together (each is its own job_runs row)
  //   track            false = this run itself writes no job_runs row (default true). Only for a
  //                    job that records its own sub-steps (Retention purge), via ctx.record
  //   setup(pool)      optional, runs once just before the first run is arranged
  // Returns the handle ({ name, names, everyMs, ..., stop }), or null when disabled.
  function schedule(spec) {
    const { name, label = "", everyMs, firstRunAfterMs, enabled = true, steps, track = true, setup } = spec;
    if (typeof name !== "string" || !name) throw new Error("schedule: name is required");
    if (!Number.isFinite(everyMs) || everyMs <= 0) throw new Error(`schedule "${name}": everyMs must be a positive number`);
    if (firstRunAfterMs !== undefined && (!Number.isFinite(firstRunAfterMs) || firstRunAfterMs < 0)) {
      throw new Error(`schedule "${name}": firstRunAfterMs must be >= 0`);
    }
    if (!steps && typeof spec.run !== "function") throw new Error(`schedule "${name}": run is required`);
    const stepList = steps || [{ name, run: spec.run }];
    const names = stepList.map((s) => s.name);
    for (const n of names.concat(name)) {
      if (handles.some((h) => h.names.includes(n) || h.name === n)) throw new Error(`schedule: duplicate job name "${n}"`);
    }
    if (new Set(names).size !== names.length) throw new Error(`schedule "${name}": duplicate step names`);

    const record = (stepName, { error } = {}) => recordJobRun(pool, stepName, { intervalMs: everyMs, error });
    const guarded = stepList.map((s) =>
      guardJob(s.name, () => s.run(pool, { record }), track ? { pool, intervalMs: everyMs } : undefined)
    );
    const tick = steps ? () => Promise.all(guarded.map((g) => g())) : guarded[0];

    const handle = { name, label, names, everyMs, firstRunAfterMs, tracked: track, enabled, interval: null, firstTimer: null, tick };
    handle.stop = () => {
      clearInterval(handle.interval);
      clearTimeout(handle.firstTimer);
    };
    handles.push(handle);
    if (!enabled) return handle; // listed (documentation, tests) but never started

    if (setup) setup(pool);
    if (firstRunAfterMs === 0) {
      tick();
    } else if (firstRunAfterMs > 0) {
      handle.firstTimer = setTimeout(tick, firstRunAfterMs);
      handle.firstTimer.unref();
    }
    handle.interval = setInterval(tick, everyMs);
    return handle;
  }

  function stopAll() {
    for (const h of handles) h.stop();
  }

  // What is registered, for the tests and the docs (a disabled job is listed with enabled: false).
  const list = () => handles.map(({ name, label, names, everyMs, firstRunAfterMs, tracked, enabled }) => ({ name, label, names, everyMs, firstRunAfterMs, tracked, enabled }));
  // Every job_runs name these jobs write (what /admin/diagnostics/jobs can show).
  const trackedNames = () => handles.filter((h) => h.tracked).flatMap((h) => h.names);

  return { schedule, stopAll, list, trackedNames, handles };
}

// THE list of the app's background jobs. Order = the order they are started in.
// Requires inside run() functions keep modules out of the require graph until needed.
function jobSpecs(pool) {
  const { expireStaleReservations, sendPickupReminders } = require("./lib/reservations");
  const { runCartMaintenance: sweepCart } = require("./lib/cart");
  const { runOrderFollowUps } = require("./lib/orderSweeps");
  const { processOutbox } = require("./lib/outbox");
  const { alertUnmatchedPayments, expireStaleMemberships, reconcileRecentMemberships } = require("./lib/membership");
  const { drainAwards } = require("./lib/awards");
  const { purgeUnusedImages } = require("./lib/imageCleanup");
  const { backfillCovers } = require("./lib/coverStore");
  const { purgeExpiredPersonalData } = require("./lib/privacy");
  const { cleanOrderPhones, sendMailboxCleanupReminder } = require("./lib/privacyMaintenance");
  const lookupStats = require("./lib/lookupStats");
  const aiUsageStats = require("./lib/aiUsageStats");
  const { pruneStaleGuestSessions } = require("./lib/sessionPrune");
  const { runDbSizeCheck } = require("./lib/dbSize");

  return [
    // Belt-and-suspenders backstop for the 2-week reservation expiry (page reads already
    // expire stale reservations; this catches it when there is no traffic). Pickup-reminder
    // emails only ever run from here: sending mail does not belong in a GET. Four tracked
    // jobs, one shared timer, run at boot and every 6 h.
    {
      name: "Reservation maintenance",
      label: "Expire stale reservations, pickup reminders, membership expiry and reconciliation (four tracked jobs, one timer).",
      everyMs: SIX_HOURS,
      firstRunAfterMs: 0,
      steps: [
        { name: "Reservation expiry", run: () => expireStaleReservations(pool) },
        { name: "Pickup reminders", run: () => sendPickupReminders(pool) },
        { name: "Membership expiry", run: () => expireStaleMemberships(pool) },
        { name: "Membership reconciliation", run: () => reconcileRecentMemberships(pool) },
      ],
    },
    // Follow-up for reservations (lib/orderSweeps.js). Not run at boot (a restart-heavy host would
    // repeat it): first run 5 minutes after boot, then every 6 h.
    {
      name: "Order follow-up",
      label: "Release lapsed reservations and ended sessions; day-10 and 24-hour reminders; the admin digest.",
      everyMs: SIX_HOURS,
      firstRunAfterMs: 5 * MINUTE,
      run: async () => {
        const results = await runOrderFollowUps(pool);
        console.log("Order follow-up:", JSON.stringify(results));
      },
    },
    // Leftovers of the old online checkout (an unpaid order holding books 'in_cart'): released after an hour.
    {
      name: "Cart maintenance",
      label: "Release books held by an old unpaid checkout.",
      everyMs: 10 * MINUTE,
      firstRunAfterMs: 0,
      run: () => sweepCart(pool),
    },
    // Email outbox worker (lib/outbox.js): retries unsent mail with backoff, alerts when it gives up; also
    // sends the throttled "membership payment matches no account" alert.
    {
      name: "Email outbox",
      label: "Retry unsent email; alert on unmatched membership payments.",
      everyMs: MINUTE,
      firstRunAfterMs: 15 * 1000,
      run: async () => {
        const r = await processOutbox(pool);
        if (r.sent || r.failed) console.log(`Email outbox: ${r.sent} sent, ${r.failed} failed.`);
        await alertUnmatchedPayments(pool);
      },
    },
    // Retention purge (lib/privacy.js): personal data past the periods in the privacy policy. Daily, and
    // once at boot. Each STEP is tracked on its own ("Retention purge: tokens", ...) through ctx.record, so
    // the run itself writes no job_runs row (track: false).
    {
      name: "Retention purge",
      label: "Remove personal data past the retention periods; each step is its own tracked job ('Retention purge: <step>').",
      everyMs: DAY,
      firstRunAfterMs: 0,
      track: false,
      run: async (_pool, { record }) => {
        const counts = await purgeExpiredPersonalData(pool, {
          onStep: (step, err) => record(`Retention purge: ${step}`, { error: err }),
        });
        console.log("Retention purge:", JSON.stringify(counts));
      },
    },
    // Buyer phone numbers (lib/privacyMaintenance.js): removed once an order is closed or collected and paid.
    {
      name: "Order phone cleanup",
      label: "Remove buyer phone numbers from finished orders, one batch per run.",
      everyMs: SIX_HOURS,
      firstRunAfterMs: 60 * 1000,
      run: async () => {
        const r = await cleanOrderPhones(pool);
        if (r.orders || r.copies) console.log("Order phone cleanup:", JSON.stringify(r));
      },
    },
    // Monthly reminder to empty the shop mailbox of old contact-form emails; checked daily, alert_flags
    // makes it one email per 30 days.
    {
      name: "Contact mailbox reminder",
      label: "Remind the admin to empty the shop mailbox of contact-form emails older than 12 months.",
      everyMs: DAY,
      firstRunAfterMs: 90 * 1000,
      run: () => sendMailboxCleanupReminder(pool),
    },
    // Unused-image cleanup (lib/imageCleanup.js): at most one batch of images older than 7 days that no row references.
    {
      name: "Image cleanup",
      label: "Delete one batch of unreferenced images older than 7 days.",
      everyMs: DAY,
      firstRunAfterMs: 0,
      run: async () => {
        const { deleted, bytes } = await purgeUnusedImages(pool);
        console.log("Image cleanup:", JSON.stringify({ deleted, bytes }));
      },
    },
    // Book lookup statistics (lib/lookupStats.js): counts are kept in memory and flushed about every 30 s (and at
    // shutdown, from src/index.js); this prunes daily rows older than 36 months.
    {
      name: "Lookup statistics retention",
      label: "Prune lookup-source statistics older than 36 months (also starts the 30-second flush).",
      everyMs: DAY,
      firstRunAfterMs: 0,
      setup: () => lookupStats.getStats().start(),
      run: async () => {
        const removed = await lookupStats.pruneLookupStats(pool);
        if (removed) console.log("Lookup statistics retention:", JSON.stringify({ removed }));
      },
    },
    // AI usage statistics (lib/aiUsageStats.js): same batching and retention, plus the daily cap counters.
    {
      name: "AI usage statistics retention",
      label: "Prune AI usage statistics and the daily cap counters (also starts the 30-second flush).",
      everyMs: DAY,
      firstRunAfterMs: 0,
      setup: () => aiUsageStats.getStats().start(),
      run: async () => {
        const removed = await aiUsageStats.pruneAiUsageStats(pool);
        if (removed) console.log("AI usage statistics retention:", JSON.stringify({ removed }));
        await require("./lib/aiLimits").pruneAiDailyCap(pool);
      },
    },
    // Guest session rows older than 24 h (connect-pg-simple prunes only EXPIRED rows). Logged-in sessions are never touched.
    {
      name: "Guest session prune",
      label: "Delete guest session rows that would live longer than 24 h.",
      everyMs: 15 * MINUTE,
      firstRunAfterMs: 20 * 1000,
      run: async () => {
        const removed = await pruneStaleGuestSessions(pool);
        if (removed) console.log("Guest session prune:", JSON.stringify({ removed }));
      },
    },
    // Database size (lib/dbSize.js): covers and photos live in the database, so its size is watched. Weekly: stores a
    // snapshot (last 120 kept) and warns (dashboard line + one email a week) from 70% of DB_PLAN_STORAGE_MB, again from 90%.
    // Not at boot (a restart-heavy host would repeat it): first run 10 minutes after boot; the snapshot itself is skipped
    // when one is under 6 days old.
    {
      name: "Database size check",
      label: "Weekly snapshot of the database size and a warning when it nears the plan's storage limit.",
      everyMs: 7 * DAY,
      firstRunAfterMs: 10 * MINUTE,
      run: async () => {
        const r = await runDbSizeCheck(pool);
        console.log("Database size check:", JSON.stringify(r));
      },
    },
    // Awards & best-seller lists (lib/awards): every 2 minutes a few never-checked books, retries, a yearly
    // refresh. No run at boot: the first tick comes after 2 minutes. (AWARDS_LOOKUPS=off is honoured inside lib/awards.)
    {
      name: "Awards check",
      label: "Look up awards and best-seller lists for a few unchecked books.",
      everyMs: 2 * MINUTE,
      run: async () => {
        const { processed } = await drainAwards(pool);
        if (processed) console.log(`Awards check: ${processed} book(s) checked.`);
      },
    },
    // Book covers on our own server (lib/coverStore.js): every 5 minutes copy up to 20 covers into the image
    // store. First tick after one minute (not at boot). Off in tests (COVER_BACKFILL=off) so they never reach the network.
    {
      name: "Cover backfill",
      label: "Copy up to 20 book covers from Open Library / Internet Archive into our image store.",
      everyMs: 5 * MINUTE,
      firstRunAfterMs: 60 * 1000,
      enabled: config.get("COVER_BACKFILL"),
      run: async () => {
        const { processed, stored, failed, transient } = await backfillCovers(pool);
        if (processed) console.log(`Cover backfill: ${stored} stored, ${failed} failed, ${transient} not reachable (will retry), ${processed} tried.`);
      },
    },
  ];
}

// Schedules every job of jobSpecs(pool) on `registry`; returns the registry.
function startJobs(pool, registry = createJobRegistry({ pool })) {
  for (const spec of jobSpecs(pool)) registry.schedule(spec);
  return registry;
}

module.exports = { createJobRegistry, jobSpecs, startJobs, SIX_HOURS, DAY };
