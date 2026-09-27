CREATE TABLE IF NOT EXISTS blog_posts (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  published_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_blog_posts_published_at ON blog_posts(published_at);
