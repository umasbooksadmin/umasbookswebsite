-- AI usage statistics (report /admin/reports/lookup-sources, section "AI usage").
--
-- One row per (day, feature): COUNTS only (calls, outcomes, token counts, web searches, response time), so the
-- maintainer can see what uses the Anthropic API credit. No prompt, title, ISBN, text, photo or user identifier
-- is ever stored: aggregate technical statistics, not personal data (docs/privacy/record-of-processing.md, 11b).
-- feature is one of: description, translation, genre, cover, price. day is the Paris calendar day.
-- Rows are added to by upsert increments from lib/aiUsageStats.js (batched in memory, flushed about every 30 s);
-- daily rows older than 36 months are pruned by the daily job.
-- last_credit_error_at is the latest time a "credit balance too low" answer was received that day (for the banner).
--
-- Additive only (expand): nothing existing is changed.

CREATE TABLE IF NOT EXISTS ai_usage_stats (
  day                  DATE    NOT NULL,
  feature              TEXT    NOT NULL,
  calls                INTEGER NOT NULL DEFAULT 0,
  ok                   INTEGER NOT NULL DEFAULT 0,
  errors               INTEGER NOT NULL DEFAULT 0,
  limited              INTEGER NOT NULL DEFAULT 0,
  credit_errors        INTEGER NOT NULL DEFAULT 0,
  input_tokens         BIGINT  NOT NULL DEFAULT 0,
  output_tokens        BIGINT  NOT NULL DEFAULT 0,
  cache_read_tokens    BIGINT  NOT NULL DEFAULT 0,
  cache_write_tokens   BIGINT  NOT NULL DEFAULT 0,
  web_searches         INTEGER NOT NULL DEFAULT 0,
  duration_ms_sum      BIGINT  NOT NULL DEFAULT 0,
  duration_n           INTEGER NOT NULL DEFAULT 0,
  last_credit_error_at TIMESTAMPTZ,
  PRIMARY KEY (day, feature)
);
