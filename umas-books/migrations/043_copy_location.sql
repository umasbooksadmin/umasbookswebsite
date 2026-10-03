-- Where a physical copy sits in the shop (free-text code such as 'FICTION-A1',
-- normalised by normalizeLocation in src/lib/inventory.js). NULL = not placed yet.
ALTER TABLE book_copies ADD COLUMN IF NOT EXISTS location TEXT;
CREATE INDEX IF NOT EXISTS idx_book_copies_location ON book_copies (location) WHERE location IS NOT NULL;
