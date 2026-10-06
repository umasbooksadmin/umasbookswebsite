// Background-job bookkeeping. Every periodic job in src/index.js runs through
// guardJob (lib/jobGuard.js), which calls recordJobRun after each run. One row
// per job in `job_runs` (migration 066):
//
//   last_run_at, last_success_at, consecutive_failures, last_error (scrubbed)
//
// What it drives:
//   - the admin page /admin/diagnostics/jobs (the whole table, English);
//   - the dashboard's "Needs attention" box (jobAttention): a job that has not
//     succeeded for 3x its interval, or has failed 3+ times in a row;
//   - ONE alert email when a job fails 3 times in a row (not one per failure),
//     and one "recovered" note when it succeeds again.
// A job that fails must never take the app down and recording must never throw:
// if the database is unreachable the in-memory counter still raises the alert.
const { scrubPersonalData } = require("./scrub");
const { alertOnError, sendAdminAlert } = require("./errorAlert");

const FAILURES_BEFORE_ALERT = 3;
const STALE_FACTOR = 3;

const memory = new Map(); // name -> { failures, alerted }: fallback when the database is down
const mem = (name) => {
  if (!memory.has(name)) memory.set(name, { failures: 0, alerted: false });
  return memory.get(name);
};

function errorText(err) {
  return scrubPersonalData((err && err.message) || String(err)).slice(0, 500);
}

const humanInterval = (seconds) => {
  if (seconds % 86400 === 0) return `${seconds / 86400} day(s)`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour(s)`;
  if (seconds % 60 === 0) return `${seconds / 60} minute(s)`;
  return `${seconds} second(s)`;
};

// Records one run. `error` is the thrown value, or undefined for a success.
// Resolves; never throws.
async function recordJobRun(pool, name, { intervalMs, error } = {}) {
  const failed = error !== undefined && error !== null;
  const seconds = Math.max(1, Math.round((intervalMs || 60000) / 1000));
  const m = mem(name);
  try {
    if (!failed) {
      const { rows: old } = await pool.query("SELECT alerted_at FROM job_runs WHERE name = $1", [name]);
      await pool.query(
        `INSERT INTO job_runs (name, interval_seconds, last_run_at, last_success_at, consecutive_failures, last_error)
         VALUES ($1, $2, now(), now(), 0, NULL)
         ON CONFLICT (name) DO UPDATE SET interval_seconds = $2, last_run_at = now(), last_success_at = now(),
           consecutive_failures = 0, last_error = NULL, alerted_at = NULL`,
        [name, seconds]
      );
      const wasAlerted = m.alerted || Boolean(old[0] && old[0].alerted_at);
      m.failures = 0;
      m.alerted = false;
      if (wasAlerted) {
        await sendAdminAlert({
          subject: `[umas-books] Background job recovered: ${name}`,
          text: `The background job "${name}" ran successfully again after failing repeatedly. No action needed.`,
        });
      }
      return;
    }
    const text = errorText(error);
    m.failures++;
    const { rows } = await pool.query(
      `INSERT INTO job_runs (name, interval_seconds, last_run_at, consecutive_failures, last_error)
       VALUES ($1, $2, now(), 1, $3)
       ON CONFLICT (name) DO UPDATE SET interval_seconds = $2, last_run_at = now(),
         consecutive_failures = job_runs.consecutive_failures + 1, last_error = $3
       RETURNING consecutive_failures`,
      [name, seconds, text]
    );
    const count = rows[0].consecutive_failures;
    if (count >= FAILURES_BEFORE_ALERT) {
      // The claim is one UPDATE, so two instances cannot both alert.
      const claim = await pool.query("UPDATE job_runs SET alerted_at = now() WHERE name = $1 AND alerted_at IS NULL", [name]);
      if (claim.rowCount === 1) {
        m.alerted = true;
        const ok = await sendFailureAlert(name, count, seconds, text);
        if (!ok) {
          m.alerted = false;
          await pool.query("UPDATE job_runs SET alerted_at = NULL WHERE name = $1", [name]);
        }
      }
    }
  } catch (dbErr) {
    console.error(`Job bookkeeping for "${name}" failed:`, dbErr.message);
    if (!failed) {
      m.failures = 0;
      m.alerted = false;
    } else if (m.failures >= FAILURES_BEFORE_ALERT && !m.alerted) {
      m.alerted = true;
      await sendFailureAlert(name, m.failures, seconds, errorText(error));
    }
  }
}

async function sendFailureAlert(name, count, seconds, text) {
  const body =
    `The background job "${name}" has failed ${count} times in a row (it runs every ${humanInterval(seconds)}).\n\n` +
    `Last error: ${text}\n\n` +
    `Open /admin/diagnostics/jobs on the site to see every job, and the Render logs for the full error. ` +
    `You get one email per outage, and one more when the job recovers. See docs/runbook.md, "When you receive an alert".`;
  // force: this is the one email per outage, it must not be swallowed by the error throttle.
  return alertOnError(`Background job failing: ${name}`, body, { force: true });
}

// For the admin page: every job, with a status.
async function listJobRuns(pool) {
  const { rows } = await pool.query(
    `SELECT name, interval_seconds, last_run_at, last_success_at, consecutive_failures, last_error,
            (consecutive_failures >= ${FAILURES_BEFORE_ALERT}
             OR (last_success_at IS NULL AND consecutive_failures > 0)
             OR last_success_at < now() - (${STALE_FACTOR} * interval_seconds * interval '1 second')) AS needs_attention
       FROM job_runs ORDER BY name`
  );
  return rows;
}

// For the dashboard's "Needs attention" box.
async function jobAttention(pool) {
  const { rows } = await pool.query(
    `SELECT name, consecutive_failures FROM job_runs
      WHERE last_run_at > now() - interval '30 days'
        AND (consecutive_failures >= ${FAILURES_BEFORE_ALERT}
             OR (last_success_at IS NULL AND consecutive_failures > 0)
             OR last_success_at < now() - (${STALE_FACTOR} * interval_seconds * interval '1 second'))
      ORDER BY name`
  );
  if (!rows.length) return [];
  return [{
    href: "/admin/diagnostics/jobs",
    text: `${rows.length} background job(s) are failing or have not succeeded recently: ${rows.map((r) => r.name).join(", ")}.`,
  }];
}

module.exports = { recordJobRun, listJobRuns, jobAttention, FAILURES_BEFORE_ALERT, STALE_FACTOR };
