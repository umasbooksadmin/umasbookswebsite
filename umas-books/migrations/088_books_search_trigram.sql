-- Faster public catalogue search (GET /api/books/search).
--
-- The search runs  title/authors/description/categories ILIKE '%q%'  over every
-- book. With no index each search that matches little (a typo, a bot) reads the
-- whole table: about 0.15 s at 120k books, and 12 at once took 0.4-0.9 s each.
-- pg_trgm GIN indexes make ILIKE '%q%' an index lookup for any query of 3+
-- characters, WITHOUT changing what matches (same operator, same columns), so
-- results and their order (title_sort, PR #260) are unchanged.
--
-- pg_trgm is a "trusted" extension (PostgreSQL 13+), so the database owner can
-- create it on Render. If it cannot be created anyway (a restricted role, a host
-- without contrib), the migration still succeeds: the search then works exactly
-- as before, just without the indexes, and the application cap on query length
-- and the per-IP search limit still protect the database.
--
-- Safe to re-run (IF NOT EXISTS everywhere). Building the four indexes reads
-- the table once; at ~120k books that is a few seconds, and writes to `books`
-- (adding or editing a book) wait for it. The description index is the largest.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm is not available (%), catalogue search stays unindexed.', SQLERRM;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_books_title_trgm ON books USING gin (title gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_books_authors_trgm ON books USING gin (authors gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_books_categories_trgm ON books USING gin (categories gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_books_description_trgm ON books USING gin (description gin_trgm_ops)';
  END IF;
END
$$;
