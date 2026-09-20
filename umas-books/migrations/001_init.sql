-- Uma's Books members area — initial schema
-- The "session" table used by connect-pg-simple is created automatically
-- at startup (createTableIfMissing: true in src/db.js), so it's not here.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS announcements (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  published_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT,
  location      TEXT,
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ,
  capacity      INTEGER,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS event_rsvps (
  id            SERIAL PRIMARY KEY,
  event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id)
);

CREATE TABLE IF NOT EXISTS forum_threads (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  author_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS forum_replies (
  id            SERIAL PRIMARY KEY,
  thread_id     INTEGER NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  author_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS charity_rounds (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  opens_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closes_at     TIMESTAMPTZ,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS charity_options (
  id            SERIAL PRIMARY KEY,
  round_id      INTEGER NOT NULL REFERENCES charity_rounds(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT
);

CREATE TABLE IF NOT EXISTS charity_votes (
  id            SERIAL PRIMARY KEY,
  round_id      INTEGER NOT NULL REFERENCES charity_rounds(id) ON DELETE CASCADE,
  option_id     INTEGER NOT NULL REFERENCES charity_options(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (round_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_event_rsvps_event ON event_rsvps(event_id);
CREATE INDEX IF NOT EXISTS idx_forum_replies_thread ON forum_replies(thread_id);
CREATE INDEX IF NOT EXISTS idx_charity_options_round ON charity_options(round_id);
CREATE INDEX IF NOT EXISTS idx_charity_votes_round ON charity_votes(round_id);
