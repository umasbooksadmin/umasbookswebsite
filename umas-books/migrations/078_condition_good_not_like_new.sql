-- Condition grades become exactly: new, very_good, good, acceptable.
-- "like_new" is merged into "very_good"; "good" (which migration 048 had folded
-- into very_good) is a grade again. Safe on a database with data and safe to
-- run twice.

-- 1. Widen the check so old and new values are both accepted while rows move.
ALTER TABLE book_copies DROP CONSTRAINT IF EXISTS book_copies_condition_check;
ALTER TABLE book_copies
  ADD CONSTRAINT book_copies_condition_check
  CHECK (condition IN ('new', 'like_new', 'very_good', 'good', 'acceptable')) NOT VALID;

-- 2. Move the existing rows.
UPDATE book_copies SET condition = 'very_good' WHERE condition = 'like_new';

-- 3. Lock it to the four grades (the old value is gone, so this validates).
ALTER TABLE book_copies DROP CONSTRAINT book_copies_condition_check;
ALTER TABLE book_copies
  ADD CONSTRAINT book_copies_condition_check
  CHECK (condition IN ('new', 'very_good', 'good', 'acceptable'));
