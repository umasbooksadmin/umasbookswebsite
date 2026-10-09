-- Alphabetical order ignores a leading "The".
--
-- books.title_sort is the key every "sort by title" uses (catalogue search,
-- More by this author, the admin Inventory list): the title lower-cased, with
--   1. leading spaces, quotes, brackets and other punctuation dropped, and
--   2. one leading English article "The" dropped when it is a whole first word
--      ("The Hobbit" -> "hobbit"; "Theory" and "Theodore" are untouched;
--      "The Road" in curly quotes -> "road").
-- A title that is only "The" or only punctuation keeps its own text. The
-- displayed title is NOT changed. "A"/"An" and French articles are not
-- ignored. Keep in step with sortTitleKey() in src/lib/titleSort.js.
--
-- A STORED generated column, so it follows every title edit by itself and
-- needs no backfill code. Adding it rewrites the books table once (a few
-- seconds at ~120k rows); safe to re-run.
ALTER TABLE books ADD COLUMN IF NOT EXISTS title_sort TEXT GENERATED ALWAYS AS (
  lower(
    regexp_replace(
      COALESCE(NULLIF(regexp_replace(title, '^[^[:alnum:]]+', ''), ''), title),
      '^the[^[:alnum:]]*[[:space:]][^[:alnum:]]*([[:alnum:]])', '\1', 'i'
    )
  )
) STORED;

CREATE INDEX IF NOT EXISTS idx_books_title_sort ON books (title_sort, title, id);
