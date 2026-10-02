-- When an account was warned that it will be deleted for inactivity (see
-- lib/privacy.js). Cleared on the next login.
ALTER TABLE users ADD COLUMN IF NOT EXISTS inactivity_warned_at TIMESTAMPTZ;
