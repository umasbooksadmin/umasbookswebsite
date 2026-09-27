-- The original announcements table (001_init.sql) only ever had
-- published_at, no created_at — missed when 024_announcements_redesign.sql
-- added the date-range filter and sort-fallback in /admin/announcements,
-- both of which reference created_at. Added nullable first and backfilled
-- from published_at so existing rows get their real date rather than
-- "now" — only then is NOT NULL enforced, same order the other redesign
-- migrations use for a new NOT NULL column on an existing table.
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
UPDATE announcements SET created_at = COALESCE(published_at, now()) WHERE created_at IS NULL;
ALTER TABLE announcements ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE announcements ALTER COLUMN created_at SET DEFAULT now();
