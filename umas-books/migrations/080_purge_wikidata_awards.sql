-- The first Wikidata lookup matched ISBNs only in plain-digit form and, when
-- an edition matched, joined against EVERY award in Wikidata. Rows it stored
-- (Grammys, Golden Globes, ...) were shown to customers as 'verified'.
-- Delete everything it stored and mark the books as never checked so the
-- fixed lookup runs again (the background job picks up awards_checked_at
-- IS NULL, newest first). Admin-typed ('manual') and NYT rows are untouched.
DELETE FROM book_awards WHERE source = 'wikidata';
UPDATE books SET awards_checked_at = NULL, awards_check_state = NULL;
