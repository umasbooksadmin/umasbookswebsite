// What customers may see: only 'verified' rows from Wikidata, the NYT API or
// an admin's own typing. Any other row is never shown. Awards first, then shortlists, then lists; newest
// year first within each.

const SHOWN_STATUSES = ["verified"];
const SHOWN_SOURCES = ["wikidata", "nyt", "manual"];

const KIND_ORDER_SQL = "CASE kind WHEN 'award' THEN 0 WHEN 'shortlist' THEN 1 ELSE 2 END";
const ORDER_SQL = `${KIND_ORDER_SQL}, year DESC NULLS LAST, lower(label)`;

function formatAward(row) {
  return row.year ? `${row.label} (${row.year})` : row.label;
}

// -> ['Hugo Award for Best Novel (1990)', ...]
async function loadPublicAwards(pool, bookId) {
  const { rows } = await pool.query(
    `SELECT label, year FROM book_awards
     WHERE book_id = $1 AND status = ANY($2) AND source = ANY($3)
     ORDER BY ${ORDER_SQL}`,
    [bookId, SHOWN_STATUSES, SHOWN_SOURCES]
  );
  return rows.map(formatAward);
}

// SQL expression (one correlated subquery) for a short comma-separated text
// of the top three, for lists of books such as /api/books/search.
// `bookRef` is the book id expression, e.g. "b.id".
function awardsTextSql(bookRef) {
  return `(SELECT string_agg(CASE WHEN a.year IS NULL THEN a.label ELSE a.label || ' (' || a.year || ')' END, ', '
                  ORDER BY a.ord)
           FROM (SELECT label, year, row_number() OVER (ORDER BY ${ORDER_SQL}) AS ord
                 FROM book_awards WHERE book_id = ${bookRef} AND status = 'verified' AND source IN ('wikidata', 'nyt', 'manual')) a
           WHERE a.ord <= 3)`;
}

module.exports = { SHOWN_STATUSES, SHOWN_SOURCES, ORDER_SQL, formatAward, loadPublicAwards, awardsTextSql };
