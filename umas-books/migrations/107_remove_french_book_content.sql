-- Books have no French description and no French genre any more (Sharon, 2026-10-28). The French site shows the
-- English description and the English genres of a book; nothing writes books.description_fr / books.categories_fr
-- (the code that did is removed in the same change). The columns stay (not dropped) but are emptied here.
-- Collections, blog posts, events, classes and every other table keep their French: only BOOKS are changed.
--
-- Safety net, in this order, inside the one transaction the migration runner gives every file:
--   1. every non-empty French value is COPIED into book_french_backup (one row per book, ON CONFLICT DO NOTHING:
--      a value already saved is never overwritten);
--   2. only then are the two book columns set to NULL;
--   3. one line in Admin activity (admin_audit_log, action books.french_removed) says how many books were changed
--      (also when that is 0, the first time, so the deploy always leaves its line).
-- Idempotent: a second run finds nothing to copy and nothing to empty, and writes no second Admin activity line.
-- Restore recipe and when the table can be dropped: docs/runbook.md, "French book descriptions and genres (removed)".

CREATE TABLE IF NOT EXISTS book_french_backup (
  book_id        INT PRIMARY KEY REFERENCES books (id) ON DELETE CASCADE,
  description_fr TEXT,
  categories_fr  TEXT,
  saved_at       TIMESTAMPTZ DEFAULT now()
);

INSERT INTO book_french_backup (book_id, description_fr, categories_fr)
SELECT id, description_fr, categories_fr
FROM books
WHERE description_fr IS NOT NULL OR categories_fr IS NOT NULL
ON CONFLICT DO NOTHING;

WITH emptied AS (
  UPDATE books
     SET description_fr = NULL, categories_fr = NULL
   WHERE description_fr IS NOT NULL OR categories_fr IS NOT NULL
  RETURNING id
)
INSERT INTO admin_audit_log (actor_label, action, target_type, detail)
SELECT 'migration 107', 'books.french_removed', 'book',
       'French book descriptions and genres removed: ' || count(*) || ' book' || CASE WHEN count(*) = 1 THEN '' ELSE 's' END
       || '. A copy is kept in table book_french_backup.'
FROM emptied
HAVING count(*) > 0
    OR NOT EXISTS (SELECT 1 FROM admin_audit_log WHERE action = 'books.french_removed');
