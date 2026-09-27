-- Charity votes gain: a reusable charity library (independent of any one
-- round), member-submitted charity ideas for admin review, multi-select
-- voting, and per-round settings (voting period, allow-multiple,
-- visibility, whether results show while voting is still open).

CREATE TABLE IF NOT EXISTS charities (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  category      TEXT,
  website_url   TEXT,
  image_url     TEXT,
  is_archived   BOOLEAN NOT NULL DEFAULT FALSE,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Approving an idea creates a row in `charities` above (resulting_charity_id
-- points to it) so it can then be added to a round; rejecting just marks
-- status without touching the library.
CREATE TABLE IF NOT EXISTS charity_ideas (
  id                    SERIAL PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT,
  category              TEXT,
  website_url           TEXT,
  submitted_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  resulting_charity_id  INTEGER REFERENCES charities(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE charity_rounds ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE charity_rounds ADD COLUMN IF NOT EXISTS allow_multiple BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE charity_rounds ADD COLUMN IF NOT EXISTS visible_to TEXT NOT NULL DEFAULT 'members';
ALTER TABLE charity_rounds DROP CONSTRAINT IF EXISTS charity_rounds_visible_to_check;
ALTER TABLE charity_rounds ADD CONSTRAINT charity_rounds_visible_to_check CHECK (visible_to IN ('members', 'everyone'));
ALTER TABLE charity_rounds ADD COLUMN IF NOT EXISTS show_results_during_vote BOOLEAN NOT NULL DEFAULT TRUE;

-- Options keep their own name/description for old rounds created before
-- this migration; a new option instead links to a library charity via
-- charity_id, and every reader COALESCEs from the joined charity first.
ALTER TABLE charity_options ADD COLUMN IF NOT EXISTS charity_id INTEGER REFERENCES charities(id) ON DELETE CASCADE;

-- Postgres treats NULL charity_id values as always distinct, so this only
-- actually stops the same library charity being added twice to one round
-- — it has no effect on old free-text options (charity_id IS NULL).
ALTER TABLE charity_options DROP CONSTRAINT IF EXISTS charity_options_round_charity_key;
ALTER TABLE charity_options ADD CONSTRAINT charity_options_round_charity_key UNIQUE (round_id, charity_id);

-- Multi-select voting: a member can now hold several rows per round
-- (one per option checked) instead of exactly one.
ALTER TABLE charity_votes DROP CONSTRAINT IF EXISTS charity_votes_round_id_user_id_key;
ALTER TABLE charity_votes DROP CONSTRAINT IF EXISTS charity_votes_round_option_user_key;
ALTER TABLE charity_votes ADD CONSTRAINT charity_votes_round_option_user_key UNIQUE (round_id, option_id, user_id);
