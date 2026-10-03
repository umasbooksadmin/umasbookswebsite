-- One book record per ISBN. The admin "add book" route looks an ISBN up and
-- then inserts, which two simultaneous scans could both pass, leaving two
-- records for the same book. Only created when there are no duplicates
-- already in the table: if there are, this notes it and skips rather than
-- failing the deploy (the app still works without the index).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM books WHERE isbn IS NOT NULL AND isbn <> ''
    GROUP BY isbn HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE 'Skipping unique ISBN index: duplicate ISBNs exist in books. Merge them, then create idx_books_isbn_unique by hand.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS idx_books_isbn_unique ON books(isbn) WHERE isbn IS NOT NULL AND isbn <> '';
  END IF;
END $$;
