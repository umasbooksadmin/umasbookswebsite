-- Optional French versions of the admin-written texts that customers see on the French pages.
-- Every column is NULLABLE with no default: the English columns are untouched, adding a nullable column rewrites no
-- rows, and nothing here is machine translated or back-filled (the shop writes or reviews each French text in the
-- admin screens). A row without French shows its English text on the French pages, marked as English
-- (lib/frenchText.js). No table is added, so lib/clearTestData.js needs no change.
--   events         title, description, location   (the /events calendar, /api/events/upcoming, the .ics file)
--   classes        title                          (the /sessions calendar and the drop-in lines in the cart, the
--                                                  order pages and the e-mails; the other columns are not shown to customers)
--   announcements  title, excerpt, body           (the member home page and /announcements)
--   charities      description                    (the charity vote page; names stay as they are)
--   charity_rounds title                          (the question above the vote)
ALTER TABLE events ADD COLUMN IF NOT EXISTS title_fr TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS description_fr TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS location_fr TEXT;

ALTER TABLE classes ADD COLUMN IF NOT EXISTS title_fr TEXT;

ALTER TABLE announcements ADD COLUMN IF NOT EXISTS title_fr TEXT;
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS excerpt_fr TEXT;
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS body_fr TEXT;

ALTER TABLE charities ADD COLUMN IF NOT EXISTS description_fr TEXT;
ALTER TABLE charity_rounds ADD COLUMN IF NOT EXISTS title_fr TEXT;
