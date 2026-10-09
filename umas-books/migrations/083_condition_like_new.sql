-- Condition grades become: new, like_new, very_good, good, acceptable.
-- "like_new" is a real grade again (migration 078 had merged it into very_good).
-- No data is converted back: the rows 078 moved are indistinguishable from
-- genuine very_good copies. Only the CHECK constraint widens, so it is safe on
-- a database with data and safe to run twice.
ALTER TABLE book_copies DROP CONSTRAINT IF EXISTS book_copies_condition_check;
ALTER TABLE book_copies
  ADD CONSTRAINT book_copies_condition_check
  CHECK (condition IN ('new', 'like_new', 'very_good', 'good', 'acceptable'));
