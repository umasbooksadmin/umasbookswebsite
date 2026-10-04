-- Book condition grades: New, Like New, Very Good, Acceptable.
-- Old grades are remapped first (good -> very_good, fair and poor ->
-- acceptable; a copy that cannot be sold at all is handled by the status
-- "damaged", not by a condition), then the column is locked to the four grades.
UPDATE book_copies SET condition = 'very_good' WHERE condition = 'good';
UPDATE book_copies SET condition = 'acceptable' WHERE condition IN ('fair', 'poor');

ALTER TABLE book_copies ALTER COLUMN condition SET DEFAULT 'very_good';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'book_copies_condition_check') THEN
    ALTER TABLE book_copies
      ADD CONSTRAINT book_copies_condition_check
      CHECK (condition IN ('new', 'like_new', 'very_good', 'acceptable'));
  END IF;
END $$;

-- Binding of the edition: hardcover, paperback or mass market. Optional:
-- existing books stay NULL (not shown) until someone fills it in.
ALTER TABLE books ADD COLUMN IF NOT EXISTS binding TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'books_binding_check') THEN
    ALTER TABLE books
      ADD CONSTRAINT books_binding_check
      CHECK (binding IN ('hardcover', 'paperback', 'mass_market'));
  END IF;
END $$;
