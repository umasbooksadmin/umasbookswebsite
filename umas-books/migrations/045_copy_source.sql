-- Where a copy came from, chosen at intake: a donation, something the shop
-- bought, part of a job lot (a box or collection bought together), or other.
-- NULL = unknown (every copy added before this change). Used by the Reports
-- pages (inventory by source, intake log).
ALTER TABLE book_copies ADD COLUMN IF NOT EXISTS source TEXT
  CHECK (source IN ('donation', 'purchase', 'lot', 'other'));
