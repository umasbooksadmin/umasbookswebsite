-- One-time tokens for "add a book copy" (Review A, L2). Every Add Book form and
-- every fast-scan save carries a random token; the server claims it before it
-- creates anything, so a double tap or a network retry of the same save returns
-- the first result instead of adding a second (phantom) copy that customers
-- could reserve. copy_id is NULL while the first save is still running.
-- Rows hold no personal data and are purged after a day.
CREATE TABLE IF NOT EXISTS copy_intake_tokens (
  token       TEXT PRIMARY KEY,
  copy_id     INTEGER REFERENCES book_copies(id) ON DELETE CASCADE,
  book_id     INTEGER REFERENCES books(id) ON DELETE SET NULL,
  requests    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_copy_intake_tokens_created ON copy_intake_tokens (created_at);
