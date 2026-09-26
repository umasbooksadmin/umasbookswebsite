const express = require("express");
const { pool } = require("../db");
const { CONDITIONS } = require("../lib/inventory");
const { expireStaleReservations } = require("../lib/reservations");
const { sendMail } = require("../mailer");
const { baseUrl } = require("../lib/baseUrl");

const router = express.Router();

// Public — no login required. Anyone can search in-stock inventory and
// reserve a specific copy for pickup (payment happens in person).
// The browse/search listing itself lives at /books.html (a static page
// backed by the /api/books/* endpoints below) — there's no server-rendered
// listing page anymore, just the detail/reserve route past this point.

function conditionLabel(value) {
  return (CONDITIONS.find((c) => c.value === value) || {}).label || value;
}

// Logged-in visitors' favorites persist here too (see public/favorites.js),
// alongside the localStorage list every visitor already gets — this is
// what lets /api/books/recommendation draw its weekly pick from real
// member favorites. Anonymous visitors get a silent no-op: favoriting
// stays client-only for them, same as before this existed.
router.post("/api/favorites/toggle", async (req, res) => {
  if (!req.session.user) return res.status(204).end();
  const bookId = Number(req.body.bookId);
  const isFavorite = Boolean(req.body.isFavorite);
  if (!bookId) return res.status(400).end();

  if (isFavorite) {
    await pool.query(
      "INSERT INTO favorites (user_id, book_id) VALUES ($1, $2) ON CONFLICT (user_id, book_id) DO NOTHING",
      [req.session.user.id, bookId]
    );
  } else {
    await pool.query("DELETE FROM favorites WHERE user_id = $1 AND book_id = $2", [req.session.user.id, bookId]);
  }
  res.status(204).end();
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
  // ?limit= (1–24, default 8) and ?days= (default 7; 0 = no time window,
  // i.e. simply the newest in-stock books — used by the Books page's
  // "New In" shelf so it's never empty during a quiet week).
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 24);
  const daysParam = parseInt(req.query.days, 10);
  const days = Number.isInteger(daysParam) && daysParam >= 0 ? Math.min(daysParam, 365) : 7;
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
    days > 0 ? [limit, days] : [limit]
  );
  res.json(
    rows.map((b) => ({
      id: b.id,
      title: b.title,
      author: b.authors,
      coverUrl: b.cover_url,
      price: b.min_price != null ? Number(b.min_price) : null,
      url: `${baseUrl(req)}/books/${b.id}`,
    }))
  );
});

// Public JSON, cross-origin — the marketing site's "Recommendation of
// the Week" band. Drawn from books a member or admin has favorited (see
// POST /api/favorites/toggle below), not hand-curated — same eligibility
// as the /books page's own "Recommended for You". Picks deterministically
// per ISO week (every request during the same week gets the same book,
// so it doesn't change on every page load) rather than fully at random,
// by hashing each candidate with the current year+week and taking the
// smallest hash — a new pick "at random" each week without needing any
// stored state. Same CORS treatment as /api/books/latest-arrivals.
router.get("/api/books/recommendation", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT b.id, b.title, b.authors, b.cover_url, b.description, b.description_fr
       FROM favorites f
       JOIN users u ON u.id = f.user_id AND (u.is_member = true OR u.is_admin = true)
       JOIN books b ON b.id = f.book_id
       WHERE EXISTS (SELECT 1 FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock')
     ) AS candidates
     ORDER BY md5(id::text || to_char(now(), 'IYYY-IW'))
     LIMIT 1`
  );
  const b = rows[0];
  if (!b) return res.json(null);
  res.json({
    id: b.id,
    title: b.title,
    author: b.authors,
    coverUrl: b.cover_url,
    blurb: { en: b.description || "", fr: b.description_fr || b.description || "" },
    url: `${baseUrl(req)}/books/${b.id}`,
  });
});

// Public JSON, cross-origin — consumed by the marketing site's Books
// page so it can show real in-stock results inline instead of just
// linking out to the shop. Same CORS treatment as
// /api/books/latest-arrivals.
// Public JSON, cross-origin — the list of in-stock genres for the
// marketing site's genre chips. Same CORS treatment as the other
// /api/books/* endpoints on this page.
router.get("/api/books/genres", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  const { rows } = await pool.query(
    `SELECT DISTINCT trim(g) AS genre
     FROM books b, unnest(string_to_array(b.categories, ',')) AS g
     WHERE b.categories IS NOT NULL AND b.categories <> '' AND trim(g) <> ''
       AND EXISTS (SELECT 1 FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock')
     ORDER BY genre ASC`
  );
  res.json(rows.map((r) => r.genre));
});

router.get("/api/books/search", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  const q = (req.query.q || "").trim();
  const genre = (req.query.genre || "").trim();
  // ?topic=mystery,thriller,crime — the Books page's fixed genre buttons.
  // Matches any in-stock book whose categories contain one of the words,
  // since real inventory categories are free text (from ISBN lookups).
  const topics = String(req.query.topic || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10);

  const clauses = ["c.status = 'in_stock'"];
  const params = [];
  if (q) {
    params.push(`%${q}%`);
    const n = params.length;
    params.push(q.replace(/[^0-9Xx]/g, ""));
    const isbn = params.length;
    clauses.push(
      // title, author, keyword (the book's description) or genre (categories)
      `(b.title ILIKE $${n} OR b.authors ILIKE $${n} OR b.description ILIKE $${n} OR b.categories ILIKE $${n}` +
        ` OR ($${isbn} <> '' AND length($${isbn}) >= 10 AND regexp_replace(COALESCE(b.isbn, ''), '[^0-9Xx]', '', 'g') = $${isbn}))`
    );
  }
  if (genre) {
    params.push(genre);
    clauses.push(`EXISTS (SELECT 1 FROM unnest(string_to_array(b.categories, ',')) AS g WHERE trim(g) = $${params.length})`);
  }
  if (topics.length) {
    const ors = topics.map((t) => {
      params.push(`%${t}%`);
      const p = params.length;
      // Plain "fiction" is also a substring of "Non-fiction", so the
      // Fiction genre button would otherwise pull in non-fiction books
      // too (and, symmetrically, "science" as a Non-fiction keyword
      // matched "Science Fiction" — dropped above rather than excluded
      // here, since nothing in the taxonomy is tagged just "Science").
      if (t.toLowerCase() === "fiction") {
        return `(b.categories ILIKE $${p} AND b.categories NOT ILIKE '%non-fiction%' AND b.categories NOT ILIKE '%nonfiction%')`;
      }
      return `b.categories ILIKE $${p}`;
    });
    clauses.push(`(${ors.join(" OR ")})`);
  }

  const { rows } = await pool.query(
    `SELECT b.id, b.title, b.authors, b.cover_url,
            (SELECT MIN(price) FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock') AS min_price
     FROM books b
     WHERE EXISTS (SELECT 1 FROM book_copies c WHERE c.book_id = b.id AND ${clauses.join(" AND ")})
     ORDER BY b.title ASC LIMIT 60`,
    params
  );
  res.json(
    rows.map((b) => ({
      id: b.id,
      title: b.title,
      author: b.authors,
      coverUrl: b.cover_url,
      price: b.min_price != null ? Number(b.min_price) : null,
      url: `${baseUrl(req)}/books/${b.id}`,
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

  let moreByAuthor = [];
  if (book.authors) {
    const { rows } = await pool.query(
      `SELECT b.id, b.title, b.cover_url,
              (SELECT MIN(price) FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock') AS min_price
       FROM books b
       WHERE b.authors = $1 AND b.id != $2
         AND EXISTS (SELECT 1 FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock')
       ORDER BY b.title ASC LIMIT 6`,
      [book.authors, id]
    );
    moreByAuthor = rows;
  }

  res.render("book_detail", {
    book,
    copies,
    conditionLabel,
    backGenre: (req.query.genre || "").trim(),
    moreByAuthor,
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
