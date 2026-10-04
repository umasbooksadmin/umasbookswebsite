-- Forum moderation: an administrator can hide a thread or reply. The text
-- stays in the row (admins can review and restore it); members see a
-- placeholder. hidden_reason holds the reason code, optionally followed by
-- ": " and the moderator's note (see src/lib/forumModeration.js).
ALTER TABLE forum_threads ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ;
ALTER TABLE forum_threads ADD COLUMN IF NOT EXISTS hidden_reason TEXT;
ALTER TABLE forum_threads ADD COLUMN IF NOT EXISTS hidden_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE forum_replies ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ;
ALTER TABLE forum_replies ADD COLUMN IF NOT EXISTS hidden_reason TEXT;
ALTER TABLE forum_replies ADD COLUMN IF NOT EXISTS hidden_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
