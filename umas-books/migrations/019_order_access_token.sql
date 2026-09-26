-- GET /cart/return looked orders up by their raw sequential id, so
-- anyone could page through every order ever placed (name, email,
-- items, total) just by incrementing ?order=. Give every order an
-- unguessable token to look it up by instead — gen_random_uuid() as
-- the column default backfills a distinct random value per existing
-- row (a table rewrite, since it's a volatile default), not the same
-- value copied everywhere.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS access_token UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_access_token ON orders(access_token);
