-- The till (/admin/till): in-person sales with a barcode scanner, cash or card,
-- an end-of-day count and an accounting export.
--
-- till_sales: one row per sale at the till (one payment method per sale).
-- sale_token is a random value made when the sale screen opens: a double click
-- or a retry of "Confirm" carries the same token and so never makes a second
-- sale. Nothing about the customer is stored.
CREATE TABLE IF NOT EXISTS till_quick_items (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  price_cents  INTEGER NOT NULL CHECK (price_cents > 0 AND price_cents <= 1000000),
  category     TEXT NOT NULL CHECK (category IN ('books_other', 'merchandise', 'refreshments', 'donation', 'other')),
  active       BOOLEAN NOT NULL DEFAULT true,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  stock        INTEGER CHECK (stock IS NULL OR stock >= 0), -- NULL = not counted
  barcode      TEXT CHECK (barcode IS NULL OR barcode = upper(barcode)), -- manufacturer EAN/UPC or the shop's own code; stored upper-case
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A barcode belongs to one ACTIVE quick item.
CREATE UNIQUE INDEX IF NOT EXISTS uq_till_quick_items_barcode ON till_quick_items (barcode) WHERE active AND barcode IS NOT NULL;

CREATE TABLE IF NOT EXISTS till_sales (
  id                  SERIAL PRIMARY KEY,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  staff_user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  payment_method      TEXT NOT NULL CHECK (payment_method IN ('cash', 'card')),
  total_cents         INTEGER NOT NULL CHECK (total_cents >= 0),
  cash_received_cents INTEGER CHECK (cash_received_cents IS NULL OR cash_received_cents >= 0),
  change_given_cents  INTEGER CHECK (change_given_cents IS NULL OR change_given_cents >= 0),
  card_reference      TEXT,
  sale_token          TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'voided')),
  voided_at           TIMESTAMPTZ,
  void_reason         TEXT,
  voided_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  adjusted_time       BOOLEAN NOT NULL DEFAULT false -- "sold at" was set earlier today (e.g. internet was down)
);
CREATE INDEX IF NOT EXISTS idx_till_sales_created ON till_sales (created_at);

-- One row per line of a sale: a book copy, a manual item or a quick item.
CREATE TABLE IF NOT EXISTS till_sale_items (
  id                   SERIAL PRIMARY KEY,
  sale_id              INTEGER NOT NULL REFERENCES till_sales(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL CHECK (kind IN ('book', 'manual', 'quick')),
  copy_id              INTEGER REFERENCES book_copies(id),
  quick_item_id        INTEGER REFERENCES till_quick_items(id) ON DELETE SET NULL,
  description          TEXT NOT NULL,
  quantity             INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 999),
  unit_price_cents     INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  category             TEXT NOT NULL CHECK (category IN ('books_used', 'books_new', 'books_other', 'merchandise', 'refreshments', 'donation', 'other')),
  original_price_cents INTEGER, -- the asking price when it was overridden at the till
  override_reason      TEXT
);
CREATE INDEX IF NOT EXISTS idx_till_sale_items_sale ON till_sale_items (sale_id);
CREATE INDEX IF NOT EXISTS idx_till_sale_items_copy ON till_sale_items (copy_id) WHERE copy_id IS NOT NULL;

-- The existing shop-sales rows (one per book copy) are reused for books sold at
-- the till, so the Reports pages keep counting a shop sale exactly once.
-- A voided sale deletes its shop_sales rows (the till_sale_items rows stay as history).
ALTER TABLE shop_sales ADD COLUMN IF NOT EXISTS till_sale_id INTEGER REFERENCES till_sales(id);
CREATE INDEX IF NOT EXISTS idx_shop_sales_till_sale ON shop_sales (till_sale_id) WHERE till_sale_id IS NOT NULL;

ALTER TABLE book_copies ADD COLUMN IF NOT EXISTS sold_at TIMESTAMPTZ;
ALTER TABLE book_copies ADD COLUMN IF NOT EXISTS sold_via TEXT; -- 'till', 'shop' (Sell in shop) or NULL (online / unknown)

-- One row per Paris day that was opened and/or closed at the till.
CREATE TABLE IF NOT EXISTS till_days (
  day                 DATE PRIMARY KEY,
  opening_float_cents INTEGER NOT NULL CHECK (opening_float_cents >= 0),
  opened_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  opened_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  counted_cash_cents  INTEGER CHECK (counted_cash_cents IS NULL OR counted_cash_cents >= 0),
  expected_cash_cents INTEGER,
  difference_cents    INTEGER,
  closed_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  closed_at           TIMESTAMPTZ,
  note                TEXT
);
