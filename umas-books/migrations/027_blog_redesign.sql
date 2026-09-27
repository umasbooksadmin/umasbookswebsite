-- Blog gains a real editorial workflow (draft/scheduled/published),
-- categories, tags, a featured image, and a slug so posts can be linked
-- to individually (blog.html?post=<slug>, matching the existing static
-- assets/posts.js posts) — see src/routes/admin.js and the new public
-- src/routes/blog.js (/api/blog/posts).

ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS excerpt TEXT;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS tags TEXT;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published';
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE blog_posts ALTER COLUMN published_at DROP NOT NULL;

-- Backfill before enforcing NOT NULL/uniqueness, for any posts already
-- created via the earlier bare-bones admin/blog page.
UPDATE blog_posts SET slug = 'post-' || id WHERE slug IS NULL;
ALTER TABLE blog_posts ALTER COLUMN slug SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_posts_slug ON blog_posts(slug);

ALTER TABLE blog_posts DROP CONSTRAINT IF EXISTS blog_posts_status_check;
ALTER TABLE blog_posts ADD CONSTRAINT blog_posts_status_check CHECK (status IN ('draft', 'scheduled', 'published'));

CREATE INDEX IF NOT EXISTS idx_blog_posts_status ON blog_posts(status);

-- One-time import of the 3 posts that used to live only in the static
-- assets/posts.js (English text only — that file also had French, which
-- this single-language admin editor has no field for; the file itself is
-- left on disk, just no longer read by the public pages). Keyed by slug
-- so this is safe to run again.
INSERT INTO blog_posts (slug, title, excerpt, body, category, image_url, status, published_at)
VALUES
  (
    'welcome',
    'Welcome to Uma’s Books & Adventures',
    'A small, unhurried space in Albi for pre-loved English books, languages and a little bit of home.',
    '<p>Uma’s Books & Adventures is a non-profit bookshop built entirely on books that already had one home before finding their way to our shelves.</p><p>Run by volunteers, the shop exists for one simple reason: to keep good English-language books affordable, in circulation, and easy to find — however far from home you happen to be.</p><p>As much as a bookshop, it is a meeting point, where anglophones and francophones cross paths over a shared shelf and swap more than books: languages, recommendations, and a little bit of home. Come and say hello on Rue Peyrolière.</p>',
    'News',
    'assets/img/shop-interior.jpg',
    'published',
    '2026-09-24'
  ),
  (
    'donating-books',
    'Give your books a second life',
    'Every shelf here started as someone’s donation. Here’s how to bring yours in.',
    '<p>Every shelf in the shop started as someone’s donation. Bringing in your gently used English-language books gives them a second life and keeps our prices low for the whole community.</p><p>Bring your books by during opening hours, or get in touch at admin@umasbooks.org to arrange a drop-off.</p>',
    'Donations',
    'assets/img/medallion-donate.png',
    'published',
    '2026-09-24'
  ),
  (
    'volunteering',
    'Volunteers wanted',
    'Uma’s is entirely volunteer-run — new helpers of any language level are always welcome.',
    '<p>Uma’s is entirely volunteer-run, and new helpers of any language level are always welcome.</p><p>Whether you can give a few hours a month or a regular shift, there’s a role for you. See the roles and sign up on our Volunteer page.</p>',
    'Community',
    'assets/img/medallion-browse.png',
    'published',
    '2026-09-24'
  )
ON CONFLICT (slug) DO NOTHING;
