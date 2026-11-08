-- "Children's Fiction" is spelled with a capital F, a straight apostrophe, everywhere (Sharon, 2026-11-08). The managed genre
-- of Admin > Genres was spelled "Children's fiction" (lower-case f) and, because the managed spelling wins over the built-in
-- taxonomy (src/lib/genreClean.js buildKnown), every book saved or tidied since carried the lower-case spelling. This moves
-- the data to "Children's Fiction" so that no book is cut off from its genre by the new spelling. Same shape as migration 114.
--
-- What it changes (and nothing else):
--   1. managed_genres (Admin > Genres): the genre named Children's fiction in any capitals (or with a typographic apostrophe)
--      is renamed Children's Fiction; its Browse button label, when it is that same name typed in another spelling, too (the
--      usual label "Children's Books" is left alone, and so is any label the admin wrote herself). The slug (children), the
--      search words (browse_topic), colour, icon, order and visibility stay. DUPLICATES: two rows cannot differ only by
--      capitals (unique index on lower(name_en)), but a row spelled with a curly apostrophe can sit next to a straight one.
--      Then the straight-apostrophe row is kept (renamed if needed), the rules that pointed at the curly row are moved to it,
--      and the curly row is deleted after its whole row was saved in children_fiction_rename_backup.
--   2. books.categories (comma-separated genre names, matched exactly against the managed names): every element that equals
--      children's fiction in any capitals / with a typographic apostrophe becomes "Children's Fiction". The other elements and
--      the order are kept; a duplicate Children's Fiction in one book is dropped. A book is written only when one of those
--      elements really changes (or is doubled); only books.categories changes (not updated_at, no copy, no price). Nothing is
--      deleted. ("Childrens fiction" and "Chidren's Fiction", the typos, were already corrected by migration 109.)
--   3. genre_rules: an EXACT rule whose pattern is a variant gets the pattern Children's Fiction (skipped when another exact rule
--      already has that key). Word rules are not touched. Past Update-all runs (genre_runs, genre_run_changes,
--      book_genre_cleanup_backup, categories_nonfiction_backup, ...) are a record of what was, and are NOT rewritten.
--   No other table stores a genre name: curated collections hold book ids, prices and sales rules hold none, and the
--   Educational items genres (edu_genres) are a separate list.
--   Free text (book descriptions, blog posts, announcements) is NOT touched.
--
-- Safety net, in this order, inside the one transaction the migration runner gives every file:
--   1. the old categories of every book about to change are COPIED into categories_childrens_fiction_backup (one row per book,
--      ON CONFLICT DO NOTHING: a value already saved is never overwritten); the old name / label / rule pattern / merged row go
--      to children_fiction_rename_backup (on_table, row_id, on_column, value_before);
--   2. only then are the rows updated;
--   3. one line in Admin activity (admin_audit_log, action books.childrens_fiction_spelling), also when it is 0 the first time.
-- Idempotent: a second run finds nothing to change, writes nothing and adds no second Admin activity line. Safe when the genre
-- does not exist (every step then finds no row).
--
-- UNDO (run by hand in Render Shell / psql, in one transaction; the matching code change must be rolled back too):
--   UPDATE books b SET categories = k.categories_before FROM categories_childrens_fiction_backup k WHERE k.book_id = b.id;
--   UPDATE managed_genres g SET name_en = k.value_before FROM children_fiction_rename_backup k
--     WHERE k.on_table = 'managed_genres' AND k.on_column = 'name_en' AND k.row_id = g.id;
--   UPDATE managed_genres g SET browse_label_en = k.value_before FROM children_fiction_rename_backup k
--     WHERE k.on_table = 'managed_genres' AND k.on_column = 'browse_label_en' AND k.row_id = g.id;
--   UPDATE genre_rules r SET pattern = k.value_before, pattern_key = lower(k.value_before) FROM children_fiction_rename_backup k
--     WHERE k.on_table = 'genre_rules' AND k.on_column = 'pattern' AND k.row_id = r.id;
-- (A merged curly-apostrophe genre row, if any, is in children_fiction_rename_backup with on_column 'row', as JSON. A book
-- edited since the migration would get its old value back: check that first.)
-- The variant spelling below equals CHILDRENS_FICTION_VARIANT_RE of src/lib/genreClean.js
-- (test/integration/childrensFictionMigration.test.js).

CREATE TABLE IF NOT EXISTS categories_childrens_fiction_backup (
  book_id           INT PRIMARY KEY REFERENCES books (id) ON DELETE CASCADE,
  categories_before TEXT,
  saved_at          TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS children_fiction_rename_backup (
  on_table     TEXT NOT NULL,
  row_id       INT NOT NULL,
  on_column    TEXT NOT NULL,
  value_before TEXT,
  saved_at     TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (on_table, row_id, on_column)
);

-- typographic apostrophes -> ' (the same list as APOSTROPHES of genreClean.js), then trimmed
CREATE OR REPLACE FUNCTION pg_temp.cf_norm_118(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT btrim(translate(t, E'‘’‛ʼ′`´', repeat('''', 7)))
$fn$;

DROP TABLE IF EXISTS pg_temp.cf_fix_118;
CREATE TEMP TABLE cf_fix_118 AS
WITH items AS (
  SELECT b.id, e.ord, btrim(e.g) AS g,
         pg_temp.cf_norm_118(e.g) ~* '^children''s\s+fiction$' AS cf
  FROM books b CROSS JOIN LATERAL unnest(string_to_array(b.categories, ',')) WITH ORDINALITY AS e(g, ord)
  WHERE pg_temp.cf_norm_118(b.categories) ~* '(^|,)\s*children''s\s+fiction\s*(,|$)'
),
mapped AS (
  SELECT id, ord, cf, g AS raw, CASE WHEN cf THEN 'Children''s Fiction' ELSE g END AS g
  FROM items WHERE g <> ''
),
kept AS (
  SELECT m.* FROM mapped m
  WHERE NOT m.cf OR m.ord = (SELECT min(m2.ord) FROM mapped m2 WHERE m2.id = m.id AND m2.cf)
),
agg AS (
  SELECT id, string_agg(g, ', ' ORDER BY ord) AS new_categories
  FROM kept GROUP BY id
),
chg AS (
  SELECT id FROM mapped GROUP BY id
  HAVING bool_or(cf AND raw <> 'Children''s Fiction') OR count(*) FILTER (WHERE cf) > 1
)
SELECT b.id, b.categories AS old_categories, a.new_categories
FROM books b JOIN agg a ON a.id = b.id JOIN chg c ON c.id = b.id;

-- The managed genres of the family. keep_id = the row that survives (a straight-apostrophe row wins over a curly one).
DROP TABLE IF EXISTS pg_temp.cf_names_118;
CREATE TEMP TABLE cf_names_118 AS
WITH fam AS (
  SELECT g.id, g.name_en, g.browse_label_en,
         (pg_temp.cf_norm_118(g.name_en) ~* '^children''s\s+fiction$') AS is_name,
         (btrim(g.name_en) = pg_temp.cf_norm_118(g.name_en)) AS straight
  FROM managed_genres g
),
surv AS (
  SELECT (SELECT f.id FROM fam f WHERE f.is_name ORDER BY f.straight DESC, f.id LIMIT 1) AS keep_id
)
SELECT f.id, f.name_en, f.browse_label_en, f.is_name, (f.id = s.keep_id) AS survivor,
       (f.is_name AND f.id = s.keep_id AND f.name_en <> 'Children''s Fiction') AS rename_name,
       (f.is_name AND f.id <> s.keep_id) AS merge_away,
       (pg_temp.cf_norm_118(f.browse_label_en) ~* '^children''s\s+fiction$' AND f.browse_label_en <> 'Children''s Fiction') AS rename_label,
       s.keep_id
FROM fam f CROSS JOIN surv s;

DROP TABLE IF EXISTS pg_temp.cf_rules_118;
CREATE TEMP TABLE cf_rules_118 AS
SELECT r.id, r.pattern, r.pattern_key, r.target_managed_genre_id
FROM genre_rules r
WHERE r.kind = 'exact' AND pg_temp.cf_norm_118(r.pattern) ~* '^children''s\s+fiction$' AND r.pattern <> 'Children''s Fiction'
  AND NOT EXISTS (SELECT 1 FROM genre_rules o WHERE o.kind = 'exact' AND o.pattern_key = 'children''s fiction' AND o.id <> r.id);

-- 1. the copies first
INSERT INTO categories_childrens_fiction_backup (book_id, categories_before)
SELECT id, old_categories FROM cf_fix_118
ON CONFLICT DO NOTHING;

INSERT INTO children_fiction_rename_backup (on_table, row_id, on_column, value_before)
SELECT 'managed_genres', id, 'name_en', name_en FROM cf_names_118 WHERE rename_name
UNION ALL
SELECT 'managed_genres', id, 'browse_label_en', browse_label_en FROM cf_names_118 WHERE rename_label AND NOT merge_away
UNION ALL
SELECT 'managed_genres', g.id, 'row', row_to_json(g)::text FROM managed_genres g JOIN cf_names_118 n ON n.id = g.id WHERE n.merge_away
UNION ALL
SELECT 'genre_rules', id, 'pattern', pattern FROM cf_rules_118
UNION ALL
SELECT 'genre_rules', r.id, 'target_managed_genre_id', r.target_managed_genre_id::text
FROM genre_rules r JOIN cf_names_118 n ON n.id = r.target_managed_genre_id WHERE n.merge_away
ON CONFLICT DO NOTHING;

-- 2. then the rows
UPDATE genre_rules r SET target_managed_genre_id = n.keep_id, updated_at = now()
FROM cf_names_118 n WHERE n.id = r.target_managed_genre_id AND n.merge_away;

DELETE FROM managed_genres g USING cf_names_118 n WHERE n.id = g.id AND n.merge_away;

UPDATE managed_genres g SET name_en = 'Children''s Fiction', updated_at = now()
FROM cf_names_118 n WHERE n.id = g.id AND n.rename_name;

UPDATE managed_genres g SET browse_label_en = 'Children''s Fiction', updated_at = now()
FROM cf_names_118 n WHERE n.id = g.id AND n.rename_label AND NOT n.merge_away;

UPDATE genre_rules r SET pattern = 'Children''s Fiction', pattern_key = 'children''s fiction', updated_at = now()
FROM cf_rules_118 n WHERE n.id = r.id;

UPDATE books b SET categories = f.new_categories
FROM cf_fix_118 f WHERE b.id = f.id;

-- 3. Admin activity
INSERT INTO admin_audit_log (actor_label, action, target_type, detail)
SELECT 'migration 118', 'books.childrens_fiction_spelling', 'book',
       'Children''s fiction spelled Children''s Fiction on ' || s.n || ' book' || CASE WHEN s.n = 1 THEN '' ELSE 's' END
       || ' and in the genre list. Old values kept in tables categories_childrens_fiction_backup and children_fiction_rename_backup. No book, copy or price was deleted.'
FROM (SELECT count(*)::int AS n FROM cf_fix_118) s
WHERE s.n > 0 OR NOT EXISTS (SELECT 1 FROM admin_audit_log WHERE action = 'books.childrens_fiction_spelling');

DROP TABLE cf_fix_118;
DROP TABLE cf_names_118;
DROP TABLE cf_rules_118;
