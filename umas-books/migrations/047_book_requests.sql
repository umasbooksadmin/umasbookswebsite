-- Customer book requests ("Can't find a book? Ask us"). Replaces the retired
-- wishlist (011, dropped in 029). No login or membership needed: a request is
-- identified by an email address confirmed with a link (double opt-in).
--
-- Personal columns (email, name, note, admin_note, user_id) are cleared when a
-- request is cancelled, expires, or has been closed for 30 days, so only
-- title/author/ISBN remain for anonymous demand counts (lib/privacy.js).
-- Tokens are stored hashed (lib/resetTokens.js); the raw value only ever
-- appears in an email.
CREATE TABLE IF NOT EXISTS book_requests (
  id                 SERIAL PRIMARY KEY,
  title              TEXT NOT NULL,
  author             TEXT,
  isbn               TEXT,
  note               TEXT,
  admin_note         TEXT,
  email              TEXT,
  name               TEXT,
  lang               TEXT CHECK (lang IN ('en', 'fr')),
  user_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'unconfirmed'
                     CHECK (status IN ('unconfirmed', 'open', 'matched', 'notified', 'fulfilled', 'cancelled', 'expired')),
  confirm_token_hash TEXT,
  manage_token_hash  TEXT,
  confirmed_at       TIMESTAMPTZ,
  notified_at        TIMESTAMPTZ,
  matched_copy_id    INTEGER REFERENCES book_copies(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS book_requests_status_idx ON book_requests (status);
CREATE INDEX IF NOT EXISTS book_requests_email_idx ON book_requests (lower(email));
CREATE INDEX IF NOT EXISTS book_requests_isbn_idx ON book_requests (isbn);
CREATE INDEX IF NOT EXISTS book_requests_title_idx ON book_requests (lower(title));
CREATE INDEX IF NOT EXISTS book_requests_user_idx ON book_requests (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS book_requests_confirm_token_idx ON book_requests (confirm_token_hash) WHERE confirm_token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS book_requests_manage_token_idx ON book_requests (manage_token_hash) WHERE manage_token_hash IS NOT NULL;

-- "Find my requests": a 30-day emailed link that lists every request of one
-- address. Holds the address only until the link expires (purged daily).
CREATE TABLE IF NOT EXISTS book_request_list_tokens (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS book_request_list_tokens_email_idx ON book_request_list_tokens (email);
