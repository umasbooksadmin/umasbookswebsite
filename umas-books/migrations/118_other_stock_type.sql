-- Other stock (Admin > Other stock, table till_quick_items): a free-text TYPE for each item (Tote bags, Bookmarks, Postcards),
-- chosen in a combo box that lists the types already used and accepts a new one (typed text matching an existing type
-- without regard to case or spacing reuses that type's spelling). It is NOT the accounting category (the `category` column,
-- which drives the accounting export and the till reports): the two are independent.
--
-- NULL = no type (every item that exists today). Stored trimmed; at most 60 characters.
ALTER TABLE till_quick_items ADD COLUMN IF NOT EXISTS item_type TEXT;
ALTER TABLE till_quick_items DROP CONSTRAINT IF EXISTS till_quick_items_item_type_check;
ALTER TABLE till_quick_items ADD CONSTRAINT till_quick_items_item_type_check
  CHECK (item_type IS NULL OR (item_type = btrim(item_type) AND char_length(item_type) BETWEEN 1 AND 60));

-- Undo (loses the types only):
--   ALTER TABLE till_quick_items DROP COLUMN IF EXISTS item_type;
