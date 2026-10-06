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

module.exports = { latestArrivals };
