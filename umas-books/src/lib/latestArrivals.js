const { cachedFor } = require("./runLimited");

// The newest in-stock books, shared by GET /api/books/latest-arrivals and the
// no-JavaScript list on /books.html (see routes/books.js, index.js).
async function latestArrivals(pool, { limit = 8, days = 7 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 8, 1), 24);
  const windowClause = days > 0 ? "AND c.created_at >= now() - make_interval(days => $2)" : "";
  const { rows } = await pool.query(
    `SELECT b.id, b.title, b.authors, b.cover_url,
            (SELECT MIN(price) FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock') AS min_price,
            (SELECT MAX(c.created_at) FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock') AS newest_copy_at
     FROM books b
     WHERE EXISTS (
       SELECT 1 FROM book_copies c
       WHERE c.book_id = b.id AND c.status = 'in_stock' ${windowClause}
     )
     ORDER BY newest_copy_at DESC
     LIMIT $1`,
    days > 0 ? [lim, days] : [lim]
  );
  return rows;
}

// "New In" as the Browse Books page defines it: every book with an in-stock copy added in the last
// NEW_IN_DAYS days, but never fewer than the NEW_IN_MIN newest books (a quiet month still shows a shelf).
// There is no maximum. The carousel shows ALL of this list and "See All New In" pages through the same list,
// so the two can never disagree.
//
// Order: newest first by the exact moment the copy was added to inventory (book_copies.created_at, a timestamp;
// never acquired_at, which is only a DATE), ties broken by copy id, highest first. A book with several in-stock
// copies counts at its most recent copy. One query; idx_book_copies_status_created (migration 046) covers the scan.
// limit = null returns everything from offset on. total is always returned, even for an empty page.
const NEW_IN_DAYS = 60;
const NEW_IN_MIN = 40;

async function newIn(pool, { offset = 0, limit = 24, days = NEW_IN_DAYS, min = NEW_IN_MIN } = {}) {
  const off = Math.max(Number(offset) || 0, 0);
  const lim = limit == null ? null : Math.max(Number(limit) || 1, 1);
  const { rows } = await pool.query(
    `WITH per_book AS (
       SELECT b.id, b.title, b.authors, b.cover_url,
              MIN(c.price) AS min_price,
              MAX(c.created_at) AS newest_copy_at,
              (array_agg(c.id ORDER BY c.created_at DESC, c.id DESC))[1] AS newest_copy_id
       FROM books b
       JOIN book_copies c ON c.book_id = b.id AND c.status = 'in_stock'
       GROUP BY b.id
     ), ranked AS (
       SELECT p.*,
              row_number() OVER (ORDER BY p.newest_copy_at DESC, p.newest_copy_id DESC) AS rn,
              count(*) OVER () AS n_all,
              count(*) FILTER (WHERE p.newest_copy_at >= now() - make_interval(days => $1::int)) OVER () AS n_recent
       FROM per_book p
     ), tot AS (
       SELECT COALESCE(MAX(LEAST(n_all, GREATEST(n_recent, $2::bigint))), 0) AS total FROM ranked
     )
     SELECT tot.total, r.id, r.title, r.authors, r.cover_url, r.min_price, r.newest_copy_at, r.newest_copy_id
     FROM tot
     LEFT JOIN ranked r ON r.rn > $3::bigint AND r.rn <= tot.total
                        AND ($4::bigint IS NULL OR r.rn <= $3::bigint + $4::bigint)
     ORDER BY r.rn`,
    [days, min, off, lim]
  );
  const total = rows.length ? Number(rows[0].total) : 0;
  const page = rows.filter((r) => r.id != null);
  const end = off + page.length;
  return { total, rows: page, nextOffset: end < total ? end : null };
}

// ---- The public API pages: New In in batches, from ONE cached copy of the whole list -------------------------------
// The whole list (id, title, authors, cover, price: a few hundred bytes a book) is read from the database at most once
// every BROWSE_CACHE_MS per process and sliced in memory, so a crowd opening Browse Books, or a client varying ?offset=
// on purpose, costs one query a minute, not one per request. A new book shows up within that time (the JSON is
// also cacheable for 60 s by browsers and the CDN, so this adds no visible delay).
const BROWSE_CACHE_MS = 45 * 1000;
// The integration and e2e tests add books and read the page straight away (they run the real app with NODE_ENV=test):
// no sharing there. Unit tests of the cache pass a clock to cachedFor instead.
const cacheMs = () => (process.env.NODE_ENV === "test" ? 0 : BROWSE_CACHE_MS);
const NEW_IN_MAX_LIMIT = 100;     // most books in one response
const NEW_IN_MAX_OFFSET = 100000; // further than this is simply "past the end"
const wholeLists = new WeakMap(); // pool -> cachedFor(whole New In list)

function newInWhole(pool) {
  let get = wholeLists.get(pool);
  if (!get) {
    get = cachedFor(() => newIn(pool, { limit: null }), cacheMs);
    wholeLists.set(pool, get);
  }
  return get();
}

// One batch of New In: { total, rows, nextOffset }. Clamps what a client sends: limit 1..NEW_IN_MAX_LIMIT (default 24);
// an offset that is not a safe integer or is past NEW_IN_MAX_OFFSET (or the end) gives an empty batch, never an error.
async function newInPage(pool, { offset = 0, limit = 24 } = {}) {
  const lim = Math.min(Math.max(Math.trunc(Number(limit)) || 24, 1), NEW_IN_MAX_LIMIT);
  const offNum = Number(offset);
  const off = Number.isNaN(offNum) ? 0 : Math.max(offNum, 0); // Infinity stays, and is "past the end" below
  const whole = await newInWhole(pool);
  if (off > NEW_IN_MAX_OFFSET || off >= whole.total) {
    return { total: whole.total, rows: [], nextOffset: null };
  }
  const start = Math.trunc(off);
  const rows = whole.rows.slice(start, start + lim);
  const end = start + rows.length;
  return { total: whole.total, rows, nextOffset: end < whole.total ? end : null };
}

// Tests that change the books and read the page again call this; production relies on the time limit.
function clearBrowseCaches(pool) {
  if (pool) wholeLists.delete(pool);
}

module.exports = { latestArrivals, newIn, newInPage, clearBrowseCaches, NEW_IN_DAYS, NEW_IN_MIN, NEW_IN_MAX_LIMIT, NEW_IN_MAX_OFFSET, BROWSE_CACHE_MS };
