const express = require("express");
const { localCover } = require("../lib/coverStore");
const { pool } = require("../db");
const { CONDITIONS, bindingLabel, conditionLabel } = require("../lib/inventory");
const { expireStaleReservations } = require("../lib/reservations");
const { baseUrl } = require("../lib/baseUrl");
const { clean, parseId } = require("../lib/validation");
const { loadPublicAwards, awardsTextSql } = require("../lib/awards/display");

const { validateIdParams } = require("../middleware/idParams");
const { bookSearchLimiter } = require("../middleware/rateLimits");

const { latestArrivals, newInPage, BROWSE_CACHE_MS } = require("../lib/latestArrivals");
const { cachedFor, cachedByKey } = require("../lib/runLimited");
const { buildBookSeo } = require("../lib/bookSeo");
const router = express.Router();
// The public JSON lists below are the same for everyone (no session, no per-person data) and change slowly: a browser
// or the CDN may keep them a minute, and the server computes each at most once per BROWSE_CACHE_MS (45 s; off under
// NODE_ENV=test so tests see their own writes).
const PUBLIC_JSON_CACHE = "public, max-age=60, s-maxage=60";
const cacheTtl = () => (process.env.NODE_ENV === "test" ? 0 : BROWSE_CACHE_MS);
// latest-arrivals has a few hundred possible (limit, days) pairs: one cached list for each, at most 100 kept.
const latestArrivalsCached = cachedByKey((key) => {
  const [limit, days] = key.split(":").map(Number);
  return latestArrivals(pool, { limit, days });
}, cacheTtl, 100);
// Garbage ids get the 404 page, not a Postgres 22P02 and a 500.
validateIdParams(router, "id");

// Public — no login required. Anyone can search in-stock inventory; copies
// are paid for through the cart, or in the shop. There is deliberately no
// public "reserve" route: it let anyone hold copies under any email address
// (stock hoarding, mail to third parties). Holds are made by volunteers in
// the admin inventory, or by the book-request flow.
// The browse/search listing itself lives at /books.html (a static page
// backed by the /api/books/* endpoints below) — there's no server-rendered
// listing page anymore, just the detail route past this point.

// Logged-in people's favorites persist here too (see public/favorites.js),
// alongside the localStorage list every person already gets, so a member's
// favorites follow the account (data export, deletion). Guests get a silent
// no-op: favoriting stays client-only for them.
router.post("/api/favorites/toggle", async (req, res) => {
  if (!req.session.user) return res.status(204).end();
  const bookId = parseId(req.body.bookId);
  // public/favorites.js sends exactly "1" (add) or "" (remove). Boolean() of
  // any non-empty string — "false", "0" — would be true and add a favourite.
  const isFavorite = req.body.isFavorite === "1";
  if (bookId === null) return res.status(400).end();

  if (isFavorite) {
    // A well-formed id that matches no book is a 404, not a foreign-key
    // violation (a 500 and an alert email).
    const { rows: book } = await pool.query("SELECT 1 FROM books WHERE id = $1", [bookId]);
    if (!book.length) return res.status(404).end();
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
  res.set("Cache-Control", PUBLIC_JSON_CACHE);
  // ?limit= (1–24, default 8) and ?days= (default 7; 0 = no time window,
  // i.e. simply the newest in-stock books — used by the Books page's
  // "New In" shelf so it's never empty during a quiet week).
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 24);
  const daysParam = parseInt(req.query.days, 10);
  const days = Number.isInteger(daysParam) && daysParam >= 0 ? Math.min(daysParam, 365) : 7;
  const rows = await latestArrivalsCached(limit + ":" + days);
  res.json(
    rows.map((b) => ({
      id: b.id,
      title: b.title,
      author: b.authors,
      coverUrl: localCover(b.cover_url),
      price: b.min_price != null ? Number(b.min_price) : null,
      url: `${baseUrl(req)}/books/${b.id}`,
    }))
  );
});

// "New In" in batches: { total, books, nextOffset }. The Books page's carousel loads 60 at a time as the guest nears the
// end of what is loaded ("See All New In" asks for 24 at a time) until nextOffset is null, so every new book can be reached
// and no request is ever large. limit is 1-100 (default 24); an offset that is not a safe integer or is past the end gives
// an empty batch. Newest first by the time the copy was added. Not the search limiter: no text search, answered from one
// list kept in memory for 45 s (lib/latestArrivals.js newInPage). Anonymous-safe: nothing per person is in it.
router.get("/api/books/new-in", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  res.set("Cache-Control", PUBLIC_JSON_CACHE);
  const { total, rows, nextOffset } = await newInPage(pool, { offset: req.query.offset, limit: req.query.limit });
  res.json({
    total,
    nextOffset,
    books: rows.map((b) => ({
      id: b.id,
      title: b.title,
      author: b.authors,
      coverUrl: localCover(b.cover_url),
      price: b.min_price != null ? Number(b.min_price) : null,
      url: `${baseUrl(req)}/books/${b.id}`,
    })),
  });
});

// Public JSON, cross-origin — consumed by the marketing site's Books
// page so it can show real in-stock results inline instead of just
// linking out to the shop. Same CORS treatment as
// /api/books/latest-arrivals.
// Public JSON, cross-origin — the list of in-stock genres for the
// marketing site's genre chips. Same CORS treatment as the other
// /api/books/* endpoints on this page.
const genreList = cachedFor(async () => {
  const { rows } = await pool.query(
    `SELECT DISTINCT trim(g) AS genre
     FROM books b, unnest(string_to_array(b.categories, ',')) AS g
     WHERE b.categories IS NOT NULL AND b.categories <> '' AND trim(g) <> ''
       AND EXISTS (SELECT 1 FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock')
     ORDER BY genre ASC`
  );
  return rows.map((r) => r.genre);
}, cacheTtl);
router.get("/api/books/genres", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  res.set("Cache-Control", "public, max-age=300, s-maxage=300");
  res.json(await genreList());
});

// A free-text search shorter than this matches nearly everything and cannot use the
// trigram indexes (migrations/088): answered with an empty list without touching the database.
const SEARCH_MIN_LENGTH = 2;
// The description is only searched from this length: shorter text (pg_trgm needs 3 characters)
// would scan every description of the catalogue.
const SEARCH_DESCRIPTION_MIN_LENGTH = 3;

router.get("/api/books/search", bookSearchLimiter, async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  res.set("Cache-Control", "public, max-age=60");
  // clean(): capped, and an array (?q=a&q=b) can't reach .trim() and 500.
  const q = clean(req.query.q, 100);
  const genre = clean(req.query.genre, 100);
  // ?topic=mystery,thriller,crime — the Books page's fixed genre buttons.
  // Matches any in-stock book whose categories contain one of the words,
  // since real inventory categories are free text (from ISBN lookups).
  const topics = String(req.query.topic || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10);

  // ?paged=1 (the Books page): { books, total, nextOffset }, ?offset= and ?limit= (1-48, default 24), "Show more" 24 at a
  // time until nextOffset is null, so every book of a genre or search can be reached. Without it: the plain array, 60 books.
  const paged = req.query.paged === "1";
  const limit = paged ? Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 48) : 60;
  const offset = paged ? Math.max(parseInt(req.query.offset, 10) || 0, 0) : 0;
  if (q && q.length < SEARCH_MIN_LENGTH) return res.json(paged ? { books: [], total: 0, nextOffset: null } : []);

  const clauses = ["c.status = 'in_stock'"];
  const params = [];
  if (q) {
    params.push(`%${q}%`);
    const n = params.length;
    params.push(q.replace(/[^0-9Xx]/g, ""));
    const isbn = params.length;
    clauses.push(
      // title, author, keyword (the book's description) or genre (categories)
      `(b.title ILIKE $${n} OR b.authors ILIKE $${n}${q.length >= SEARCH_DESCRIPTION_MIN_LENGTH ? ` OR b.description ILIKE $${n}` : ""} OR b.categories ILIKE $${n}` +
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
            (SELECT MIN(price) FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock') AS min_price,
            ${awardsTextSql("b.id")} AS awards,
            (SELECT array_agg(DISTINCT c.condition) FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock') AS conditions,
            b.binding,
            EXISTS (SELECT 1 FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock' AND c.is_clearance) AS clearance,
            count(*) OVER () AS total
     FROM books b
     WHERE EXISTS (SELECT 1 FROM book_copies c WHERE c.book_id = b.id AND ${clauses.join(" AND ")})
     ORDER BY b.title_sort, b.title, b.id LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  let total = rows.length ? Number(rows[0].total) : 0;
  if (paged && !rows.length && offset > 0) {
    // a page past the end: the total is still the total
    const r = await pool.query(`SELECT count(*)::int AS n FROM books b WHERE EXISTS (SELECT 1 FROM book_copies c WHERE c.book_id = b.id AND ${clauses.join(" AND ")})`, params);
    total = r.rows[0].n;
  }
  const list = rows.map((b) => ({
      id: b.id,
      title: b.title,
      author: b.authors,
      coverUrl: localCover(b.cover_url),
      price: b.min_price != null ? Number(b.min_price) : null,
      awards: b.awards || "",
      // Grades of the copies on the shelf, best first (value + label in the visitor's language).
      conditions: CONDITIONS.filter((c) => (b.conditions || []).includes(c.value)).map((c) => ({ value: c.value, label: conditionLabel(c.value, req.lang) })),
      binding: b.binding || null,
      bindingLabel: bindingLabel(b.binding, req.lang),
      clearance: b.clearance === true,
      url: `${baseUrl(req)}/books/${b.id}`,
    }));
  if (!paged) return res.json(list);
  const end = offset + list.length;
  res.json({ books: list, total, nextOffset: end < total ? end : null });
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
      coverUrl: localCover(b.cover_url),
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
  book.cover_url = localCover(book.cover_url); // only ever our own copy (lib/coverStore.js)

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
       ORDER BY b.title_sort, b.title, b.id LIMIT 6`,
      [book.authors, id]
    );
    moreByAuthor = rows.map((r) => ({ ...r, cover_url: localCover(r.cover_url) }));
  }

  // Link previews and search results: description, cover as an absolute URL,
  // schema.org Book + Offer (src/lib/bookSeo.js; read by partials/header.ejs).
  const seo = buildBookSeo({ book, copies, base: res.locals.siteUrl, lang: req.lang, tr: req.tr });

  res.render("book_detail", {
    description: seo.description,
    ogImage: seo.ogImage || undefined,
    ogType: "book",
    jsonLd: seo.jsonLd,
    book,
    copies,
    awards: await loadPublicAwards(pool, id),
    conditions: CONDITIONS,
    bindingLabel: bindingLabel(book.binding, req.lang),
    backGenre: (req.query.genre || "").trim(),
    moreByAuthor,
  });
});

module.exports = router;
