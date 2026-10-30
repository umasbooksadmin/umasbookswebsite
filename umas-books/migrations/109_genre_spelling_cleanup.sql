-- Genre spelling clean-up of the books already saved (English only; Sharon, 2026-10-29).
--
-- A genre typed on a phone has a curly apostrophe ("Children’s Fiction"), the § key of a Mac ISO keyboard sits next to 1
-- ("Children's Fiction§"), and some were typed with a typo or the wrong capitals ("Chidren's Fiction", "art & Design").
-- New saves are cleaned by the app now (src/lib/genreClean.js); this applies the SAME clean-up to books.categories of the
-- books already there:
--   - each genre: typographic apostrophes -> ', every kind of space -> one space, characters at the start that are not
--     a letter, digit or opening bracket and at the end that are not a letter, digit, closing bracket, + # ! ? dropped
--   - a known genre (the fixed list COMMON_GENRES + the managed genres of Admin > Genres) takes its own spelling and
--     capitals; two typos we are sure about (see the typo list below) take the right genre; any other genre is only cleaned
--   - duplicates and empty parts go, the order is kept, the separator is ", "
--   - a book is written only when its genres really change (spacing around the commas alone does not count, and a genre
--     list that would end up empty is left as it is). Only books.categories is changed: no other column of the book
--     (not even updated_at), no copy, no price. Nothing is deleted.
--
-- Safety net, in this order, inside the one transaction the migration runner gives every file:
--   1. the old value of every book that is about to change is COPIED into book_genre_cleanup_backup (one row per book,
--      ON CONFLICT DO NOTHING: a value already saved is never overwritten);
--   2. only then is books.categories updated, for those books only;
--   3. one line in Admin activity (admin_audit_log, action books.genre_spelling_tidied), also when it is 0 the first time.
-- Idempotent: a second run finds nothing to change, writes nothing and adds no second Admin activity line.
-- Restore recipe: docs/runbook.md, "Genre spelling clean-up (migration 109)".
-- test/integration/genreSpellingMigration.test.js checks the SQL gives exactly what the JS (planGenreCleanup) gives, that
-- its clean-up function equals cleanGenreName, and that the lists below equal COMMON_GENRES and GENRE_TYPOS.

CREATE TABLE IF NOT EXISTS book_genre_cleanup_backup (
  book_id           INT PRIMARY KEY REFERENCES books (id) ON DELETE CASCADE,
  categories_before TEXT,
  saved_at          TIMESTAMPTZ DEFAULT now()
);

CREATE OR REPLACE FUNCTION pg_temp.genre_clean_109(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT regexp_replace(
           regexp_replace(
             regexp_replace(
               translate(t, E'‘’‛ʼ′`´', repeat('''', 7)),
               '[\u0001- \u007F   -​    　﻿]+', ' ', 'g'),
             '^[^0-9A-Za-zÀ-ÖØ-öø-ʯͰ-῿぀-鿿가-힯([{]+', ''),
           '[^0-9A-Za-zÀ-ÖØ-öø-ʯͰ-῿぀-鿿가-힯)\]}+#!?]+$', '')
$fn$;

DROP TABLE IF EXISTS pg_temp.genre_known_109;
CREATE TEMP TABLE genre_known_109 (key TEXT PRIMARY KEY, en TEXT NOT NULL);

-- The fixed list: COMMON_GENRES of src/lib/bookLookup.js.
INSERT INTO genre_known_109 (key, en)
SELECT lower(pg_temp.genre_clean_109(v.en)), pg_temp.genre_clean_109(v.en)
FROM (VALUES
  ('Fiction'), ('Non-fiction'), ('Fantasy'), ('Science Fiction'), ('Mystery'), ('Romance'), ('Thriller'), ('Horror'),
  ('Biography'), ('History'), ('Poetry'), ('Drama'), ('Adventure'), ('Humor'),
  ('Philosophy'), ('Religion'), ('Travel'), ('Cooking'), ('Art'), ('Self-help'),
  ('Children''s Fiction'), ('Young Adult Fiction'), ('Classics')
) AS v(en)
WHERE pg_temp.genre_clean_109(v.en) <> ''
ON CONFLICT (key) DO UPDATE SET en = EXCLUDED.en;

-- The managed genres of Admin > Genres win over the fixed list (the last one by sort order wins on equal names).
INSERT INTO genre_known_109 (key, en)
SELECT DISTINCT ON (key) key, en
FROM (SELECT lower(pg_temp.genre_clean_109(name_en)) AS key, pg_temp.genre_clean_109(name_en) AS en, sort_order, id FROM managed_genres) s
WHERE key <> ''
ORDER BY key, sort_order DESC, id DESC
ON CONFLICT (key) DO UPDATE SET en = EXCLUDED.en;

-- The typos we are sure about (GENRE_TYPOS of src/lib/genreClean.js): wrong spelling (lower case) -> the genre it means.
-- Only when the wrong spelling is not a known genre itself; it takes the spelling the known genre has.
INSERT INTO genre_known_109 (key, en)
SELECT t.wrong, COALESCE(k.en, pg_temp.genre_clean_109(t.right_name))
FROM (VALUES
  ('chidren''s fiction', 'Children''s Fiction'),
  ('childrens fiction', 'Children''s Fiction')
) AS t(wrong, right_name)
LEFT JOIN genre_known_109 k ON k.key = lower(pg_temp.genre_clean_109(t.right_name))
ON CONFLICT (key) DO NOTHING;

DROP TABLE IF EXISTS pg_temp.genre_fix_109;
CREATE TEMP TABLE genre_fix_109 AS
WITH items AS (
  SELECT b.id, e.ord, btrim(e.g) AS raw, pg_temp.genre_clean_109(e.g) AS c
  FROM books b CROSS JOIN LATERAL unnest(string_to_array(b.categories, ',')) WITH ORDINALITY AS e(g, ord)
  WHERE b.categories IS NOT NULL
),
first_of AS (
  SELECT DISTINCT ON (id, lower(g)) id, ord, g
  FROM (SELECT i.id, i.ord, COALESCE(k.en, i.c) AS g FROM items i LEFT JOIN genre_known_109 k ON k.key = lower(i.c) WHERE i.c <> '') x
  ORDER BY id, lower(g), ord
),
new_arr AS (SELECT id, array_agg(g ORDER BY ord) AS arr FROM first_of GROUP BY id),
old_arr AS (SELECT id, array_agg(raw ORDER BY ord) FILTER (WHERE raw <> '') AS arr FROM items GROUP BY id)
SELECT b.id, b.categories AS old_categories, array_to_string(n.arr, ', ') AS new_categories
FROM books b
JOIN new_arr n ON n.id = b.id
JOIN old_arr o ON o.id = b.id
WHERE n.arr IS DISTINCT FROM o.arr;

INSERT INTO book_genre_cleanup_backup (book_id, categories_before)
SELECT id, old_categories FROM genre_fix_109
ON CONFLICT DO NOTHING;

UPDATE books b SET categories = f.new_categories
FROM genre_fix_109 f WHERE b.id = f.id;

INSERT INTO admin_audit_log (actor_label, action, target_type, detail)
SELECT 'migration 109', 'books.genre_spelling_tidied', 'book',
       'Genre spelling tidied on ' || s.n || ' book' || CASE WHEN s.n = 1 THEN '' ELSE 's' END
       || '. Old values kept in table book_genre_cleanup_backup. No book, copy or price was deleted.'
FROM (SELECT count(*)::int AS n FROM genre_fix_109) s
WHERE s.n > 0 OR NOT EXISTS (SELECT 1 FROM admin_audit_log WHERE action = 'books.genre_spelling_tidied');

DROP TABLE genre_fix_109;
DROP TABLE genre_known_109;
DROP FUNCTION pg_temp.genre_clean_109(text);
