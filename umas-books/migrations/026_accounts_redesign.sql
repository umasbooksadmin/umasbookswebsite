-- Admin Accounts gains real per-account activity (orders, event/program
-- signups, drop-in seats — all matched by email, the same way this app
-- already links a HelloAsso payment back to an account, since the shop/
-- events/classes are guest-checkout by email rather than user_id), a
-- last-login timestamp, and the ability to disable an account's login.

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_disabled BOOLEAN NOT NULL DEFAULT FALSE;
