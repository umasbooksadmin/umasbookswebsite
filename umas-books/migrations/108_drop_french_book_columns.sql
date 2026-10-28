-- Drop the French book columns (Sharon, 2026-10-28: "go ahead and remove the French columns"). Step 2 of 2:
-- migration 107 (and the code change with it) stopped every read and write of them, copied their values into
-- book_french_backup and set them to NULL. Dropped here, and nothing else:
--   books.description_fr, books.categories_fr, managed_genres.name_fr, managed_genres.browse_label_fr
-- NOT dropped: book_french_backup (the undo, kept until Sharon says otherwise) and every other table's French
-- columns (collections, blog posts, events, classes, announcements, charities, ...).
--
-- Safety net, in this order, inside the one transaction the migration runner gives every file:
--   1. any French value still in books.description_fr / categories_fr that book_french_backup does not hold is
--      COPIED there first (a missing row is added, ON CONFLICT DO NOTHING; an empty field of an existing row is
--      filled). A saved value is never overwritten.
--   2. a check: every non-NULL value in the two columns must now equal the saved one. If any differs (a backup row
--      already holds a DIFFERENT value for that book), the migration stops with an error, nothing is dropped and the
--      deploy fails while the current version keeps serving. A column holding an unsaved value is never dropped.
--   3. the columns are dropped (IF EXISTS, no CASCADE: if anything depended on them the drop would fail loudly;
--      nothing does: no index, constraint, view or trigger uses them).
--   4. one line in Admin activity (admin_audit_log, action books.french_columns_dropped), written once.
-- Idempotent: a second run finds no column, copies nothing, drops nothing, and writes no second line.
-- Restore recipe: docs/runbook.md, "French book descriptions and genres (removed)".

DO $$
DECLARE
  has_desc BOOLEAN;
  has_cats BOOLEAN;
  rescued  INT := 0;
  n        INT;
  unsaved  INT;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'books' AND column_name = 'description_fr'),
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = 'books' AND column_name = 'categories_fr')
    INTO has_desc, has_cats;
  IF NOT has_desc AND NOT has_cats THEN
    RETURN; -- already dropped
  END IF;

  -- 1. Rescue. Dynamic SQL: on a partly dropped table only the column that is still there is named.
  EXECUTE format(
    'INSERT INTO book_french_backup (book_id, description_fr, categories_fr)
     SELECT b.id, %s, %s FROM books b
      WHERE (%s OR %s)
        AND NOT EXISTS (SELECT 1 FROM book_french_backup k WHERE k.book_id = b.id)
     ON CONFLICT DO NOTHING',
    CASE WHEN has_desc THEN 'b.description_fr' ELSE 'NULL' END,
    CASE WHEN has_cats THEN 'b.categories_fr' ELSE 'NULL' END,
    CASE WHEN has_desc THEN 'b.description_fr IS NOT NULL' ELSE 'FALSE' END,
    CASE WHEN has_cats THEN 'b.categories_fr IS NOT NULL' ELSE 'FALSE' END);
  GET DIAGNOSTICS n = ROW_COUNT;
  rescued := rescued + n;
  IF has_desc THEN
    UPDATE book_french_backup k SET description_fr = b.description_fr
      FROM books b WHERE b.id = k.book_id AND k.description_fr IS NULL AND b.description_fr IS NOT NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    rescued := rescued + n;
  END IF;
  IF has_cats THEN
    UPDATE book_french_backup k SET categories_fr = b.categories_fr
      FROM books b WHERE b.id = k.book_id AND k.categories_fr IS NULL AND b.categories_fr IS NOT NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    rescued := rescued + n;
  END IF;
  IF rescued > 0 THEN
    RAISE NOTICE 'migration 108: % French book value(s) were not in book_french_backup and were copied there first', rescued;
  END IF;

  -- 2. Check: nothing that is about to be dropped is unsaved.
  EXECUTE format(
    'SELECT count(*) FROM books b LEFT JOIN book_french_backup k ON k.book_id = b.id
      WHERE %s OR %s',
    CASE WHEN has_desc THEN '(b.description_fr IS NOT NULL AND b.description_fr IS DISTINCT FROM k.description_fr)' ELSE 'FALSE' END,
    CASE WHEN has_cats THEN '(b.categories_fr IS NOT NULL AND b.categories_fr IS DISTINCT FROM k.categories_fr)' ELSE 'FALSE' END)
    INTO unsaved;
  IF unsaved > 0 THEN
    RAISE EXCEPTION 'migration 108 stopped, nothing dropped: % book(s) hold a French value in books.description_fr / categories_fr that differs from the one saved in book_french_backup. Compare them (docs/runbook.md, "French book descriptions and genres (removed)") before deploying again.', unsaved;
  END IF;
END $$;

-- 3. Drop.
ALTER TABLE books DROP COLUMN IF EXISTS description_fr, DROP COLUMN IF EXISTS categories_fr;
ALTER TABLE managed_genres DROP COLUMN IF EXISTS name_fr, DROP COLUMN IF EXISTS browse_label_fr;

-- 4. One Admin activity line, once.
INSERT INTO admin_audit_log (actor_label, action, target_type, detail)
SELECT 'migration 108', 'books.french_columns_dropped', 'book',
       'French book columns dropped (books.description_fr, books.categories_fr, managed_genres name_fr / browse_label_fr). '
       || 'Book text, copies and prices are untouched. The old French values are kept in table book_french_backup.'
WHERE NOT EXISTS (SELECT 1 FROM admin_audit_log WHERE action = 'books.french_columns_dropped');
