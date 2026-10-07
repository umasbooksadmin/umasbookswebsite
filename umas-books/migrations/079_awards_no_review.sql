-- Awards on book pages now come only from Wikidata, the NYT API, or an admin
-- typing them in. The AI web-search source and the review step are gone.
--
-- Row semantics after this migration: every row in book_awards is
-- status 'verified' and source 'wikidata', 'nyt' or 'manual', and customers
-- see all of them. Idempotent: safe to run again.

-- AI suggestions (approved or not) and anything still pending or rejected
-- are removed. Rejected Wikidata/NYT rows go too: the 'hide' action no
-- longer exists, and the next lookup may add them back as shown rows.
DELETE FROM book_awards WHERE source = 'ai' OR status <> 'verified';

DROP INDEX IF EXISTS idx_book_awards_pending;
ALTER TABLE book_awards DROP CONSTRAINT IF EXISTS book_awards_source_check;
ALTER TABLE book_awards DROP CONSTRAINT IF EXISTS book_awards_status_check;
ALTER TABLE book_awards ADD CONSTRAINT book_awards_source_check CHECK (source IN ('wikidata', 'nyt', 'manual'));
ALTER TABLE book_awards ADD CONSTRAINT book_awards_status_check CHECK (status = 'verified');

-- Was the daily AI cap counter.
ALTER TABLE books DROP COLUMN IF EXISTS awards_ai_checked_at;
