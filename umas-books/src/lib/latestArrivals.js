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
// NEW_IN_DAYS days, but never fewer than the NEW_IN_MIN newest books (a quiet month still shows a shelf),
// and never more than NEW_IN_MAX. The carousel shows the first page of this list and "See All New In"
// pages through all of it, so the two can never disagree (before, "See all" asked for at most 24).
const NEW_IN_DAYS = 60;
const NEW_IN_MIN = 40;
const NEW_IN_MAX = 200;

async function newIn(pool, { offset = 0, limit = 24, days = NEW_IN_DAYS, min = NEW_IN_MIN, max = NEW_IN_MAX } = {}) {
  const { rows } = await pool.query(
    `SELECT b.id, b.title, b.authors, b.cover_url,
            (SELECT MIN(price) FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock') AS min_price,
            (SELECT MAX(c.created_at) FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock') AS newest_copy_at
     FROM books b
     WHERE EXISTS (SELECT 1 FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock')
     ORDER BY newest_copy_at DESC, b.id DESC
     LIMIT $1`,
    [max]
  );
  const cutoff = Date.now() - days * 86400000;
  const recent = rows.filter((r) => new Date(r.newest_copy_at).getTime() >= cutoff).length;
  const total = Math.min(rows.length, Math.max(recent, min));
  const start = Math.min(Math.max(offset, 0), total);
  const end = Math.min(start + Math.max(limit, 1), total);
  return { total, rows: rows.slice(start, end), nextOffset: end < total ? end : null };
}

module.exports = { latestArrivals, newIn, NEW_IN_DAYS, NEW_IN_MIN, NEW_IN_MAX };
