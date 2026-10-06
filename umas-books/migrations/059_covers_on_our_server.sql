-- Book covers are served from our own server (src/lib/coverStore.js), never
-- loaded in a visitor's browser from Open Library / the Internet Archive.
--
--   cover_url             now only ever the stored copy (an /img/<sha256>.jpg address) or NULL.
--   cover_source_url      the allowed external address the copy is downloaded from; kept
--                         only so the background job (and a retry) can fetch it.
--   cover_fetch_failures  failed downloads since the last success, reset after a week.
--   cover_fetch_attempted_at  last download attempt: spaces retries out and caps them
--                         at 3 a week.
--
-- Existing books whose cover_url is an external http(s) address move that
-- address to cover_source_url and show no cover until the background job has
-- copied it (20 books every 5 minutes, books on the shelves first). Stored
-- images (an /img address) are untouched. Re-runnable: converted rows no longer match.
ALTER TABLE books ADD COLUMN IF NOT EXISTS cover_source_url TEXT;
ALTER TABLE books ADD COLUMN IF NOT EXISTS cover_fetch_failures INT NOT NULL DEFAULT 0;
ALTER TABLE books ADD COLUMN IF NOT EXISTS cover_fetch_attempted_at TIMESTAMPTZ;

UPDATE books
   SET cover_source_url = cover_url, cover_url = NULL
 WHERE cover_url ~* '^https?://';

-- Only external sources worth fetching are looked up by the job.
CREATE INDEX IF NOT EXISTS idx_books_cover_pending ON books (id)
 WHERE cover_url IS NULL AND cover_source_url IS NOT NULL;
