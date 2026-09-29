-- Nothing verified that a signup actually controlled the email address
-- they typed in. Combined with HelloAsso membership payments being
-- matched to a local account purely by email (see lib/membership.js),
-- this let an attacker register someone else's real email address first
-- — permanently blocking the real person from ever signing up with their
-- own email (UNIQUE constraint) — and silently inherit any membership
-- payment that real person later made through HelloAsso, since the sync
-- only ever asks "which account has this email", never "does this
-- account's holder actually own it".
--
-- Grandfathers every existing account as already verified: retroactively
-- requiring everyone to re-verify would lock real members out of
-- accounts they already legitimately hold, which is worse than the
-- narrow risk being closed here. This protects every signup from this
-- point forward — see the email_verified_at check in
-- syncMembershipForEmail (lib/membership.js), which only an account with
-- a verified email can ever be auto-matched into.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user ON email_verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_hash ON email_verification_tokens(token_hash);
