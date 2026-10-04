-- Account pre-hijack fix. A self-signup account whose email has never been
-- confirmed cannot log in, and its FIRST email confirmation (the emailed
-- link) is treated as a change of ownership: the signup password is thrown
-- away and the person must choose a new one (see GET /verify-email/:token in
-- routes/auth.js). Without this, someone could sign up with a victim's email
-- and their own password, wait for the victim to click "confirm your email",
-- and then own a verified account holding the victim's membership and data.
--
-- The flag is set only by POST /signup. Accounts created by an admin (verified
-- at once), accounts grandfathered as verified in migration 032, and accounts
-- whose email an admin later changed (a known member who keeps their
-- password) are all FALSE and behave as before.
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_verification_pending BOOLEAN NOT NULL DEFAULT FALSE;

-- Signups already waiting for their first confirmation fall under the same
-- rule (they may well be squatters).
UPDATE users SET first_verification_pending = TRUE WHERE email_verified_at IS NULL;
