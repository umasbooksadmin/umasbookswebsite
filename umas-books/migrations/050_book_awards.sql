-- Awards and best-seller lists shown on each book page.
--
-- Trust model: rows from Wikidata / the NYT API / an admin ('verified') are
-- shown to customers at once. Rows found by AI web search start 'pending'
-- and stay hidden until an admin approves them ('approved'); 'rejected'
-- rows are kept so the same suggestion is never offered again.
CREATE TABLE IF NOT EXISTS book_awards (
  id SERIAL PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (char_length(label) <= 200),
  year INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('award', 'shortlist', 'bestseller', 'list')),
  source TEXT NOT NULL CHECK (source IN ('wikidata', 'nyt', 'ai', 'manual')),
  source_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('verified', 'pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- One row per book + label + year (case-insensitive; no year counts as 0).
CREATE UNIQUE INDEX IF NOT EXISTS idx_book_awards_unique ON book_awards (book_id, lower(label), COALESCE(year, 0));
CREATE INDEX IF NOT EXISTS idx_book_awards_pending ON book_awards (created_at) WHERE status = 'pending';

-- When the book was last looked up and how it went ('ok' = found something,
-- 'none' = looked, nothing found, 'error' = a lookup failed, retried later).
-- awards_ai_checked_at counts toward the daily AI cap (AWARDS_AI_DAILY_MAX).
ALTER TABLE books ADD COLUMN IF NOT EXISTS awards_checked_at TIMESTAMPTZ;
ALTER TABLE books ADD COLUMN IF NOT EXISTS awards_check_state TEXT CHECK (awards_check_state IN ('ok', 'none', 'error'));
ALTER TABLE books ADD COLUMN IF NOT EXISTS awards_ai_checked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_books_awards_unchecked ON books (id DESC) WHERE awards_checked_at IS NULL;
