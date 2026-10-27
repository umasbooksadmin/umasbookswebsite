-- Drop-in class seats collected AT THE TILL get their own till line category, 'class_seats', so the
-- accounting export puts them under "Class seats" (706), exactly like a seat collected with the admin
-- "Mark collected and paid" button. Before this, a seat line at the till was written as category 'other'
-- and exported as "Other" (708); a refund reversed it under "Other" too.
--
-- 1. Widen the CHECK on till_sale_items.category (migration 065) to accept 'class_seats'. The constraint
--    is found by what it checks, not by its generated name, so this is safe whatever it is called, and
--    it is re-added under the usual name; running the file twice drops and re-adds the same CHECK.
--    NOT VALID + VALIDATE: no long ACCESS EXCLUSIVE scan while the old version still serves.
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
  CHECK (category IN ('books_used', 'books_new', 'books_other', 'merchandise', 'refreshments', 'donation', 'other', 'class_seats')) NOT VALID;
ALTER TABLE till_sale_items VALIDATE CONSTRAINT till_sale_items_category_check;

-- 2. Backfill the seat lines already written as 'other'. A till line of a collected reservation
--    (reservation_order_id set) is either a book (copy_id set) or a drop-in seat (no copy): the till
--    builds reservation lines only from items held for the order, and only books and seats can be
--    held (lib/tillReservations.js). So "reservation line, no copy, written as a manual 'other' line,
--    and that order has a seat item" identifies exactly the seat lines; a manual or quick "Other" item
--    typed at the till has no reservation_order_id and is never touched. Only the category changes
--    (the amount, method and day stay), so each day's and each month's export total is unchanged:
--    the amount moves from "Other" (708) to "Class seats" (706). Re-running changes nothing.
UPDATE till_sale_items i SET category = 'class_seats'
WHERE i.reservation_order_id IS NOT NULL AND i.copy_id IS NULL AND i.kind = 'manual' AND i.category = 'other'
  AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = i.reservation_order_id AND oi.class_dropin_seat_id IS NOT NULL);
