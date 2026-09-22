-- Public (no-login) book wishlist: anyone can request a title they'd
-- like the shop to look out for. Staff review requests in admin and
-- mark them fulfilled once found/notified.

CREATE TABLE IF NOT EXISTS wishlist_requests (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  author        TEXT,
  email         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wishlist_requests_status ON wishlist_requests(status);
