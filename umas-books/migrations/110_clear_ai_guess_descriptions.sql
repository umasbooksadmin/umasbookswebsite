-- Sharon, 2026-10-29 (migration 110): clear 26 book descriptions that were written by the AI from the title alone (or are an AI apology).
-- She reviewed the list (descriptions-to-review.md: group 1 = book 597, group 2 = the Wind in the Willows and Just William
-- episode books). Only the English description column of these books is emptied; titles, authors, copies and prices are
-- untouched, and every cleared text is first copied into cleared_book_descriptions (kept: it is the undo).
-- A book is only cleared while its description still STARTS WITH the text that was reviewed (compared on its first 30
-- letters and digits, ignoring case, spaces and punctuation): one that was edited or regenerated since is left alone.
-- Idempotent: a second run finds nothing to clear and writes no second Admin activity line.

CREATE TABLE IF NOT EXISTS cleared_book_descriptions (
  book_id     INT PRIMARY KEY REFERENCES books (id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  reason      TEXT NOT NULL,
  saved_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TEMP TABLE reviewed_descriptions (book_id INT PRIMARY KEY, starts_with TEXT NOT NULL) ON COMMIT DROP;
INSERT INTO reviewed_descriptions (book_id, starts_with) VALUES
  (573, 'adelightfulcollectionofstories'),
  (574, 'joinwilliambrownandhisloyalgan'),
  (575, 'joinwilliamandfriendsinacollec'),
  (576, 'joinwilliambrowninanothermisch'),
  (577, 'jointhemischievouswilliambrown'),
  (578, 'joinwilliambrownashestumblesth'),
  (579, 'joinjustwilliamonhislatestmisc'),
  (580, 'joinjustwilliamonanotherhilari'),
  (584, 'jointhemischievousmrtoadonhisw'),
  (585, 'returntothebelovedworldofthewi'),
  (586, 'whentoadhallfacesitsgreatestch'),
  (587, 'rattyfindshimselfeagerforadven'),
  (589, 'jointoadonathrillingadventurea'),
  (590, 'joinmoleonatouchingjourneyashe'),
  (591, 'whencuriousmoleventuresfromhis'),
  (592, 'joinkennethgrahameinthisenchan'),
  (593, 'stepintotheenchantedwildwoodwh'),
  (594, 'followmrbadgerthroughacharming'),
  (595, 'joinmoleonadelightfuladventure'),
  (596, 'whentheirrepressibletoadoftoad'),
  (597, 'imnotcertainofabooktitledfreed'),
  (598, 'joinmoleonacharmingadventurewh'),
  (599, 'meettheirrepressiblemrtoadtheb'),
  (600, 'jointoadonanotherwhimsicaladve'),
  (602, 'awhimsicaltaleofadventureandmi'),
  (603, 'escapetotheenglishcountrysidew');

INSERT INTO cleared_book_descriptions (book_id, description, reason)
SELECT b.id, b.description, 'AI text written from the title alone (reviewed by Sharon 2026-10-28)'
FROM books b JOIN reviewed_descriptions r ON r.book_id = b.id
WHERE b.description IS NOT NULL
  AND left(regexp_replace(lower(b.description), '[^a-z0-9]', '', 'g'), 30) = r.starts_with
ON CONFLICT DO NOTHING;

WITH cleared AS (
  UPDATE books b
     SET description = NULL
    FROM reviewed_descriptions r
   WHERE r.book_id = b.id
     AND b.description IS NOT NULL
     AND left(regexp_replace(lower(b.description), '[^a-z0-9]', '', 'g'), 30) = r.starts_with
  RETURNING b.id
)
INSERT INTO admin_audit_log (actor_label, action, target_type, detail)
SELECT 'migration 110', 'books.descriptions_cleared', 'book',
       'Description text cleared on ' || count(*) || ' book' || CASE WHEN count(*) = 1 THEN '' ELSE 's' END
       || ' (of 26 reviewed). The books themselves are untouched; the old texts are kept in table cleared_book_descriptions.'
FROM cleared
HAVING count(*) > 0
    OR NOT EXISTS (SELECT 1 FROM admin_audit_log WHERE action = 'books.descriptions_cleared');
