-- French counterparts of the AI-assisted book content: the genre picked
-- from the site's fixed taxonomy has a deterministic French translation
-- (no AI needed — see translateGenresToFrench in src/lib/bookLookup.js),
-- and the free-text description gets a translated French version
-- alongside the English one AI already generates.

ALTER TABLE books ADD COLUMN IF NOT EXISTS description_fr TEXT;
ALTER TABLE books ADD COLUMN IF NOT EXISTS categories_fr TEXT;
