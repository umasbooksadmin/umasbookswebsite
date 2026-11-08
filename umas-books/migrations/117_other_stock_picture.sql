-- Other stock (not books, Admin > Other stock, table till_quick_items): a PICTURE for each item, managed with the same Picture
-- card as an educational item (add / replace / rotate / crop / remove).
--
-- image_url holds the stored picture's address (lib/imageStore.js, a hash-named .jpg), exactly like edu_items.image_url. NULL = no picture (every item that
-- exists today). The unused-image cleanup (lib/imageCleanup.js IMAGE_REFERENCES) knows this column. updated_at is new too, so the
-- picture and form saves can say when an item last changed (older rows get the migration time).
ALTER TABLE till_quick_items ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE till_quick_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- The Position of these items (sort_order) is no longer shown or used: the till buttons and the list are alphabetical. The
-- column stays (nothing is lost; the undo of that is simply to sort by it again).
--
-- Undo (loses every picture link; the images themselves stay in `images` until the cleanup):
--   ALTER TABLE till_quick_items DROP COLUMN IF EXISTS image_url;
--   ALTER TABLE till_quick_items DROP COLUMN IF EXISTS updated_at;
