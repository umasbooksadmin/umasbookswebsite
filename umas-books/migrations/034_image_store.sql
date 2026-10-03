-- Uploaded images (book covers, blog/announcement/charity photos) used to be
-- stored as `data:image/jpeg;base64,...` TEXT inside their rows. That made
-- every query selecting those columns huge (/api/books/search returned up to
-- 60 covers inline), left browsers nothing to cache, and put every image in
-- the nightly pg_dump — which the GitHub backup branch (100 MB file limit)
-- could not hold once a few thousand covers were loaded.
--
-- Images now live once, as bytes, in `images`, keyed by the SHA-256 of the
-- bytes (content-addressed: identical uploads dedupe, a URL never changes
-- meaning, so it can be cached forever). Rows keep only the short URL
-- `/img/<sha256>.<ext>`, served by src/routes/img.js. See ARCHITECTURE.md
-- "Images". Callers only ever see URL strings (src/lib/imageStore.js), so the
-- bytes can later move to object storage without touching them.
CREATE TABLE IF NOT EXISTS images (
  id           TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  data         BYTEA NOT NULL,
  byte_size    INT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One-time conversion of every existing inline image. Runs in the migration's
-- own transaction (src/migrate.js). Only well-formed jpeg/png/webp data URIs
-- are touched: http(s) URLs (Open Library covers), NULLs, empty strings and
-- anything unrecognised are left exactly as they were. Safe on an empty
-- database (no rows match) and re-runnable (converted rows no longer match).
DO $$
DECLARE
  target RECORD;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('books', 'cover_url'),
      ('announcements', 'image_url'),
      ('charities', 'image_url'),
      ('blog_posts', 'image_url')
    ) AS t(tbl, col)
  LOOP
    -- Bytes first (DISTINCT: the same picture in two rows is stored once)...
    EXECUTE format($q$
      INSERT INTO images (id, content_type, data, byte_size)
      SELECT DISTINCT ON (hash) hash, ctype, bytes, length(bytes)
      FROM (
        SELECT encode(sha256(b.bytes), 'hex') AS hash, b.ctype, b.bytes
        FROM (
          SELECT substring(%1$I FROM '^data:(image/(?:jpeg|png|webp));base64,') AS ctype,
                 decode(split_part(%1$I, ',', 2), 'base64') AS bytes
          FROM %2$I
          WHERE %1$I ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=[:space:]]+$'
        ) b
      ) hashed
      ORDER BY hash
      ON CONFLICT (id) DO NOTHING
    $q$, target.col, target.tbl);

    -- ...then point the rows at them.
    EXECUTE format($q$
      UPDATE %2$I SET %1$I =
        '/img/' || encode(sha256(decode(split_part(%1$I, ',', 2), 'base64')), 'hex')
        || CASE substring(%1$I FROM '^data:image/(jpeg|png|webp);base64,')
             WHEN 'png' THEN '.png' WHEN 'webp' THEN '.webp' ELSE '.jpg' END
      WHERE %1$I ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=[:space:]]+$'
    $q$, target.col, target.tbl);
  END LOOP;
END $$;
