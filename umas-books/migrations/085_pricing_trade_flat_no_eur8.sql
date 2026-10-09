-- Pricing change: Trade and Mass Market are both a flat EUR 5, and EUR 8 is no
-- longer a standard price (levels become 3, 5, 10).
--
--  1. New setting trade_price (default 5), next to mass_market_price.
--  2. The stored pricing_settings row is moved to the new defaults ONLY where
--     a value still equals the OLD default; anything the maintainer edited on
--     /admin/pricing is left alone:
--        levels             [3,5,8,10] -> [3,5,10]
--        b_price            8          -> 10  (Rule B was EUR 8; 10 is the nearest remaining level)
--        fallback_trade     8          -> 5
--        fallback_mass_market 4        -> 5
--        fallback_unknown   8          -> 5
--     Each condition is exact and independent, so running this twice changes
--     nothing the second time (the new values no longer match the old ones).
--  3. The column defaults follow, so a re-created row starts with the new numbers.
--  4. Tables for the one-off "Reprice" tool (/admin/pricing/reprice): one row
--     per confirmed run and, per copy changed, its before/after, so a run can
--     be reviewed, exported (CSV) and reversed by hand. NO book copy is
--     changed by this migration: prices only change when an admin confirms a
--     group on that page. book_copies.price_basis may now also be 'repriced'.

ALTER TABLE pricing_settings ADD COLUMN IF NOT EXISTS trade_price NUMERIC(8,2) NOT NULL DEFAULT 5.00;

UPDATE pricing_settings SET levels = '[3,5,10]'::jsonb, updated_at = now() WHERE id = 1 AND levels = '[3,5,8,10]'::jsonb;
UPDATE pricing_settings SET b_price = 10.00, updated_at = now() WHERE id = 1 AND b_price = 8.00;
UPDATE pricing_settings SET fallback_trade = 5.00, updated_at = now() WHERE id = 1 AND fallback_trade = 8.00;
UPDATE pricing_settings SET fallback_mass_market = 5.00, updated_at = now() WHERE id = 1 AND fallback_mass_market = 4.00;
UPDATE pricing_settings SET fallback_unknown = 5.00, updated_at = now() WHERE id = 1 AND fallback_unknown = 8.00;

ALTER TABLE pricing_settings ALTER COLUMN levels SET DEFAULT '[3,5,10]';
ALTER TABLE pricing_settings ALTER COLUMN b_price SET DEFAULT 10.00;
ALTER TABLE pricing_settings ALTER COLUMN fallback_trade SET DEFAULT 5.00;
ALTER TABLE pricing_settings ALTER COLUMN fallback_mass_market SET DEFAULT 5.00;
ALTER TABLE pricing_settings ALTER COLUMN fallback_unknown SET DEFAULT 5.00;

ALTER TABLE book_copies DROP CONSTRAINT IF EXISTS book_copies_price_basis_check;
ALTER TABLE book_copies ADD CONSTRAINT book_copies_price_basis_check
  CHECK (price_basis IS NULL OR price_basis IN ('suggested', 'adjusted', 'manual', 'repriced'));

CREATE TABLE IF NOT EXISTS price_reprice_runs (
  id               SERIAL PRIMARY KEY,
  group_key        TEXT NOT NULL CHECK (group_key IN ('trade', 'mass_market', 'eight_to_ten')),
  new_price        NUMERIC(10,2) NOT NULL,
  copies_changed   INTEGER NOT NULL DEFAULT 0,
  actor_user_id    INTEGER,
  actor_label      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS price_reprice_items (
  id                   SERIAL PRIMARY KEY,
  run_id               INTEGER NOT NULL REFERENCES price_reprice_runs(id) ON DELETE CASCADE,
  copy_id              INTEGER NOT NULL,
  book_id              INTEGER,
  title                TEXT,
  binding              TEXT,
  old_price            NUMERIC(10,2),
  new_price            NUMERIC(10,2) NOT NULL,
  old_suggested_price  NUMERIC(10,2),
  old_suggested_level  TEXT,
  old_price_basis      TEXT
);
CREATE INDEX IF NOT EXISTS idx_price_reprice_items_run ON price_reprice_items (run_id);
