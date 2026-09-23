const express = require("express");
const { pool } = require("../db");
const { CONDITIONS } = require("../lib/inventory");
const { expireStaleReservations } = require("../lib/reservations");
const { sendMail } = require("../mailer");

const router = express.Router();

// Public — no login required. Anyone can search in-stock inventory and
// reserve a specific copy for pickup (payment happens in person).

function conditionLabel(value) {
  return (CONDITIONS.find((c) => c.value === value) || {}).label || value;
}

router.get("/books", async (req, res) => {
  await expireStaleReservations(pool);
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

// Public JSON, cross-origin — consumed by the marketing site's "Latest
// Arrivals" section (a different origin, e.g. umasbooks.org), so this
// specific endpoint opts back into CORS even though the rest of the app
// is same-origin only. Only ever returns what's already publicly visible
// at /books (title, author, cover, price) — nothing sensitive.
router.get("/api/books/latest-arrivals", async (req, res) => {
  // Access-Control-Allow-Origin alone isn't enough — helmet sets a global
  // Cross-Origin-Resource-Policy: same-origin, which blocks cross-origin
  // reads independently of CORS unless relaxed here too.
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  const { rows } = await pool.query(
    `SELECT b.id, b.title, b.authors, b.cover_url,
            (SELECT MIN(price) FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock') AS min_price,
            (SELECT MAX(c.created_at) FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock') AS newest_copy_at
     FROM books b
     WHERE EXISTS (
       SELECT 1 FROM book_copies c
       WHERE c.book_id = b.id AND c.status = 'in_stock' AND c.created_at >= now() - interval '7 days'
     )
     ORDER BY newest_copy_at DESC
     LIMIT 8`
  );
  res.json(
    rows.map((b) => ({
      id: b.id,
      title: b.title,
      author: b.authors,
      coverUrl: b.cover_url,
      price: b.min_price != null ? Number(b.min_price) : null,
      url: `https://umas-books.onrender.com/books/${b.id}`,
    }))
  );
});

// Favorites live entirely client-side (localStorage — see public/favorites.js),
// so this page just renders a shell; the list itself is fetched below by id.
router.get("/favorites", (req, res) => {
  res.render("favorites");
});

// Public JSON, same-origin only (the favorites page's own fetch) — no
// CORS relaxation needed, unlike /api/books/latest-arrivals which the
// marketing site calls cross-origin.
router.get("/api/books/by-ids", async (req, res) => {
  const ids = String(req.query.ids || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return res.json([]);

  const { rows } = await pool.query(
    `SELECT b.id, b.title, b.authors, b.cover_url,
            (SELECT MIN(price) FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock') AS min_price,
            (SELECT COUNT(*) FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock')::int AS in_stock_count
     FROM books b WHERE b.id = ANY($1::int[])`,
    [ids]
  );
  res.json(
    rows.map((b) => ({
      id: b.id,
      title: b.title,
      author: b.authors,
      coverUrl: b.cover_url,
      price: b.min_price != null ? Number(b.min_price) : null,
      inStockCount: b.in_stock_count,
      url: `/books/${b.id}`,
    }))
  );
});

router.get("/books/:id", async (req, res) => {
  await expireStaleReservations(pool);
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

  const { rows } = await pool.query(
    `UPDATE book_copies SET status = 'reserved', reserved_by_name = $1, reserved_by_email = $2,
            reserved_by_phone = $3, reserved_at = now(), updated_at = now()
     WHERE id = $4 AND book_id = $5 AND status = 'in_stock'
     RETURNING id`,
    [name, email, phone, copyId, bookId]
  );

  if (rows.length) {
    const { rows: bookRows } = await pool.query("SELECT title FROM books WHERE id = $1", [bookId]);
    const title = bookRows[0] && bookRows[0].title;
    sendMail({
      to: email,
      subject: `You've reserved "${title}" at Uma's Books`,
      text: `Hi ${name},\n\nWe've set aside your copy of "${title}" — come by Uma's Books within the next 2 weeks to pick it up and pay in the shop. We'll send you a reminder a few days before the hold expires.\n\nUma's Books\nRue Peyroliere, 81000 Albi`,
    }).catch((err) => console.error("Reservation confirmation email failed:", err.message));
  }

  res.redirect(redirectUrl);
});

module.exports = router;
