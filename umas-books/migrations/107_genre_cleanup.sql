-- Genre clean-up of the books already saved (approved by the shop on 2026-10-28).
--
-- A genre typed on a phone has a curly apostrophe ("Children’s Fiction"), and the § key of a Mac ISO keyboard sits next
-- to 1, so "Children's Fiction§" got saved. Neither matched the genre list, so the French genre stayed in English
-- ("Children's Fiction§" instead of "Fiction jeunesse"). New saves are cleaned by the app now (src/lib/genreClean.js);
-- this applies the SAME clean-up to books.categories and books.categories_fr of the books already there:
--   - each genre: typographic apostrophes -> ', every kind of space -> one space, characters at the start that are not
--     a letter, digit or opening bracket and at the end that are not a letter, digit, closing bracket, + or # dropped;
--     a known genre (the fixed list below + the managed genres of Admin > Genres) takes its own spelling; duplicates go
--   - French: each entry cleaned the same way; an entry that is just the English name of a known genre becomes its
--     French; no French at all while one of the genres is a known one: the French is made from the English
--   - a book is only written when its genres really change (spacing around the commas alone does not count, and a
--     genre list that would end up empty is left as it is). Nothing is deleted.
--
-- The change is recorded like an "Update all books" run (genre_runs + genre_run_changes: Admin > Genres shows it with
-- the before / after of every book and Undo), and in Admin activity (admin_audit_log, action genre.cleanup):
-- "Genre clean-up: N books corrected" with the book ids. Running it again changes nothing (and adds no second record
-- once the first one exists). test/integration/genreCleanupMigration.test.js checks it gives the same result as the
-- JS (planGenreCleanup), and that the list below equals GENRE_ALIASES_FR + COMMON_GENRES / COMMON_GENRES_FR of
-- src/lib/bookLookup.js. The character classes are the ones of src/lib/genreClean.js, as code-point ranges so they do
-- not depend on the database locale.

CREATE OR REPLACE FUNCTION pg_temp.genre_clean_107(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT regexp_replace(
           regexp_replace(
             regexp_replace(
               translate(t, E'‘’‛ʼ′`´', repeat('''', 7)),
               '[\u0001- \u007F   -​    　﻿]+', ' ', 'g'),
             '^[^0-9A-Za-zÀ-ÖØ-öø-ʯͰ-῿぀-鿿가-힯([{]+', ''),
           '[^0-9A-Za-zÀ-ÖØ-öø-ʯͰ-῿぀-鿿가-힯)\]}+#]+$', '')
$fn$;

DROP TABLE IF EXISTS pg_temp.genre_known_107;
CREATE TEMP TABLE genre_known_107 (key TEXT PRIMARY KEY, en TEXT NOT NULL, fr TEXT NOT NULL);

-- The fixed list: GENRE_ALIASES_FR, then COMMON_GENRES / COMMON_GENRES_FR (the taxonomy wins over an alias, a later
-- entry over an earlier one, as in translateGenresToFrench).
INSERT INTO genre_known_107 (key, en, fr)
SELECT DISTINCT ON (key) key, en, fr
FROM (
  SELECT lower(pg_temp.genre_clean_107(v.en)) AS key, pg_temp.genre_clean_107(v.en) AS en, v.fr, v.list, v.ord
  FROM (VALUES
  ('alias', 1, 'Young Adult', 'Jeune adulte'),
  ('alias', 2, 'Young Adult Books', 'Jeune adulte'),
  ('alias', 3, 'Children''s', 'Jeunesse'),
  ('alias', 4, 'Children''s Books', 'Jeunesse'),
  ('alias', 5, 'Children', 'Jeunesse'),
  ('alias', 6, 'Juvenile Fiction', 'Fiction jeunesse'),
  ('alias', 7, 'Nonfiction', 'Non-fiction'),
  ('alias', 8, 'Juvenile Nonfiction', 'Documentaires jeunesse'),
  ('alias', 9, 'Picture Books', 'Albums illustrés'),
  ('alias', 10, 'Memoir', 'Mémoires'),
  ('alias', 11, 'Memoirs', 'Mémoires'),
  ('alias', 12, 'Autobiography', 'Autobiographie'),
  ('alias', 13, 'Biography & Autobiography', 'Biographies et autobiographies'),
  ('alias', 14, 'Crime', 'Polar'),
  ('alias', 15, 'Detective', 'Policier'),
  ('alias', 16, 'Mystery & Detective', 'Policier'),
  ('alias', 17, 'Suspense', 'Suspense'),
  ('alias', 18, 'Crime & Mystery', 'Polar'),
  ('alias', 19, 'True Crime', 'Faits divers'),
  ('alias', 20, 'Sci-Fi', 'Science-fiction'),
  ('alias', 21, 'Short Stories', 'Nouvelles'),
  ('alias', 22, 'Graphic Novels', 'Bandes dessinées'),
  ('alias', 23, 'Comics', 'Bandes dessinées'),
  ('alias', 24, 'Comics & Graphic Novels', 'Bandes dessinées'),
  ('alias', 25, 'Literary Fiction', 'Littérature générale'),
  ('alias', 26, 'Historical Fiction', 'Roman historique'),
  ('alias', 27, 'Humour', 'Humour'),
  ('alias', 28, 'Humor & Entertainment', 'Humour'),
  ('alias', 29, 'Self Help', 'Développement personnel'),
  ('alias', 30, 'Self-Help', 'Développement personnel'),
  ('alias', 31, 'Health', 'Santé'),
  ('alias', 32, 'Health & Fitness', 'Santé et forme'),
  ('alias', 33, 'Fitness', 'Forme'),
  ('alias', 34, 'Wellness', 'Bien-être'),
  ('alias', 35, 'Psychology', 'Psychologie'),
  ('alias', 36, 'Business', 'Économie et gestion'),
  ('alias', 37, 'Education', 'Éducation'),
  ('alias', 38, 'Science', 'Sciences'),
  ('alias', 39, 'Nature', 'Nature'),
  ('alias', 40, 'Language', 'Langues'),
  ('alias', 41, 'Social Science', 'Sciences sociales'),
  ('alias', 42, 'Political Science', 'Sciences politiques'),
  ('alias', 43, 'Music', 'Musique'),
  ('alias', 44, 'Photography', 'Photographie'),
  ('alias', 45, 'Antiques & Collectibles', 'Antiquités et objets de collection'),
  ('alias', 46, 'Performing Arts', 'Arts du spectacle'),
  ('alias', 47, 'Arts & Crafts', 'Arts et loisirs créatifs'),
  ('alias', 48, 'Crafts & Hobbies', 'Loisirs créatifs'),
  ('alias', 49, 'Design', 'Design'),
  ('alias', 50, 'Gardening', 'Jardinage'),
  ('alias', 51, 'Home & Garden', 'Maison et jardin'),
  ('alias', 52, 'House & Home', 'Maison'),
  ('alias', 53, 'Interior Design', 'Décoration d''intérieur'),
  ('alias', 54, 'Food & Drink', 'Cuisine et boissons'),
  ('alias', 55, 'Cooking & Food', 'Cuisine'),
  ('alias', 56, 'Wine', 'Vin'),
  ('alias', 57, 'Baking', 'Pâtisserie'),
  ('alias', 58, 'Pets', 'Animaux de compagnie'),
  ('alias', 59, 'Sports & Recreation', 'Sports et loisirs'),
  ('alias', 60, 'Games', 'Jeux'),
  ('alias', 61, 'Reference', 'Ouvrages de référence'),
  ('alias', 62, 'Fairy Tales', 'Contes'),
  ('taxonomy', 1, 'Fiction', 'Fiction'),
  ('taxonomy', 2, 'Non-fiction', 'Non-fiction'),
  ('taxonomy', 3, 'Fantasy', 'Fantasy'),
  ('taxonomy', 4, 'Science Fiction', 'Science-fiction'),
  ('taxonomy', 5, 'Mystery', 'Policier'),
  ('taxonomy', 6, 'Romance', 'Romance'),
  ('taxonomy', 7, 'Thriller', 'Thriller'),
  ('taxonomy', 8, 'Horror', 'Horreur'),
  ('taxonomy', 9, 'Biography', 'Biographie'),
  ('taxonomy', 10, 'History', 'Histoire'),
  ('taxonomy', 11, 'Poetry', 'Poésie'),
  ('taxonomy', 12, 'Drama', 'Théâtre'),
  ('taxonomy', 13, 'Adventure', 'Aventure'),
  ('taxonomy', 14, 'Humor', 'Humour'),
  ('taxonomy', 15, 'Philosophy', 'Philosophie'),
  ('taxonomy', 16, 'Religion', 'Religion'),
  ('taxonomy', 17, 'Travel', 'Voyage'),
  ('taxonomy', 18, 'Cooking', 'Cuisine'),
  ('taxonomy', 19, 'Art', 'Art'),
  ('taxonomy', 20, 'Self-help', 'Développement personnel'),
  ('taxonomy', 21, 'Children''s Fiction', 'Fiction jeunesse'),
  ('taxonomy', 22, 'Young Adult Fiction', 'Fiction jeune adulte'),
  ('taxonomy', 23, 'Classics', 'Classiques')
  ) AS v(list, ord, en, fr)
) s
WHERE key <> ''
ORDER BY key, (list = 'taxonomy') DESC, ord DESC;

-- The managed genres of Admin > Genres win over the fixed list (a blank French name: the fixed list's, else the English).
INSERT INTO genre_known_107 (key, en, fr)
SELECT DISTINCT ON (key) key, en, fr
FROM (
  SELECT lower(pg_temp.genre_clean_107(m.name_en)) AS key, pg_temp.genre_clean_107(m.name_en) AS en,
         COALESCE(NULLIF(btrim(m.name_fr), ''), k.fr, pg_temp.genre_clean_107(m.name_en)) AS fr, m.sort_order, m.id
  FROM managed_genres m LEFT JOIN genre_known_107 k ON k.key = lower(pg_temp.genre_clean_107(m.name_en))
) s
WHERE key <> ''
ORDER BY key, sort_order DESC, id DESC
ON CONFLICT (key) DO UPDATE SET en = EXCLUDED.en, fr = EXCLUDED.fr;

DROP TABLE IF EXISTS pg_temp.genre_fix_107;
CREATE TEMP TABLE genre_fix_107 AS
WITH base AS (
  SELECT id, categories, categories_fr FROM books WHERE categories IS NOT NULL OR categories_fr IS NOT NULL
),
en_items AS (
  SELECT b.id, e.ord, btrim(e.g) AS raw, pg_temp.genre_clean_107(e.g) AS c
  FROM base b CROSS JOIN LATERAL unnest(string_to_array(b.categories, ',')) WITH ORDINALITY AS e(g, ord)
),
en_first AS (
  SELECT DISTINCT ON (id, lower(g)) id, ord, g, known
  FROM (SELECT i.id, i.ord, COALESCE(k.en, i.c) AS g, k.key IS NOT NULL AS known
        FROM en_items i LEFT JOIN genre_known_107 k ON k.key = lower(i.c) WHERE i.c <> '') x
  ORDER BY id, lower(g), ord
),
en_new AS (SELECT id, array_agg(g ORDER BY ord) AS arr, bool_or(known) AS any_known FROM en_first GROUP BY id),
en_old AS (SELECT id, array_agg(raw ORDER BY ord) FILTER (WHERE raw <> '') AS arr FROM en_items GROUP BY id),
fr_items AS (
  SELECT b.id, e.ord, btrim(e.g) AS raw, pg_temp.genre_clean_107(e.g) AS c
  FROM base b CROSS JOIN LATERAL unnest(string_to_array(b.categories_fr, ',')) WITH ORDINALITY AS e(g, ord)
),
fr_first AS (
  SELECT DISTINCT ON (id, lower(g)) id, ord, g
  FROM (SELECT i.id, i.ord, COALESCE(k.fr, i.c) AS g FROM fr_items i LEFT JOIN genre_known_107 k ON k.key = lower(i.c) WHERE i.c <> '') x
  ORDER BY id, lower(g), ord
),
fr_new AS (SELECT id, array_agg(g ORDER BY ord) AS arr FROM fr_first GROUP BY id),
fr_old AS (SELECT id, array_agg(raw ORDER BY ord) FILTER (WHERE raw <> '') AS arr FROM fr_items GROUP BY id),
-- The French made from the (new) English, for a book with no French.
fr_made AS (
  SELECT DISTINCT ON (f.id, lower(COALESCE(k.fr, f.g))) f.id, f.ord, COALESCE(k.fr, f.g) AS g
  FROM en_first f LEFT JOIN genre_known_107 k ON k.key = lower(f.g)
  ORDER BY f.id, lower(COALESCE(k.fr, f.g)), f.ord
),
fr_made_agg AS (SELECT id, array_agg(g ORDER BY ord) AS arr FROM fr_made GROUP BY id),
planned AS (
  SELECT b.id, b.categories AS old_en, b.categories_fr AS old_fr,
         CASE WHEN en.arr IS NULL OR en.arr = eo.arr THEN b.categories ELSE array_to_string(en.arr, ', ') END AS new_en,
         CASE WHEN fn.arr IS NOT NULL THEN (CASE WHEN fn.arr = fo.arr THEN b.categories_fr ELSE array_to_string(fn.arr, ', ') END)
              WHEN en.any_known THEN array_to_string(fm.arr, ', ')
              ELSE b.categories_fr END AS new_fr
  FROM base b
  LEFT JOIN en_new en ON en.id = b.id LEFT JOIN en_old eo ON eo.id = b.id
  LEFT JOIN fr_new fn ON fn.id = b.id LEFT JOIN fr_old fo ON fo.id = b.id
  LEFT JOIN fr_made_agg fm ON fm.id = b.id
)
SELECT * FROM planned WHERE new_en IS DISTINCT FROM old_en OR new_fr IS DISTINCT FROM old_fr;

UPDATE books b SET categories = f.new_en, categories_fr = f.new_fr, updated_at = now()
FROM genre_fix_107 f WHERE b.id = f.id;

-- The record in Admin > Genres (a run with Undo), only when something changed.
WITH run AS (
  INSERT INTO genre_runs (started_at, finished_at, status, books_changed, genres_removed, note)
  SELECT now(), now(), 'done', count(*), 0,
         'Genre clean-up made by the update (migration 107): curly apostrophes, stray characters such as § at the end, French genres left in English.'
  FROM genre_fix_107 HAVING count(*) > 0
  RETURNING id
)
INSERT INTO genre_run_changes (run_id, book_id, old_categories, old_categories_fr, new_categories, new_categories_fr)
SELECT run.id, f.id, f.old_en, f.old_fr, f.new_en, f.new_fr FROM run, genre_fix_107 f;

-- The line in Admin activity: always on the first run (also "0 books"), afterwards only if something changed.
INSERT INTO admin_audit_log (actor_label, action, target_type, target_id, detail)
SELECT 'automatic (migration 107)', 'genre.cleanup',
       CASE WHEN r.id IS NULL THEN NULL ELSE 'genre_run' END, r.id,
       'Genre clean-up: ' || s.n || ' book' || CASE WHEN s.n = 1 THEN '' ELSE 's' END || ' corrected'
       || CASE WHEN s.n = 0 THEN ' (nothing needed fixing).'
               ELSE '. Before and after of each book (and Undo): Admin > Genres, run ' || r.id || '. Book ids: ' || s.ids
                    || CASE WHEN s.n > 300 THEN ', and ' || (s.n - 300) || ' more (all in the run).' ELSE '.' END END
FROM (SELECT count(*)::int AS n, string_agg(id::text, ', ' ORDER BY id) FILTER (WHERE rn <= 300) AS ids
      FROM (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM genre_fix_107) t) s
LEFT JOIN LATERAL (SELECT max(id) AS id FROM genre_runs WHERE started_at = now() AND note LIKE 'Genre clean-up made by the update (migration 107)%') r ON s.n > 0
WHERE s.n > 0 OR NOT EXISTS (SELECT 1 FROM admin_audit_log WHERE action = 'genre.cleanup');

DROP TABLE genre_fix_107;
DROP TABLE genre_known_107;
DROP FUNCTION pg_temp.genre_clean_107(text);
