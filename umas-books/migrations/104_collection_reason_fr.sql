-- The French version of the AI's one-line "why this book" for a curated collection (curated_collection_books.reason,
-- English). The customer collection page shows the reason under each book; on /fr/ it shows reason_fr and NEVER the
-- English (no French yet: the line is hidden). New suggestions get both from the same AI answer
-- (lib/collectionSuggestions.js); older ones are filled by the admin's "Translate reasons to French" button
-- (lib/collectionReasonTranslate.js). NULL = not translated yet.
ALTER TABLE curated_collection_books ADD COLUMN IF NOT EXISTS reason_fr TEXT;
