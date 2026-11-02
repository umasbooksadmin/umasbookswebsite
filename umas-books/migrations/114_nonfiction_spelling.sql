-- "Nonfiction" is one word (Sharon, 2026-11-02). The genre was spelled "Non-fiction" (any capitals, a hyphen or a space)
-- in the data; this moves the data to "Nonfiction" so that no book is cut off from its genre by the new spelling.
-- MUST MERGE AFTER migration 113 (open PR #391 "Educational items"): the numbering test fails on a gap.
--
-- What it changes (and nothing else):
--   1. managed_genres (Admin > Genres): the genre named Non-fiction / Non-Fiction / non fiction is renamed Nonfiction, and
--      its Browse button label "Non-Fiction" becomes "Nonfiction" (a label the admin typed herself is left alone). The
--      slug (nonfiction), the search words (nonfiction,non-fiction,history,...), colour and icon stay. Skipped when a
--      managed genre called Nonfiction already exists (two rows may not share a name).
--   2. books.categories (comma-separated genre names, matched exactly against the managed names): every element that
--      equals non-fiction in any capitals / hyphen / space variant ("Non-fiction", "non fiction", "NONFICTION") becomes
--      "Nonfiction". The other elements and the order are kept; a duplicate Nonfiction in one book is dropped. A book is
--      written only when one of its nonfiction elements really changes (or is doubled); only books.categories changes
--      (not updated_at, no copy, no price). Nothing is deleted.
--   3. genre_rules: an EXACT rule whose pattern is a nonfiction variant gets the pattern Nonfiction (skipped when an exact
--      Nonfiction rule exists). Word rules are not touched. The history of past Update-all runs (genre_runs,
--      genre_run_changes, book_genre_cleanup_backup, book_french_backup) is a record of what was, and is NOT rewritten.
--   Free text (book descriptions, blog posts, announcements) is NOT touched: see "Non-fiction in free text" in
--   docs/runbook.md for a read-only count.
--
-- Safety net, in this order, inside the one transaction the migration runner gives every file:
--   1. the old categories of every book about to change are COPIED into categories_nonfiction_backup (one row per book,
--      ON CONFLICT DO NOTHING: a value already saved is never overwritten); the old name / label / rule pattern go to
--      nonfiction_rename_backup (on_table, row_id, on_column, value_before);
--   2. only then are the rows updated;
--   3. one line in Admin activity (admin_audit_log, action books.nonfiction_spelling), also when it is 0 the first time.
-- Idempotent: a second run finds nothing to change, writes nothing and adds no second Admin activity line.
--
-- UNDO (run by hand in Render Shell / psql, in one transaction; the matching code change must be rolled back too):
--   UPDATE books b SET categories = k.categories_before FROM categories_nonfiction_backup k WHERE k.book_id = b.id;
--   UPDATE managed_genres g SET name_en = k.value_before FROM nonfiction_rename_backup k
--     WHERE k.on_table = 'managed_genres' AND k.on_column = 'name_en' AND k.row_id = g.id;
--   UPDATE managed_genres g SET browse_label_en = k.value_before FROM nonfiction_rename_backup k
--     WHERE k.on_table = 'managed_genres' AND k.on_column = 'browse_label_en' AND k.row_id = g.id;
--   UPDATE genre_rules r SET pattern = k.value_before, pattern_key = lower(k.value_before) FROM nonfiction_rename_backup k
--     WHERE k.on_table = 'genre_rules' AND k.on_column = 'pattern' AND k.row_id = r.id;
-- (A book that was edited since the migration would get its old value back: check that first.)
-- The variant spelling below equals NONFICTION_VARIANT_RE of src/lib/genreClean.js (test/integration/nonfictionMigration.test.js).

CREATE TABLE IF NOT EXISTS categories_nonfiction_backup (
  book_id           INT PRIMARY KEY REFERENCES books (id) ON DELETE CASCADE,
  categories_before TEXT,
  saved_at          TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nonfiction_rename_backup (
  on_table   TEXT NOT NULL,
  row_id       INT NOT NULL,
  on_column  TEXT NOT NULL,
  value_before TEXT,
  saved_at     TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (on_table, row_id, on_column)
);

DROP TABLE IF EXISTS pg_temp.nonfiction_fix_114;
CREATE TEMP TABLE nonfiction_fix_114 AS
WITH items AS (
  SELECT b.id, e.ord, btrim(e.g) AS g, btrim(e.g) ~* '^non([-‐‑]|\s+)?fiction$' AS nf
  FROM books b CROSS JOIN LATERAL unnest(string_to_array(b.categories, ',')) WITH ORDINALITY AS e(g, ord)
  WHERE b.categories ~* '(^|,)\s*non([-‐‑]|\s+)?fiction\s*(,|$)'
),
mapped AS (
  SELECT id, ord, nf, g AS raw, CASE WHEN nf THEN 'Nonfiction' ELSE g END AS g
  FROM items WHERE g <> ''
),
kept AS (
  SELECT m.* FROM mapped m
  WHERE NOT m.nf OR m.ord = (SELECT min(m2.ord) FROM mapped m2 WHERE m2.id = m.id AND m2.nf)
),
agg AS (
  SELECT id, string_agg(g, ', ' ORDER BY ord) AS new_categories
  FROM kept GROUP BY id
),
chg AS (
  SELECT id FROM mapped GROUP BY id
  HAVING bool_or(nf AND raw <> 'Nonfiction') OR count(*) FILTER (WHERE nf) > 1
)
SELECT b.id, b.categories AS old_categories, a.new_categories
FROM books b JOIN agg a ON a.id = b.id JOIN chg c ON c.id = b.id;

DROP TABLE IF EXISTS pg_temp.nonfiction_names_114;
CREATE TEMP TABLE nonfiction_names_114 AS
SELECT g.id, g.name_en, g.browse_label_en,
       (g.name_en ~* '^\s*non([-‐‑]|\s+)?fiction\s*$' AND g.name_en <> 'Nonfiction'
         AND NOT EXISTS (SELECT 1 FROM managed_genres o WHERE lower(btrim(o.name_en)) = 'nonfiction' AND o.id <> g.id)) AS rename_name,
       (g.browse_label_en ~* '^\s*non([-‐‑]|\s+)?fiction\s*$' AND g.browse_label_en <> 'Nonfiction') AS rename_label
FROM managed_genres g;

DROP TABLE IF EXISTS pg_temp.nonfiction_rules_114;
CREATE TEMP TABLE nonfiction_rules_114 AS
SELECT r.id, r.pattern, r.pattern_key
FROM genre_rules r
WHERE r.kind = 'exact' AND r.pattern ~* '^\s*non([-‐‑]|\s+)?fiction\s*$' AND r.pattern <> 'Nonfiction'
  AND NOT EXISTS (SELECT 1 FROM genre_rules o WHERE o.kind = 'exact' AND o.pattern_key = 'nonfiction' AND o.id <> r.id);

-- 1. the copies first
INSERT INTO categories_nonfiction_backup (book_id, categories_before)
SELECT id, old_categories FROM nonfiction_fix_114
ON CONFLICT DO NOTHING;

INSERT INTO nonfiction_rename_backup (on_table, row_id, on_column, value_before)
SELECT 'managed_genres', id, 'name_en', name_en FROM nonfiction_names_114 WHERE rename_name
UNION ALL
SELECT 'managed_genres', id, 'browse_label_en', browse_label_en FROM nonfiction_names_114 WHERE rename_label
UNION ALL
SELECT 'genre_rules', id, 'pattern', pattern FROM nonfiction_rules_114
ON CONFLICT DO NOTHING;

-- 2. then the rows
UPDATE managed_genres g SET name_en = 'Nonfiction', updated_at = now()
FROM nonfiction_names_114 n WHERE n.id = g.id AND n.rename_name;

UPDATE managed_genres g SET browse_label_en = 'Nonfiction', updated_at = now()
FROM nonfiction_names_114 n WHERE n.id = g.id AND n.rename_label;

UPDATE genre_rules r SET pattern = 'Nonfiction', pattern_key = 'nonfiction', updated_at = now()
FROM nonfiction_rules_114 n WHERE n.id = r.id;

UPDATE books b SET categories = f.new_categories
FROM nonfiction_fix_114 f WHERE b.id = f.id;

-- 3. Admin activity
INSERT INTO admin_audit_log (actor_label, action, target_type, detail)
SELECT 'migration 114', 'books.nonfiction_spelling', 'book',
       'Non-fiction spelled Nonfiction on ' || s.n || ' book' || CASE WHEN s.n = 1 THEN '' ELSE 's' END
       || ' and in the genre list. Old values kept in tables categories_nonfiction_backup and nonfiction_rename_backup. No book, copy or price was deleted.'
FROM (SELECT count(*)::int AS n FROM nonfiction_fix_114) s
WHERE s.n > 0 OR NOT EXISTS (SELECT 1 FROM admin_audit_log WHERE action = 'books.nonfiction_spelling');

DROP TABLE nonfiction_fix_114;
DROP TABLE nonfiction_names_114;
DROP TABLE nonfiction_rules_114;
