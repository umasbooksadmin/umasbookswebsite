-- Learning loop (data only for now): what price was suggested when a copy was
-- entered, which level it was ('3', '5', '8', '10', 'custom', 'clearance' or
-- 'review' when a person had to decide), and whether the volunteer kept it
-- ('suggested'), changed it ('adjusted') or there was no suggestion ('manual').
ALTER TABLE book_copies ADD COLUMN IF NOT EXISTS suggested_price NUMERIC(10,2);
ALTER TABLE book_copies ADD COLUMN IF NOT EXISTS suggested_level TEXT;
ALTER TABLE book_copies ADD COLUMN IF NOT EXISTS price_basis TEXT;
ALTER TABLE book_copies DROP CONSTRAINT IF EXISTS book_copies_price_basis_check;
ALTER TABLE book_copies ADD CONSTRAINT book_copies_price_basis_check
  CHECK (price_basis IS NULL OR price_basis IN ('suggested', 'adjusted', 'manual'));

-- Clearance copy (price set by the clearance rule). Sticky: a copy stays
-- clearance when other copies of the book sell; it only changes when a
-- volunteer changes its price.
ALTER TABLE book_copies ADD COLUMN IF NOT EXISTS is_clearance BOOLEAN NOT NULL DEFAULT false;
