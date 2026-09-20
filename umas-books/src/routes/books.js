const express = require("express");
const { pool } = require("../db");

const router = express.Router();

// Public — no login required. Anyone can search in-stock inventory and
// reserve a specific copy for pickup (payment happens in person).

router.get("/books", async (req, res) => {
  const q = (req.query.q || "").trim();
  const genre = (req.query.genre || "").trim();

  const clauses = ["c.status = 'in_stock'"];
  const params = [];
  if (q) {
    params.push(`%${q}%`);
    clauses.push(`(b.title ILIKE $${params.length} OR b.authors ILIKE $${params.length})`);
  }
  if (genre) {
    params.push(`%${genre}%`);
    clauses.push(`b.categories ILIKE $${params.length}`);
  }

  const { rows: books } = await pool.query(
    `SELECT b.* FROM books b
     WHERE EXISTS (SELECT 1 FROM book_copies c WHERE c.book_id = b.id AND ${clauses.join(" AND ")})
     ORDER BY b.title ASC LIMIT 60`,
    params
  );

  const bookIds = books.map((b) => b.id);
  const { rows: copyRows } = bookIds.length
    ? await pool.query(
        "SELECT * FROM book_copies WHERE book_id = ANY($1) AND status = 'in_stock' ORDER BY price ASC NULLS LAST",
        [bookIds]
      )
    : { rows: [] };

  const copiesByBook = {};
  for (const c of copyRows) {
    if (!copiesByBook[c.book_id]) copiesByBook[c.book_id] = [];
    copiesByBook[c.book_id].push(c);
  }

  res.render("books", { books, copiesByBook, q, genre });
});

router.post("/books/copies/:copyId/reserve", async (req, res) => {
  const copyId = Number(req.params.copyId);
  const name = (req.body.name || "").trim();
  const email = (req.body.email || "").trim().toLowerCase();
  const phone = (req.body.phone || "").trim() || null;
  const params = new URLSearchParams();
  if (req.body.q) params.set("q", req.body.q);
  if (req.body.genre) params.set("genre", req.body.genre);
  const redirectUrl = params.toString() ? `/books?${params.toString()}` : "/books";

  if (!name || !email) return res.redirect(redirectUrl);

  await pool.query(
    `UPDATE book_copies SET status = 'reserved', reserved_by_name = $1, reserved_by_email = $2,
            reserved_by_phone = $3, reserved_at = now(), updated_at = now()
     WHERE id = $4 AND status = 'in_stock'`,
    [name, email, phone, copyId]
  );
  res.redirect(redirectUrl);
});

module.exports = router;
