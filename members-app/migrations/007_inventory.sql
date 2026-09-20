-- Book inventory: one row per title/edition, with individual physical
-- copies tracked separately (each copy has its own condition/price/status).

CREATE TABLE IF NOT EXISTS books (
  id              SERIAL PRIMARY KEY,
  isbn            TEXT,
  title           TEXT NOT NULL,
  authors         TEXT,
  publisher       TEXT,
  published_year  INTEGER,
  description     TEXT,
  cover_url       TEXT,
  categories      TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_books_isbn ON books(isbn);
CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);

CREATE TABLE IF NOT EXISTS book_copies (
  id              SERIAL PRIMARY KEY,
  book_id         INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  condition       TEXT NOT NULL DEFAULT 'good',
  price           NUMERIC(10,2),
  status          TEXT NOT NULL DEFAULT 'in_stock',
  acquired_at     DATE,
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_book_copies_book ON book_copies(book_id);
CREATE INDEX IF NOT EXISTS idx_book_copies_status ON book_copies(status);
