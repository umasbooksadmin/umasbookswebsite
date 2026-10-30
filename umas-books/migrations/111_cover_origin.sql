-- How a book's cover was chosen, so the owner can review covers that may belong to another edition (Admin > Reports >
-- Covers to check). Until now nothing recorded it: cover_source_url keeps the address a cover was downloaded from, but a
-- numbered picture (covers.openlibrary.org/b/id/N) may have come from the ISBN's own catalog record or from the old
-- title/author search, and a replaced cover keeps its old source address.
--   cover_origin      'isbn'  found for the book's exact ISBN (catalog record or covers.openlibrary.org/b/isbn/<isbn13>)
--                     'photo' the owner's own photo
--                     'form'  an address that came with the form (the scan preview, or typed by hand)
--                     NULL    saved before this column existed: unknown (these are the ones listed for review)
--   cover_checked_at  when an admin confirmed the cover is the right one; NULL otherwise. Reset when a cover is set again.
-- Both columns are nullable with no default (no row rewrite) and nothing existing is changed or removed: undo is
-- ALTER TABLE books DROP COLUMN cover_origin, DROP COLUMN cover_checked_at (only the review list stops working).
ALTER TABLE books ADD COLUMN IF NOT EXISTS cover_origin TEXT;
ALTER TABLE books ADD COLUMN IF NOT EXISTS cover_checked_at TIMESTAMPTZ;
