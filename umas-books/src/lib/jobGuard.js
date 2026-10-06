// Wraps a periodic job so that
//   - a slow run is never overlapped by the next tick: while one run is in
//     flight, later ticks are skipped (one log line each) instead of stacking
//     more work on a database/API that is already slow;
//   - every run is recorded in the job_runs table (lib/jobRuns.js) when `pool`
//     is given: last run, last success, consecutive failures, scrubbed error.
//     Three failures in a row send ONE alert email; the admin page
//     /admin/diagnostics/jobs and the dashboard show the rest.
// A failing job never throws out of the guard (a timer must not crash the app).
const { recordJobRun } = require("./jobRuns");

function guardJob(name, job, { pool = null, intervalMs = 60 * 1000 } = {}) {
  let running = false;
  return async function guarded() {
    if (running) {
      console.warn(`${name}: previous run still in progress - skipping this tick.`);
      return;
    }
    running = true;
    let error;
    try {
      await job();
    } catch (err) {
      error = err === undefined || err === null ? new Error("failed") : err;
      console.error(`${name} failed:`, err);
    } finally {
      running = false;
    }
    if (pool) await recordJobRun(pool, name, { intervalMs, error });
  };
}

module.exports = { guardJob };
