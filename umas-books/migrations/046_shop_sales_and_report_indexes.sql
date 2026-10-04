-- Books sold over the counter in the shop ("Sell in shop", /admin/inventory/sell).
-- Online sales live in orders/order_items; this is the in-shop equivalent, so
-- the Reports pages can add the two together. One row per copy sold; the copy
-- itself is set to status 'sold' in the same transaction. sold_by keeps only
-- the admin's user id (no buyer details are ever stored).
CREATE TABLE IF NOT EXISTS shop_sales (
  id             SERIAL PRIMARY KEY,
  copy_id        INTEGER NOT NULL REFERENCES book_copies(id),
  price          NUMERIC(10,2) NOT NULL,
  sold_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  sold_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  payment_method TEXT CHECK (payment_method IN ('cash', 'card', 'other'))
);
CREATE INDEX IF NOT EXISTS idx_shop_sales_sold_at ON shop_sales (sold_at);
CREATE INDEX IF NOT EXISTS idx_shop_sales_copy ON shop_sales (copy_id);

-- Indexes the Reports pages lean on (inventory/aging by status, intake by
-- date, sales by paid date, sell-through joins from a copy to its order).
CREATE INDEX IF NOT EXISTS idx_book_copies_status_created ON book_copies (status, created_at);
CREATE INDEX IF NOT EXISTS idx_book_copies_created ON book_copies (created_at);
CREATE INDEX IF NOT EXISTS idx_orders_paid_at ON orders (paid_at) WHERE status = 'paid';
CREATE INDEX IF NOT EXISTS idx_order_items_book_copy ON order_items (book_copy_id) WHERE book_copy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_membership_payments_paid_at ON membership_payments (paid_at);
