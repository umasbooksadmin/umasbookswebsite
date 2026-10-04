-- Money columns get a sanity range in the database too, so a bad value (a
-- negative price, a stray extra digit) can never be stored whichever code path
-- writes it: price / cost / drop-in price are NULL (not known) or 0 up to just
-- under 100000 euros. The admin forms refuse anything over 10000 and with more
-- than 2 decimals (src/lib/validation.js parseMoney); this is the backstop.
--
-- A copy or a class that already holds an out-of-range value gets NULL instead:
-- a copy with no price is "ask in the shop" (it cannot be bought online), a
-- class with no drop-in price is not sold as drop-in, so nothing out of range
-- stays purchasable. Idempotent: safe to run twice.
UPDATE book_copies SET price = NULL WHERE price IS NOT NULL AND (price < 0 OR price >= 100000);
UPDATE book_copies SET acquisition_cost = NULL WHERE acquisition_cost IS NOT NULL AND (acquisition_cost < 0 OR acquisition_cost >= 100000);
UPDATE classes SET dropin_price = NULL WHERE dropin_price IS NOT NULL AND (dropin_price < 0 OR dropin_price >= 100000);

ALTER TABLE book_copies DROP CONSTRAINT IF EXISTS book_copies_price_range_check;
ALTER TABLE book_copies ADD CONSTRAINT book_copies_price_range_check
  CHECK (price IS NULL OR (price >= 0 AND price < 100000)) NOT VALID;
ALTER TABLE book_copies VALIDATE CONSTRAINT book_copies_price_range_check;

ALTER TABLE book_copies DROP CONSTRAINT IF EXISTS book_copies_acquisition_cost_range_check;
ALTER TABLE book_copies ADD CONSTRAINT book_copies_acquisition_cost_range_check
  CHECK (acquisition_cost IS NULL OR (acquisition_cost >= 0 AND acquisition_cost < 100000)) NOT VALID;
ALTER TABLE book_copies VALIDATE CONSTRAINT book_copies_acquisition_cost_range_check;

ALTER TABLE classes DROP CONSTRAINT IF EXISTS classes_dropin_price_range_check;
ALTER TABLE classes ADD CONSTRAINT classes_dropin_price_range_check
  CHECK (dropin_price IS NULL OR (dropin_price >= 0 AND dropin_price < 100000)) NOT VALID;
ALTER TABLE classes VALIDATE CONSTRAINT classes_dropin_price_range_check;
