-- Educational items: what the shop PAID for one unit (owner request 2026-11-02, "do all 3": record it, show the margin
-- in the Sales report, and give the treasurer the cost of the items sold). Admin-only: never on a customer page, the
-- public JSON, an email, the sitemap or the member data export (those read named columns, never these two).
--
-- 1. edu_items.cost: the cost per unit in euros, typed in Admin > Educational items ("Cost per unit (what we paid)").
--    NULL = not known (every item that exists today). 0 is allowed (a free sample, a gift). Same bound as the price.
ALTER TABLE edu_items ADD COLUMN IF NOT EXISTS cost NUMERIC(10,2);
ALTER TABLE edu_items DROP CONSTRAINT IF EXISTS edu_items_cost_check;
ALTER TABLE edu_items ADD CONSTRAINT edu_items_cost_check CHECK (cost IS NULL OR (cost >= 0 AND cost <= 10000));

-- 2. order_items.unit_cost: the SNAPSHOT of edu_items.cost when the unit was reserved (lib/cart.js), exactly like
--    item_title and price. A later change of the item's cost never changes a past sale's cost or margin. NULL = the
--    cost was not known at reservation time (every order line that exists today, and every book or seat line: books
--    keep their own book_copies.acquisition_cost, seats have no cost). Only educational lines ever get one.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(10,2);
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_unit_cost_check;
ALTER TABLE order_items ADD CONSTRAINT order_items_unit_cost_check CHECK (unit_cost IS NULL OR (unit_cost >= 0 AND edu_item_id IS NOT NULL)) NOT VALID;
-- Every existing row has unit_cost NULL, so it passes. NOT VALID + VALIDATE: no long lock while the old version serves.
ALTER TABLE order_items VALIDATE CONSTRAINT order_items_unit_cost_check;

-- Undo (loses every cost typed and every cost snapshot; the sales themselves are untouched):
--   ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_unit_cost_check; ALTER TABLE order_items DROP COLUMN IF EXISTS unit_cost;
--   ALTER TABLE edu_items DROP CONSTRAINT IF EXISTS edu_items_cost_check; ALTER TABLE edu_items DROP COLUMN IF EXISTS cost;
