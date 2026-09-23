-- Online checkout via HelloAsso, separate from the existing in-person
-- "reserve and pay in shop" flow (book_copies.status = 'reserved'). A
-- cart holds copies with status = 'in_cart' only once checkout actually
-- starts (not on mere "add to cart" — see src/lib/cart.js), and the
-- webhook/return-URL reconciliation flips them straight to 'sold' since
-- payment is already settled online, no pickup hold needed.

CREATE TABLE IF NOT EXISTS orders (
  id                  SERIAL PRIMARY KEY,
  buyer_name          TEXT NOT NULL,
  buyer_email         TEXT NOT NULL,
  buyer_phone         TEXT,
  status              TEXT NOT NULL DEFAULT 'pending', -- pending, paid, cancelled, expired
  total_amount        NUMERIC(10,2) NOT NULL,
  checkout_intent_id  TEXT,
  helloasso_order_id  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at             TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_orders_checkout_intent ON orders(checkout_intent_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS order_items (
  id           SERIAL PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  book_copy_id INTEGER NOT NULL REFERENCES book_copies(id),
  book_title   TEXT NOT NULL,
  price        NUMERIC(10,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

ALTER TABLE book_copies ADD COLUMN IF NOT EXISTS cart_order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL;
ALTER TABLE book_copies ADD COLUMN IF NOT EXISTS cart_added_at TIMESTAMPTZ;
