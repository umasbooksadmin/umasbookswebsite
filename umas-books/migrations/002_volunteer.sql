-- Volunteer shift scheduling

CREATE TABLE IF NOT EXISTS volunteer_shifts (
  id            SERIAL PRIMARY KEY,
  role          TEXT NOT NULL,
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  capacity      INTEGER NOT NULL DEFAULT 1,
  notes         TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS volunteer_signups (
  id            SERIAL PRIMARY KEY,
  shift_id      INTEGER NOT NULL REFERENCES volunteer_shifts(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shift_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_volunteer_shifts_starts_at ON volunteer_shifts(starts_at);
CREATE INDEX IF NOT EXISTS idx_volunteer_signups_shift ON volunteer_signups(shift_id);
