const express = require("express");
const { pool } = require("../db");
const { CONDITIONS } = require("../lib/inventory");

const router = express.Router();

// Public — no login required. Anyone can search in-stock inventory and
// reserve a specific copy for pickup (payment happens in person).

function conditionLabel(value) {
  return (CONDITIONS.find((c) => c.value === value) || {}).label || value;
}

router.get("/books", async (req, res) => {
  const q = (req.query.q || "").trim();
  const genre = (req.query.genre || "").trim();

  const { rows: genreRows } = await pool.query(
    `SELECT DISTINCT b.categories FROM books b
     WHERE b.categories IS NOT NULL AND b.categories <> ''
       AND EXISTS (SELECT 1 FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock')
     ORDER BY b.categories ASC`
  );
  const genres = genreRows.map((r) => r.categories);

  const clauses = ["c.status = 'in_stock'"];
  const params = [];
  if (q) {
    params.push(`%${q}%`);
    clauses.push(`(b.title ILIKE $${params.length} OR b.authors ILIKE $${params.length})`);
  }
  if (genre) {
    params.push(genre);
    clauses.push(`b.categories = $${params.length}`);
  }

  const { rows: books } = await pool.query(
    `SELECT b.*,
            (SELECT COUNT(*) FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock')::int AS in_stock_count,
            (SELECT MIN(price) FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock') AS min_price
     FROM books b
     WHERE EXISTS (SELECT 1 FROM book_copies c WHERE c.book_id = b.id AND ${clauses.join(" AND ")})
     ORDER BY b.title ASC LIMIT 60`,
    params
  );

  res.render("books", { books, q, genre, genres });
});

router.get("/books/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { rows: bookRows } = await pool.query("SELECT * FROM books WHERE id = $1", [id]);
  const book = bookRows[0];
  if (!book) return res.status(404).render("404");

  const { rows: copies } = await pool.query(
    "SELECT * FROM book_copies WHERE book_id = $1 AND status = 'in_stock' ORDER BY price ASC NULLS LAST",
    [id]
  );

  res.render("book_detail", {
    book,
    copies,
    conditionLabel,
    backGenre: (req.query.genre || "").trim(),
  });
});

router.post("/books/:id/reserve", async (req, res) => {
  const bookId = Number(req.params.id);
  const copyId = Number(req.body.copyId);
  const name = (req.body.name || "").trim();
  const email = (req.body.email || "").trim().toLowerCase();
  const phone = (req.body.phone || "").trim() || null;
  const redirectUrl = `/books/${bookId}`;

  if (!name || !email || !copyId) return res.redirect(redirectUrl);

  await pool.query(
    `UPDATE book_copies SET status = 'reserved', reserved_by_name = $1, reserved_by_email = $2,
            reserved_by_phone = $3, reserved_at = now(), updated_at = now()
     WHERE id = $4 AND book_id = $5 AND status = 'in_stock'`,
    [name, email, phone, copyId, bookId]
  );
  res.redirect(redirectUrl);
});

module.exports = router;
