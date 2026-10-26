-- "Remove cover" in the admin (routes/admin/inventoryCover.js). A book with no cover is normally topped up
-- automatically: saving its details looks one up (lib/bookFill.js findCoverUrl), scanning another copy fills the gaps,
-- and the background job downloads cover_source_url. When an admin removed the cover ON PURPOSE, none of that may
-- bring it back, so the removal is remembered here.
--   cover_removed_at   when the cover was removed by hand; NULL otherwise. Cleared when a cover is set again
--                      (a photo, a typed cover address, a replacement). Nullable, no default: adds no row rewrite.
ALTER TABLE books ADD COLUMN IF NOT EXISTS cover_removed_at TIMESTAMPTZ;
