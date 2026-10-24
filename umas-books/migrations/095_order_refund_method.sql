-- How a reservation refund was paid out (Review C, C-M2). Refunds are made by a
-- person in the shop; "Mark refunded" now records HOW, so a refund paid in cash
-- from the till drawer lowers that day's EXPECTED cash (otherwise the closing
-- count shows the drawer short and the accounting export also carries a
-- "Cash short" row: the same money twice).
--   refund_method    cash (from the till drawer) | card | transfer | other.
--                    NULL = not recorded (every refund made before this change):
--                    those behave exactly as before.
--   refund_till_day  the Paris day whose drawer paid it (only for cash refunds
--                    made while the till day was not closed); NULL otherwise.
-- Nullable columns without defaults: no table rewrite, safe on a live database.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_method TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_till_day DATE;
DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_refund_method_check
    CHECK (refund_method IS NULL OR refund_method IN ('cash', 'card', 'transfer', 'other')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE orders VALIDATE CONSTRAINT orders_refund_method_check;
-- A drawer day only makes sense for a cash refund.
DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_refund_till_day_check
    CHECK (refund_till_day IS NULL OR refund_method = 'cash') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE orders VALIDATE CONSTRAINT orders_refund_till_day_check;
CREATE INDEX IF NOT EXISTS idx_orders_refund_till_day ON orders (refund_till_day) WHERE refund_till_day IS NOT NULL;
