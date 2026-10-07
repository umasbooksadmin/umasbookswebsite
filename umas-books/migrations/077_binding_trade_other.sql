-- Binding options become exactly: hardcover, trade, mass_market, other.
-- "paperback" is renamed "trade" (the same books, the same prices); NULL stays
-- NULL (unknown). Safe on a database with data and safe to run twice.

-- 1. Widen the check first, so it accepts both the old and the new values
--    while the rows are moved.
ALTER TABLE books DROP CONSTRAINT IF EXISTS books_binding_check;
ALTER TABLE books
  ADD CONSTRAINT books_binding_check
  CHECK (binding IN ('hardcover', 'paperback', 'trade', 'mass_market', 'other')) NOT VALID;

-- 2. Move the existing rows.
UPDATE books SET binding = 'trade' WHERE binding = 'paperback';

-- 3. Lock it to the four options (the old value is gone, so this validates).
ALTER TABLE books DROP CONSTRAINT books_binding_check;
ALTER TABLE books
  ADD CONSTRAINT books_binding_check
  CHECK (binding IN ('hardcover', 'trade', 'mass_market', 'other'));

-- 4. Pricing settings: the typical value for "paperback" is now for "trade".
--    The old column is kept (expand/contract) so the previous release keeps
--    working during a deploy; the code reads and writes fallback_trade only.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'pricing_settings' AND column_name = 'fallback_trade') THEN
    ALTER TABLE pricing_settings ADD COLUMN fallback_trade NUMERIC(8,2) NOT NULL DEFAULT 8.00;
    -- Carry over what the shop had set (only the first time: later runs must not
    -- overwrite values edited since).
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'pricing_settings' AND column_name = 'fallback_paperback') THEN
      UPDATE pricing_settings SET fallback_trade = fallback_paperback;
    END IF;
  END IF;
END $$;
