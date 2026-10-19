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

module.exports = { latestArrivals, newIn, NEW_IN_DAYS, NEW_IN_MIN };
