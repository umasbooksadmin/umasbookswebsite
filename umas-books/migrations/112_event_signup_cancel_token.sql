-- Event sign-ups get a cancel link (review 6A L3 / 6B M4). Anyone can type any address into the public sign-up form,
-- so every new sign-up is confirmed by an email to that address with a link that cancels it (routes/events.js): a
-- person signed up without knowing finds out and can undo it, and a mistyped address can be withdrawn.
--   cancel_token_hash  SHA-256 of the random link token (lib/resetTokens.js); the token itself only ever appears in
--                      the email, whose body is blanked once sent (lib/outbox.js TOKEN_KINDS). NULL for sign-ups made
--                      before this column existed (no link was sent for them).
-- Cancelling deletes the sign-up row, so the seat count (COUNT(*) of the rows) is right at once.
-- Nullable, no default (no row rewrite), nothing existing changed: undo is
-- DROP INDEX event_signups_cancel_token_idx; ALTER TABLE event_signups DROP COLUMN cancel_token_hash;
ALTER TABLE event_signups ADD COLUMN IF NOT EXISTS cancel_token_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS event_signups_cancel_token_idx ON event_signups (cancel_token_hash) WHERE cancel_token_hash IS NOT NULL;
