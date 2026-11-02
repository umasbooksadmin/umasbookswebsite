-- Educational items (worksheets, flash cards...): a second thing the shop sells online, next to books. Owner-approved
-- 2026-11-02. They are NEW goods (never second-hand), have a picture, a name, a price and a STOCK quantity. Customers
-- RESERVE them online through the same cart as books and pay at the shop when they collect (lib/cart.js). A reserved
-- unit is HELD: the units held are the educational order lines of the open ('reserved') reservations, so a reservation
-- that is cancelled or expires gives its units back by itself (lib/eduItems.js HELD_SQL).
--
-- 1. edu_genres: the Browse Educational Items genre buttons (Admin > Educational items). Names are English only, on the
--    French site too (like book genres). slug is the stable ?genre= value; colour / icon are keys of lib/browseGenres.js
--    PALETTE / ICONS (the same tiles as Browse Books).
CREATE TABLE IF NOT EXISTS edu_genres (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  slug        TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  colour      TEXT,
  icon        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS edu_genres_name_key ON edu_genres (lower(btrim(name)));

-- 2. edu_items: one row per item for sale. price > 0 (a 0 price could never be charged); stock = the units physically in
--    the shop, held ones included (collecting a reservation takes the collected units off it, a refund puts them back);
--    what can still be reserved is stock minus the held units. is_hidden = not shown and not
--    reservable (an item that is on past orders can only be hidden, never deleted: see 3). A genre with items cannot be
--    deleted (RESTRICT). image_url is a /img/<sha256>.jpg from lib/imageStore.js (lib/imageCleanup.js counts it as used).
CREATE TABLE IF NOT EXISTS edu_items (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  price       NUMERIC(10,2) NOT NULL CHECK (price > 0 AND price <= 10000),
  stock       INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0 AND stock <= 100000),
  genre_id    INTEGER REFERENCES edu_genres(id) ON DELETE RESTRICT,
  image_url   TEXT,
  is_hidden   BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS edu_items_genre_idx ON edu_items (genre_id);

-- 3. An order line can now be an educational item: order_items.edu_item_id. ONE ROW PER UNIT (a quantity of 3 is three
--    rows at the unit price), exactly like drop-in seats, so every existing sum over order_items.price, the partial pickup
--    and the till stay per-line. item_title and price keep the SNAPSHOT of the name and price at reservation time. The
--    foreign key has no ON DELETE: an item on any order cannot be deleted (the admin hides it instead).
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS edu_item_id INTEGER REFERENCES edu_items(id);
CREATE INDEX IF NOT EXISTS idx_order_items_edu_item ON order_items (edu_item_id) WHERE edu_item_id IS NOT NULL;
-- Exactly one of book / seat / educational item (was: exactly one of book / seat, migration 015). Every existing row has
-- edu_item_id NULL and one of the other two, so it still passes. NOT VALID + VALIDATE: no long lock while the old version serves.
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_one_item_type;
ALTER TABLE order_items ADD CONSTRAINT order_items_one_item_type CHECK (
  num_nonnulls(book_copy_id, class_dropin_seat_id, edu_item_id) = 1
) NOT VALID;
ALTER TABLE order_items VALIDATE CONSTRAINT order_items_one_item_type;

-- 4. The till line category 'educational' (a reserved educational item collected at the till), exported as
--    "Educational items" (lib/accounting.js). Same pattern as migration 105: the CHECK is found by what it checks.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname FROM pg_constraint con
    WHERE con.conrelid = 'till_sale_items'::regclass AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%category%' AND pg_get_constraintdef(con.oid) LIKE '%books_other%'
  LOOP
    EXECUTE format('ALTER TABLE till_sale_items DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE till_sale_items ADD CONSTRAINT till_sale_items_category_check
  CHECK (category IN ('books_used', 'books_new', 'books_other', 'merchandise', 'refreshments', 'donation', 'other', 'class_seats', 'educational')) NOT VALID;
ALTER TABLE till_sale_items VALIDATE CONSTRAINT till_sale_items_category_check;

-- 5. The two genres the owner asked for. More are added in Admin > Educational items.
INSERT INTO edu_genres (name, slug, sort_order, colour, icon) VALUES
  ('Worksheets', 'worksheets', 1, 'sage', 'leaf-quill'),
  ('Flash Cards', 'flash-cards', 2, 'apricot', 'star')
ON CONFLICT (slug) DO NOTHING;

-- Undo (only while no order has an educational line; check SELECT count(*) FROM order_items WHERE edu_item_id IS NOT NULL):
--   ALTER TABLE order_items DROP CONSTRAINT order_items_one_item_type;
--   ALTER TABLE order_items ADD CONSTRAINT order_items_one_item_type CHECK ((book_copy_id IS NOT NULL AND class_dropin_seat_id IS NULL) OR (book_copy_id IS NULL AND class_dropin_seat_id IS NOT NULL));
--   DROP INDEX idx_order_items_edu_item; ALTER TABLE order_items DROP COLUMN edu_item_id;
--   ALTER TABLE till_sale_items DROP CONSTRAINT till_sale_items_category_check;
--   ALTER TABLE till_sale_items ADD CONSTRAINT till_sale_items_category_check CHECK (category IN ('books_used', 'books_new', 'books_other', 'merchandise', 'refreshments', 'donation', 'other', 'class_seats'));
--   DROP TABLE edu_items; DROP TABLE edu_genres;
