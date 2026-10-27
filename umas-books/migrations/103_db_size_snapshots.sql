-- Weekly snapshots of the database size (job "Database size check", src/jobs.js), for the
-- "growth since the last snapshot" line of Admin > Diagnostics > Database size. Monitoring
-- data only (no personal data); the job keeps the last 120 rows (about 2 years).
CREATE TABLE IF NOT EXISTS db_size_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  taken_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  db_bytes      BIGINT NOT NULL,
  images_bytes  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS db_size_snapshots_taken_at_idx ON db_size_snapshots (taken_at DESC);
