// The cover note (long text on the book page, short on lists; views/partials/cover_note.ejs) (review 6B L4):
// true only for a cover that really came from an online library, never for the shop's own photo or a book with no cover.
//
// books.cover_origin (migration 111): 'isbn' (found for the exact ISBN), 'chosen' (picked from Open Library on the
// Find a cover page) and 'form' (the scan preview's catalog cover, or an address typed by hand) are online-library
// covers; 'photo' is the owner's own photo. A cover saved before that column (NULL) counts as a library one when it was
// downloaded from somewhere (cover_source_url), which is how almost all of them were added; the note is shown for it,
// as it always was.
const LIBRARY_ORIGINS = ["isbn", "chosen", "form"];

// SQL over the book alias: the cover came from an online library.
const LIBRARY_COVER_SQL = (b = "b") =>
  `(${b}.cover_url IS NOT NULL AND (${b}.cover_origin IN ('isbn', 'chosen', 'form') OR (${b}.cover_origin IS NULL AND ${b}.cover_source_url IS NOT NULL)))`;

// The same for a books row (cover_url, cover_origin, cover_source_url).
const isLibraryCover = (row) => Boolean(row && row.cover_url
  && (LIBRARY_ORIGINS.includes(row.cover_origin) || (row.cover_origin == null && row.cover_source_url)));

module.exports = { LIBRARY_COVER_SQL, isLibraryCover };
