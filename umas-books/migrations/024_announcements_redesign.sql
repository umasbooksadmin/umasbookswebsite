-- Announcements gain a real editorial workflow (draft/scheduled/
-- published/archived/trash), categories, a featured image, pinning, an
-- optional expiration, and an optional link to an event — see
-- views/admin/announcements.ejs and src/routes/admin.js.

ALTER TABLE announcements ALTER COLUMN published_at DROP NOT NULL;
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS excerpt TEXT;
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published';
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS event_id INTEGER REFERENCES events(id) ON DELETE SET NULL;
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE announcements DROP CONSTRAINT IF EXISTS announcements_status_check;
ALTER TABLE announcements ADD CONSTRAINT announcements_status_check
  CHECK (status IN ('draft', 'scheduled', 'published', 'archived', 'trash'));

CREATE INDEX IF NOT EXISTS idx_announcements_status ON announcements(status);
