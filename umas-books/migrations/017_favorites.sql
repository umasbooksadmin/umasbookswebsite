-- Server-side favorites for logged-in accounts, alongside (not
-- replacing) the existing per-browser localStorage favorites that
-- anonymous visitors already use (see public/favorites.js) — this table
-- is what a logged-in visitor's favorite-toggle click also writes to,
-- so there's a real pool of "books members favorited" to draw a random
-- recommendation from on the Browse Books page.

CREATE TABLE IF NOT EXISTS favorites (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, book_id)
);

CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_favorites_book ON favorites(book_id);
