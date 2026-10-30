// "Covers to check" (Admin > Reports): books whose current cover MAY belong to another edition or another book, so the
// owner can look at them. Read-only on covers: nothing here changes, replaces or removes a picture.
//
// Why a heuristic: before migration 111 nothing recorded how a cover was chosen. The old automatic fill took the first
// result with a cover of a title/author search when the ISBN had none, so a book could carry a different edition's picture.
// What is stored: books.cover_source_url (the address the copy was downloaded from, kept after the download). Its shape
// tells a little:
//   .../b/isbn/<isbn13>-L.jpg   found for the exact ISBN: fine, not listed
//   .../b/id/<number>-L.jpg     a numbered picture: from the ISBN's own catalog record OR from a title search, can't tell
// So the list is: a cover on our server, from a numbered picture address, with no recorded origin (cover_origin IS NULL,
// i.e. saved before migration 111), not yet confirmed (cover_checked_at IS NULL). The owner's own photos have no source
// address and are not listed (a replaced cover keeps its old address, so it can still show up: mark it fine).
// "Check this book" asks the catalog once, for that one ISBN, when the owner presses it (no bulk or automatic check:
// Open Library rate-limits).

const { lookupByIsbn, isbnCoverUrl, isValidIsbn, normalizeIsbn } = require("./bookLookup");

const PAGE_SIZE = 50;
const WHERE = `b.cover_url IS NOT NULL
  AND b.cover_checked_at IS NULL
  AND b.cover_origin IS NULL
  AND b.cover_source_url IS NOT NULL
  AND b.cover_source_url !~ '/b/isbn/'`;

async function listCoversToCheck(pool, page = 1) {
  const p = Math.min(1e6, Math.max(1, Math.floor(Number(page)) || 1)); // clamped: a huge number must not reach the OFFSET
  const { rows: [{ total }] } = await pool.query(`SELECT count(*)::int AS total FROM books b WHERE ${WHERE}`);
  const { rows } = await pool.query(
    `SELECT b.id, b.isbn, b.title, b.authors, b.cover_url, b.cover_source_url,
            (SELECT count(*)::int FROM book_copies c WHERE c.book_id = b.id) AS copies,
            (SELECT count(*)::int FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock') AS in_stock
       FROM books b
      WHERE ${WHERE}
      ORDER BY (SELECT count(*) FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock') DESC, b.id
      LIMIT $1 OFFSET $2`,
    [PAGE_SIZE, (p - 1) * PAGE_SIZE]
  );
  return { rows, total, page: p, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

const pictureId = (url) => { const m = /\/b\/id\/(\d+)-/.exec(String(url || "")); return m ? m[1] : null; };

// Does the cover we stored for this book match what the catalog has for its exact ISBN? One catalog lookup (cached by
// lookupByIsbn), at most one HEAD request. deps are injectable for tests.
// -> { state: "match" | "different" | "none" | "unavailable" | "no-isbn", message, catalogCover }
async function checkCover(book, deps = {}) {
  const lookup = deps.lookupByIsbn || lookupByIsbn;
  const head = deps.head || (async (url) => { const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(6000) }); return r.ok; });
  const isbn = normalizeIsbn(book.isbn);
  if (!isValidIsbn(isbn)) return { state: "no-isbn", message: "This book has no valid ISBN, so its cover can't be compared. Look at it yourself.", catalogCover: null };
  let found;
  try { found = await lookup(isbn); } catch { found = null; }
  if (!found) return { state: "unavailable", message: "The catalog did not answer for this ISBN (or does not know it). Try again later.", catalogCover: null };
  const mine = pictureId(book.cover_source_url);
  const theirs = found.coverUrl || null;
  if (theirs) {
    if (mine && mine === pictureId(theirs)) return { state: "match", message: "Same picture as the catalog has for this exact ISBN.", catalogCover: theirs };
    return { state: "different", message: "The catalog has a different picture for this exact ISBN. Compare it with the one shown.", catalogCover: theirs };
  }
  const exact = isbnCoverUrl(isbn);
  const exists = exact ? await head(exact).catch(() => false) : false;
  if (exists) return { state: "different", message: "Open Library has a cover for this exact ISBN and it is not known to be this one. Compare it with the one shown.", catalogCover: exact };
  return { state: "none", message: "No cover exists for this exact ISBN, so the picture here came from somewhere else (probably the old title search). Replace it with your own photo or remove it.", catalogCover: null };
}

module.exports = { listCoversToCheck, checkCover, pictureId, PAGE_SIZE };
