-- Admin > Genres (/admin/genres): the managed genre list, the rules that slot raw genres into it, and the history
-- of "Update all books" runs. NEW TABLES ONLY: no book is rewritten here (books.categories is only changed when an
-- admin previews and confirms an Update-all run, or saves a book while rules exist). Seeding is idempotent.
--
--   managed_genres  the genres the shop wants to use, EN + FR. Seeded from the CURRENT canonical lists
--                   (COMMON_GENRES + COMMON_GENRES_FR of lib/bookLookup.js, same order) so nothing changes until the
--                   admin edits. The public Browse page's genre buttons are drawn from the rows with show_on_browse
--                   (lib/browseGenres.js): the 13 buttons that existed are seeded here with their exact slug, label,
--                   search words, colour and icon, so Browse is unchanged. (The "All Genres" button is not a genre:
--                   it stays in code, always last.) Two genres are added to the canonical 23 because Browse has a
--                   button for them: Health & Wellness and Home & Garden.
--   genre_rules     "this raw genre (exact) / any genre containing this word (contains-word) becomes this managed
--                   genre, or is removed, or is left as it is (keep)". First match wins: exact before contains-word,
--                   then sort_order.
--   genre_runs / genre_run_changes   one row per Update-all run, and the before / after of every book it changed
--                   (so Undo restores exactly those books while they still hold what the run wrote).
CREATE TABLE IF NOT EXISTS managed_genres (
  id              SERIAL PRIMARY KEY,
  name_en         TEXT NOT NULL CHECK (btrim(name_en) <> ''),
  name_fr         TEXT NOT NULL DEFAULT '',
  sort_order      INTEGER NOT NULL DEFAULT 0,
  show_on_browse  BOOLEAN NOT NULL DEFAULT TRUE,
  browse_slug     TEXT,
  browse_order    INTEGER NOT NULL DEFAULT 0,
  browse_label_en TEXT,
  browse_label_fr TEXT,
  browse_topic    TEXT,
  colour          TEXT,
  icon            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS managed_genres_name_en_lower ON managed_genres (lower(name_en));
CREATE UNIQUE INDEX IF NOT EXISTS managed_genres_browse_slug ON managed_genres (browse_slug);

CREATE TABLE IF NOT EXISTS genre_rules (
  id                      SERIAL PRIMARY KEY,
  kind                    TEXT NOT NULL CHECK (kind IN ('exact', 'contains-word')),
  pattern                 TEXT NOT NULL CHECK (btrim(pattern) <> ''),
  pattern_key             TEXT NOT NULL,
  action                  TEXT NOT NULL DEFAULT 'map' CHECK (action IN ('map', 'remove', 'keep')),
  target_managed_genre_id INTEGER REFERENCES managed_genres (id) ON DELETE CASCADE,
  sort_order              INTEGER NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((action = 'map') = (target_managed_genre_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS genre_rules_kind_key ON genre_rules (kind, pattern_key);

CREATE TABLE IF NOT EXISTS genre_runs (
  id             SERIAL PRIMARY KEY,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  actor_user_id  INTEGER REFERENCES users (id) ON DELETE SET NULL,
  actor_label    TEXT,
  books_changed  INTEGER NOT NULL DEFAULT 0,
  genres_removed INTEGER NOT NULL DEFAULT 0,
  rules_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  undone_at      TIMESTAMPTZ,
  undo_restored  INTEGER
);

-- book_id is deliberately not a foreign key: a book deleted later must not block anything, and Undo skips it.
CREATE TABLE IF NOT EXISTS genre_run_changes (
  run_id            INTEGER NOT NULL REFERENCES genre_runs (id) ON DELETE CASCADE,
  book_id           INTEGER NOT NULL,
  old_categories    TEXT,
  old_categories_fr TEXT,
  new_categories    TEXT,
  new_categories_fr TEXT,
  PRIMARY KEY (run_id, book_id)
);

INSERT INTO managed_genres (name_en, name_fr, sort_order, show_on_browse, browse_slug, browse_order, browse_label_en, browse_label_fr, browse_topic, colour, icon)
VALUES
  ('Fiction', 'Fiction', 1, TRUE, 'fiction', 1, 'Fiction', 'Fiction', 'fiction', 'rose', 'open-book'),
  ('Non-fiction', 'Non-fiction', 2, TRUE, 'nonfiction', 4, 'Non-Fiction', 'Documentaires', 'nonfiction,non-fiction,history,social science,political,philosophy,psychology,business,education,true crime,nature,religion,language', 'sky', 'globe'),
  ('Fantasy', 'Fantasy', 3, FALSE, 'fantasy', 0, NULL, NULL, NULL, 'sage', 'book'),
  ('Science Fiction', 'Science-fiction', 4, FALSE, 'science-fiction', 0, NULL, NULL, NULL, 'sky', 'book'),
  ('Mystery', 'Policier', 5, TRUE, 'mystery', 6, 'Mystery & Thriller', 'Polar & Thriller', 'mystery,thriller,suspense,crime,detective', 'sage', 'magnifier'),
  ('Romance', 'Romance', 6, TRUE, 'romance', 7, 'Romance', 'Romance', 'romance,love', 'rose', 'heart'),
  ('Thriller', 'Thriller', 7, FALSE, 'thriller', 0, NULL, NULL, NULL, 'coral', 'book'),
  ('Horror', 'Horreur', 8, FALSE, 'horror', 0, NULL, NULL, NULL, 'blush', 'book'),
  ('Biography', 'Biographie', 9, TRUE, 'biography', 8, 'Biography & Memoir', 'Biographies & Mémoires', 'biography,memoir,autobiography', 'pink', 'people'),
  ('History', 'Histoire', 10, FALSE, 'history', 0, NULL, NULL, NULL, 'apricot', 'book'),
  ('Poetry', 'Poésie', 11, FALSE, 'poetry', 0, NULL, NULL, NULL, 'pink', 'book'),
  ('Drama', 'Théâtre', 12, FALSE, 'drama', 0, NULL, NULL, NULL, 'blush', 'book'),
  ('Adventure', 'Aventure', 13, FALSE, 'adventure', 0, NULL, NULL, NULL, 'moss', 'book'),
  ('Humor', 'Humour', 14, FALSE, 'humor', 0, NULL, NULL, NULL, 'apricot', 'book'),
  ('Philosophy', 'Philosophie', 15, FALSE, 'philosophy', 0, NULL, NULL, NULL, 'sky', 'book'),
  ('Religion', 'Religion', 16, FALSE, 'religion', 0, NULL, NULL, NULL, 'cream', 'book'),
  ('Travel', 'Voyage', 17, TRUE, 'travel', 11, 'Travel', 'Voyage', 'travel', 'sky', 'map-globe'),
  ('Cooking', 'Cuisine', 18, TRUE, 'food', 12, 'Food & Drink', 'Cuisine & Boissons', 'cooking,food,drink,wine,recipe,baking', 'coral', 'pot'),
  ('Art', 'Art', 19, TRUE, 'arts', 10, 'Arts & Crafts', 'Arts & Loisirs créatifs', 'arts,crafts,hobbies,design,music,photography,antiques,performing', 'apricot', 'palette'),
  ('Self-help', 'Développement personnel', 20, FALSE, 'self-help', 0, NULL, NULL, NULL, 'moss', 'book'),
  ('Children''s Fiction', 'Fiction jeunesse', 21, TRUE, 'children', 2, 'Children''s Books', 'Jeunesse', 'juvenile,child,picture book,baby', 'sage', 'rocking-horse'),
  ('Young Adult Fiction', 'Fiction jeune adulte', 22, TRUE, 'ya', 3, 'Young Adult', 'Jeune adulte', 'young adult', 'apricot', 'leaf-quill'),
  ('Classics', 'Classiques', 23, TRUE, 'classics', 5, 'Classics', 'Classiques', 'classic', 'blush', 'book-stack'),
  ('Health & Wellness', 'Santé & Bien-être', 24, TRUE, 'health', 9, 'Health & Wellness', 'Santé & Bien-être', 'health,fitness,wellness,self-help,mind,body', 'moss', 'sprout'),
  ('Home & Garden', 'Maison & Jardin', 25, TRUE, 'home', 13, 'Home & Garden', 'Maison & Jardin', 'gardening,garden,house,home,interior', 'sage', 'house')
ON CONFLICT DO NOTHING;
