-- Operations monitoring (second operations review).
--
-- job_runs: one row per background job (the timers in src/index.js). Until now
-- a job that failed every time only wrote a console.error that nobody read.
-- lib/jobRuns.js records each run here; the admin page /admin/diagnostics/jobs
-- shows the table, the dashboard's "Needs attention" box flags a job whose last
-- success is older than 3x its interval, and the admin gets ONE alert email
-- after 3 failures in a row (and one note when it recovers).
-- last_error is scrubbed of email addresses and long digit runs before it is stored.
--
-- alert_flags: "when did we last send alert X". Lets an alert be sent at most
-- once per period across restarts and across app instances: the launch-guard
-- alerts (once per 24 h instead of once per deploy) and the "an email has been
-- stuck for an hour" alert (once per 6 h). Holds no personal data.
--
-- Additive only (expand): nothing existing is changed.

CREATE TABLE IF NOT EXISTS job_runs (
  name                 TEXT PRIMARY KEY,
  interval_seconds     INTEGER NOT NULL CHECK (interval_seconds > 0),
  last_run_at          TIMESTAMPTZ,
  last_success_at      TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  alerted_at           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS alert_flags (
  key          TEXT PRIMARY KEY,
  last_sent_at TIMESTAMPTZ NOT NULL
);
