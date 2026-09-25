-- Paid drop-in session seats, sold through the same cart/checkout as
-- books (see src/routes/cart.js). A class only shows a price/seats/Add
-- to Cart on the public /sessions calendar once dropin_price is set —
-- left NULL, it's just an informational entry (matches /immersion/calendar).
--
-- A class_dropin_seats row is created only once checkout actually
-- starts (mirrors book_copies going to 'in_cart' — see 013_orders.sql),
-- except a seat doesn't pre-exist: there's nothing to "return to stock"
-- if payment fails, so an unpaid hold is deleted outright rather than
-- reset like a book copy.

ALTER TABLE classes ADD COLUMN IF NOT EXISTS dropin_price NUMERIC(10,2);

CREATE TABLE IF NOT EXISTS class_dropin_seats (
  id            SERIAL PRIMARY KEY,
  class_id      INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'in_cart', -- in_cart, sold
  order_id      INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  cart_added_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_class_dropin_seats_class ON class_dropin_seats(class_id);
CREATE INDEX IF NOT EXISTS idx_class_dropin_seats_order ON class_dropin_seats(order_id);
CREATE INDEX IF NOT EXISTS idx_class_dropin_seats_status ON class_dropin_seats(status);

-- Generalize order_items so one order can mix books and drop-in seats.
-- Every migration file re-runs on every deploy (see src/migrate.js), so
-- the rename below is guarded — a plain RENAME COLUMN would fail on the
-- second deploy once book_title no longer exists.
ALTER TABLE order_items ALTER COLUMN book_copy_id DROP NOT NULL;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS class_dropin_seat_id INTEGER REFERENCES class_dropin_seats(id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'order_items' AND column_name = 'book_title'
  ) THEN
    ALTER TABLE order_items RENAME COLUMN book_title TO item_title;
  END IF;
END $$;

ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_one_item_type;
ALTER TABLE order_items ADD CONSTRAINT order_items_one_item_type CHECK (
  (book_copy_id IS NOT NULL AND class_dropin_seat_id IS NULL) OR
  (book_copy_id IS NULL AND class_dropin_seat_id IS NOT NULL)
);
