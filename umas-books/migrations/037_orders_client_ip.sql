-- The buyer's IP address at checkout, so the server can cap how many
-- unpaid ("pending") orders one connection can hold open at once — each
-- pending order locks its copies for an hour (see routes/cart.js).
-- Nullable: orders created before this have none.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_ip TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_pending_client_ip ON orders(client_ip) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_orders_pending_buyer_email ON orders(lower(buyer_email)) WHERE status = 'pending';
