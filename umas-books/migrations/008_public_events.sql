-- Public (no-login) event sign-ups. Reuses the existing `events` table
-- (unchanged since 001_init.sql). The old `event_rsvps` table required a
-- registered user_id and is left as-is, unused, since events are now
-- open to anyone — sign-ups go in this new table instead, keyed by email.

CREATE TABLE IF NOT EXISTS event_signups (
  id            SERIAL PRIMARY KEY,
  event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, email)
);

CREATE INDEX IF NOT EXISTS idx_event_signups_event ON event_signups(event_id);
