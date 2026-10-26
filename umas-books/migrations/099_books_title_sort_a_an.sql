-- Alphabetical order also ignores a leading "A" or "An" (as migration 086 already did for "The").
--
-- books.title_sort is the one key every "sort by title" uses (catalogue search, More by this author, the admin
-- Inventory list, both collection screens). New rule, in this one place:
--   1. leading spaces, quotes, brackets and other punctuation dropped;
--   2. then one leading English article dropped when it is a whole first word followed by a space:
--      "The Hobbit" -> "hobbit", "A Midsummer Night's Dream" -> "midsummer night's dream", "An Introduction" -> "introduction".
--      "Theory", "Anne", "Another", "A. J. Ayer" are untouched; a title that is only "A", "An" or "The" keeps its text.
-- The displayed title is NOT changed. French articles are still not ignored. Keep in step with src/lib/titleSort.js.
--
-- PostgreSQL 16 and 18 cannot change the expression of a STORED generated column in place (only 17+ can), so the
-- column is dropped and added again, together with its index, in this migration's single transaction: it rewrites
-- the books table once (a few seconds at ~120k rows) and readers just wait for it. Safe to re-run: it does nothing
-- when the column already has the new expression.
DO $$
DECLARE
  current_expr TEXT;
BEGIN
  SELECT pg_get_expr(d.adbin, d.adrelid) INTO current_expr
    FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
   WHERE d.adrelid = 'books'::regclass AND a.attname = 'title_sort';
  IF current_expr IS NULL OR current_expr NOT LIKE '%an?%' THEN
    DROP INDEX IF EXISTS idx_books_title_sort;
    ALTER TABLE books DROP COLUMN IF EXISTS title_sort;
    ALTER TABLE books ADD COLUMN title_sort TEXT GENERATED ALWAYS AS (
      lower(
        regexp_replace(
          COALESCE(NULLIF(regexp_replace(title, '^[^[:alnum:]]+', ''), ''), title),
          '^(the[^[:alnum:]]*|an?)[[:space:]][^[:alnum:]]*([[:alnum:]])', '\2', 'i'
        )
      )
    ) STORED;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_books_title_sort ON books (title_sort, title, id);
