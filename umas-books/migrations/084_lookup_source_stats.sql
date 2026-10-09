-- Book lookup statistics (report /admin/reports/lookup-sources).
--
-- One row per (day, source): COUNTS only, so the maintainer can see which ISBN
-- catalogs (Open Library, BnF, Google Books, Open Library data API, ISBNdb) are
-- worth keeping. No ISBN, no title, no user identifier is ever stored: it is
-- aggregate technical statistics, not personal data (docs/privacy/record-of-processing.md).
-- source is a catalog name, or one of the pseudo-sources 'lookup' (lookups that
-- went to the catalogs), 'cache' (answered from memory) and 'none' (no book found).
-- day is the Paris calendar day. Rows are added to by upsert increments from
-- lib/lookupStats.js (batched in memory, flushed about every 30 s) and daily rows
-- older than 36 months are pruned by a daily job.
--
-- Additive only (expand): nothing existing is changed.

CREATE TABLE IF NOT EXISTS lookup_source_stats (
  day        DATE    NOT NULL,
  source     TEXT    NOT NULL,
  asked      INTEGER NOT NULL DEFAULT 0,
  won        INTEGER NOT NULL DEFAULT 0,
  filled     INTEGER NOT NULL DEFAULT 0,
  redundant  INTEGER NOT NULL DEFAULT 0,
  empty      INTEGER NOT NULL DEFAULT 0,
  errors     INTEGER NOT NULL DEFAULT 0,
  limited    INTEGER NOT NULL DEFAULT 0,
  cancelled  INTEGER NOT NULL DEFAULT 0,
  paid_calls INTEGER NOT NULL DEFAULT 0,
  ms_sum     BIGINT  NOT NULL DEFAULT 0,
  ms_n       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source)
);
