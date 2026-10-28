// What a freshly saved book still lacks, filled in AFTER the save has answered.
//
// Saving a book used to wait for the AI description (up to 8 s), a search for a cover (Open Library, 10 s or more) and the
// download and re-encoding of that cover, all before the first database write. None
// of it is needed to put the copy on the shelf, so the save now writes the row at once
// and calls fillBookGaps() afterwards (lib/afterResponse.js). The book page, the shop
// and the next scan see the cover and the texts a few seconds later; nothing already
// stored is ever overwritten (every column is filled only while it is still empty), and
// a cover that could not be downloaded keeps its source address for the 5-minute
// cover job (coverStore.backfillCovers), as before.
// Books have no French description or French genre (Sharon, 2026-10-28): nothing French is ever written here; the
// French site shows the English description (the books table has no French columns since migration 108).

const { lookupByIsbn, searchByTitleAuthor, isbnCoverUrl } = require("./bookLookup");
const { prepareCover } = require("./coverStore");
const { generateBookDescription } = require("./bookDescription");

// Best-effort cover address for a book saved without one: the ISBN first (most
// precise), then a title/author search.
async function findCoverUrl({ isbn, title, author }) {
  if (isbn) {
    const byIsbn = await lookupByIsbn(isbn);
    if (byIsbn && byIsbn.coverUrl) return byIsbn.coverUrl;
  }
  if (title) {
    const candidates = await searchByTitleAuthor(title, author);
    const withCover = candidates.find((c) => c.coverUrl);
    if (withCover) return withCover.coverUrl;
  }
  // Open Library's own cover for the ISBN, when the catalog records had none ("default=false": a 404 when there is none,
  // so a placeholder is never stored). prepareCover keeps the address for the 5-minute cover job if the download fails.
  const byIsbnCover = isbnCoverUrl(isbn);
  if (byIsbnCover) return byIsbnCover;
  return null;
}

// hints: { isbn, title, author, publisher, publishedYear, description, coverUrl }
// as typed on the form (all optional). deps: injectable for tests.
async function fillBookGaps(pool, bookId, hints = {}, deps = {}) {
  const describe = deps.generateBookDescription || generateBookDescription;
  const findCover = deps.findCoverUrl || findCoverUrl;
  const prepare = deps.prepareCover || prepareCover;

  const { rows } = await pool.query("SELECT description, cover_url, cover_removed_at FROM books WHERE id = $1", [bookId]);
  const row = rows[0];
  if (!row) return { filled: false };
  const needDescription = !row.description;
  // A cover an admin removed on purpose (migration 098) is not looked up again.
  const needCover = !row.cover_url && !row.cover_removed_at;
  if (!needDescription && !needCover) return { filled: false };

  const [description, coverAddress] = await Promise.all([
    needDescription ? (hints.description || describe({ title: hints.title, author: hints.author, publisher: hints.publisher, publishedYear: hints.publishedYear })) : null,
    needCover ? (hints.coverUrl || findCover({ isbn: hints.isbn, title: hints.title, author: hints.author })) : null,
  ]);
  const cover = needCover ? await prepare(coverAddress) : { cover: null, source: null };

  if (!description && !cover.cover && !cover.source) return { filled: false };
  await pool.query(
    `UPDATE books SET description = COALESCE(description, $1),
            cover_url = COALESCE(cover_url, $2),
            cover_source_url = CASE WHEN cover_url IS NULL AND $3::text IS NOT NULL THEN $3 ELSE cover_source_url END,
            cover_fetch_failures = CASE WHEN cover_url IS NULL AND $3::text IS NOT NULL THEN 0 ELSE cover_fetch_failures END,
            updated_at = now()
     WHERE id = $4`,
    [description, cover.cover, cover.source, bookId]
  );
  return { filled: true, description: Boolean(description), cover: Boolean(cover.cover) };
}

module.exports = { fillBookGaps, findCoverUrl };
