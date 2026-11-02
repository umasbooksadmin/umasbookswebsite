-- Educational items: the BARCODE printed on the item (owner-approved 2026-11-02), so the admin can scan an item to find
-- it, and look up its name when adding it (Admin > Educational items). Admin-only: never on a customer page, the public
-- JSON, an email or the sitemap (those read named columns, never this one).
--
-- 1. edu_items.barcode: digits only, EAN-8 / UPC-A / EAN-13 / GTIN-14 (8, 12, 13 or 14 digits). An ISBN-10 typed in is
--    stored as its ISBN-13 (lib/barcode.js parseBarcode, which also checks the check digit). NULL = no barcode (every item
--    that exists today).
ALTER TABLE edu_items ADD COLUMN IF NOT EXISTS barcode TEXT;
ALTER TABLE edu_items DROP CONSTRAINT IF EXISTS edu_items_barcode_check;
ALTER TABLE edu_items ADD CONSTRAINT edu_items_barcode_check CHECK (barcode IS NULL OR barcode ~ '^([0-9]{8}|[0-9]{12,14})$');

-- 2. One item per barcode. Two codes are the same product when they are equal padded to 14 digits (a UPC-A
--    012345678905 is the EAN-13 0012345678905): the index is on that padded form (lib/barcode.js gtinKey), and only for
--    items that have a barcode.
CREATE UNIQUE INDEX IF NOT EXISTS edu_items_barcode_key ON edu_items (lpad(barcode, 14, '0')) WHERE barcode IS NOT NULL;

-- Undo (loses every barcode typed; nothing else changes):
--   DROP INDEX IF EXISTS edu_items_barcode_key;
--   ALTER TABLE edu_items DROP CONSTRAINT IF EXISTS edu_items_barcode_check;
--   ALTER TABLE edu_items DROP COLUMN IF EXISTS barcode;
