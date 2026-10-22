-- Two indexes duplicate a better one (Review A, L11). Each costs write time
-- and space on every insert/update and buys nothing:
--
--  * idx_books_isbn (007) is a plain btree on books(isbn); migration 038 added
--    the partial UNIQUE idx_books_isbn_unique (WHERE isbn IS NOT NULL AND
--    isbn <> ''). Every isbn lookup in the app (isbn = $1, isbn = ANY($1)) is
--    an equality on a real value, which the planner serves from the partial
--    index (EXPLAIN checked with and without the plain one: same plan).
--    038 skips creating the unique index when duplicate ISBNs exist, so the
--    plain index is dropped ONLY when the unique one is present and valid.
--
--  * idx_book_copies_status (007) is a btree on book_copies(status).
--    idx_book_copies_status_created (046) is (status, created_at): status is
--    its leading column, so every status-only filter is served by it (EXPLAIN:
--    Index Only Scan on the composite for a selective status).
--
-- DROP INDEX takes a brief ACCESS EXCLUSIVE lock on the table: fine at this
-- size. IF EXISTS keeps it re-runnable.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'idx_books_isbn_unique' AND i.indisvalid
  ) THEN
    DROP INDEX IF EXISTS idx_books_isbn;
  ELSE
    RAISE NOTICE 'Keeping idx_books_isbn: idx_books_isbn_unique does not exist (duplicate ISBNs, see 038).';
  END IF;
END $$;

DROP INDEX IF EXISTS idx_book_copies_status;
