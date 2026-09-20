-- Public (no-login) class sign-ups. Same shape as events (008_public_events.sql)
-- but a separate table since classes are a distinct concept (recurring
-- sessions like Éveil) from one-off events.

CREATE TABLE IF NOT EXISTS classes (
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

CREATE INDEX IF NOT EXISTS idx_classes_starts_at ON classes(starts_at);

CREATE TABLE IF NOT EXISTS class_signups (
  id            SERIAL PRIMARY KEY,
  class_id      INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (class_id, email)
);

CREATE INDEX IF NOT EXISTS idx_class_signups_class ON class_signups(class_id);
