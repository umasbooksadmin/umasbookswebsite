const express = require("express");
const { localCover } = require("../lib/coverStore");
const { publicJson, bookJson, PUBLIC_JSON_CACHE } = require("../lib/publicBookJson");
const { pool } = require("../db");
const { CONDITIONS, bindingLabel, conditionLabel } = require("../lib/inventory");
const { expireStaleReservationsThrottled } = require("../lib/reservations");
const { baseUrl } = require("../lib/baseUrl");
const { clean, parseId } = require("../lib/validation");
const { parseIntParam, parseLimitParam, parseIdList, likeContains } = require("../lib/parseParams");
const { loadPublicAwards, awardsTextSql } = require("../lib/awards/display");

const { validateIdParams } = require("../middleware/idParams");
const { bookSearchLimiter } = require("../middleware/rateLimits");

const { newInPage } = require("../lib/latestArrivals");
const { BUY_COPY_SQL, BUY_FROM_SQL, cardBuy, setCardCartLocals } = require("../lib/cardCart");
const { buildBookSeo, bookPageTitle } = require("../lib/bookSeo");
const router = express.Router();
// The public JSON lists below are the same for everyone (no session, no per-person data) and change slowly: a browser
// or the CDN may keep them a minute (new-in is also kept in memory for 45 s by lib/latestArrivals.js newInPage).
// publicJson, PUBLIC_JSON_CACHE and bookJson are shared with the collection page list (lib/publicBookJson.js).
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

// Signing in merges the browser's favourites (localStorage, kept for signed-out visitors too) into the account, once
// per login session: public/favorites.js posts its saved ids here when /api/session says favoritesMerge (set until this
// runs), and gets back the account's whole list, which it adds to the browser's. Unknown book ids are skipped; at most
// 200 ids. Signed out: 204, nothing stored.
router.post("/api/favorites/merge", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!req.session.user) return res.status(204).end();
  const ids = parseIdList(String(req.body.ids || ""));
  if (ids.length) {
    await pool.query(
      `INSERT INTO favorites (user_id, book_id)
       SELECT $1, b.id FROM books b WHERE b.id = ANY($2::int[])
       ON CONFLICT (user_id, book_id) DO NOTHING`,
      [req.session.user.id, ids]
    );
  }
  const { rows } = await pool.query("SELECT book_id FROM favorites WHERE user_id = $1 ORDER BY book_id LIMIT 1000", [req.session.user.id]);
  req.session.favoritesMerged = true;
  res.json({ ids: rows.map((r) => r.book_id) });
});

// "New In" in batches: { total, books, nextOffset }. The Books page's carousel loads 60 at a time as the guest nears the
// end of what is loaded ("See All New In" asks for 24 at a time) until nextOffset is null, so every new book can be reached
// and no request is ever large. limit is 1-100 (default 24); an offset that is not a safe integer or is past the end gives
// an empty batch. Newest first by the time the copy was added. Not the search limiter: no text search, answered from one
// list kept in memory for 45 s (lib/latestArrivals.js newInPage). Anonymous-safe: nothing per person is in it.
router.get("/api/books/new-in", publicJson(PUBLIC_JSON_CACHE), async (req, res) => {
  const { total, rows, nextOffset } = await newInPage(pool, { offset: req.query.offset, limit: req.query.limit });
  res.json({
    total,
    nextOffset,
    books: rows.map((b) => ({ ...bookJson(b), url: `${baseUrl(req)}/books/${b.id}` })),
  });
});

// A free-text search shorter than this matches nearly everything and cannot use the
// trigram indexes (migrations/088): answered with an empty list without touching the database.
const SEARCH_MIN_LENGTH = 2;
// No real catalogue is this deep; a bigger ?offset= is clamped to it (an empty page).
const SEARCH_MAX_OFFSET = 100000;
// The description is only searched from this length: shorter text (pg_trgm needs 3 characters)
// would scan every description of the catalogue.
const SEARCH_DESCRIPTION_MIN_LENGTH = 3;

router.get("/api/books/search", bookSearchLimiter, publicJson("public, max-age=60"), async (req, res) => {
  // clean(): capped, and an array (?q=a&q=b) can't reach .trim() and 500.
  const q = clean(req.query.q, 100);
  const genre = clean(req.query.genre, 100);
  // ?topic=mystery,thriller,crime — the Books page's fixed genre buttons.
  // Matches any in-stock book whose categories contain one of the words,
  // since real inventory categories are free text (from ISBN lookups).
  const topics = clean(req.query.topic, 300)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10);

  // ?paged=1 (the Books page): { books, total, nextOffset }, ?offset= and ?limit= (1-48, default 24), "Show more" 24 at a
  // time until nextOffset is null, so every book of a genre or search can be reached. Without it: the plain array, 60 books.
  const paged = req.query.paged === "1";
  // offset is clamped to SEARCH_MAX_OFFSET: it is printed into the SQL, so it must be a small safe integer.
  const limit = paged ? parseLimitParam(req.query.limit, { max: 48, default: 24 }) : 60;
  const offset = paged ? parseIntParam(req.query.offset, { min: 0, max: SEARCH_MAX_OFFSET, default: 0 }) : 0;
  if (q && q.length < SEARCH_MIN_LENGTH) return res.json(paged ? { books: [], total: 0, nextOffset: null } : []);

  const clauses = ["c.status = 'in_stock'"];
  const params = [];
  if (q) {
    params.push(likeContains(q));
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
      params.push(likeContains(t));
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
            ${BUY_COPY_SQL("b.id")} AS buy_copy_id,
            ${BUY_FROM_SQL("b.id")} AS buy_from_price,
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
      ...bookJson(b),
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
  res.render("favorites"); // per-user page: head carries noindex, follow
});

// Public JSON, same-origin only (the favorites page's own fetch) — no
// CORS relaxation needed, unlike /api/books/search and
// /api/books/new-in, which are cross-origin.
router.get("/api/books/by-ids", async (req, res) => {
  // Valid int4 ids only (anything else is dropped: it could never match, and an id past 2^31 would make Postgres refuse the query).
  const ids = parseIdList(req.query.ids);
  if (!ids.length) return res.json([]);

  const { rows } = await pool.query(
    `SELECT b.id, b.title, b.authors, b.cover_url,
            (SELECT MIN(price) FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock') AS min_price,
            (SELECT COUNT(*) FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock')::int AS in_stock_count,
            ${BUY_COPY_SQL("b.id")} AS buy_copy_id,
            ${BUY_FROM_SQL("b.id")} AS buy_from_price
     FROM books b WHERE b.id = ANY($1::int[])`,
    [ids]
  );
  res.json(
    rows.map((b) => ({
      ...bookJson(b),
      inStockCount: b.in_stock_count,
      url: `/books/${b.id}`,
    }))
  );
});

router.get("/books/:id", async (req, res) => {
  await expireStaleReservationsThrottled(pool); // read-only view: at most one sweep per 30 s per process
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
              (SELECT MIN(price) FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock') AS min_price,
              ${BUY_COPY_SQL("b.id")} AS buy_copy_id,
            ${BUY_FROM_SQL("b.id")} AS buy_from_price
       FROM books b
       WHERE b.authors = $1 AND b.id != $2
         AND EXISTS (SELECT 1 FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock')
       ORDER BY b.title_sort, b.title, b.id LIMIT 6`,
      [book.authors, id]
    );
    // buy: the "More by" card's cart icon (lib/cardCart.js)
    moreByAuthor = rows.map((r) => ({ ...r, cover_url: localCover(r.cover_url), buy: cardBuy(r.buy_copy_id, r.buy_from_price) }));
  }
  // This page already prints a CSRF token for every visitor (the copy table's Add to Cart forms), so its card icons
  // are real POST forms for guests too, and show "in your cart" from the session.
  await setCardCartLocals(pool, req, res, { personal: true });

  // Link previews and search results: description, cover as an absolute URL,
  // schema.org Book + Offer (src/lib/bookSeo.js; read by partials/header.ejs).
  const seo = buildBookSeo({ book, copies, base: res.locals.siteUrl, lang: req.lang, tr: req.tr });

  res.render("book_detail", {
    fullTitle: bookPageTitle(book, req.lang),
    description: seo.description,
    ogImage: seo.ogImage || undefined,
    ogType: "book",
    jsonLd: seo.jsonLd,
    book,
    copies,
    awards: await loadPublicAwards(pool, id),
    conditions: CONDITIONS,
    bindingLabel: bindingLabel(book.binding, req.lang),
    backGenre: clean(req.query.genre, 100),
    moreByAuthor,
  });
});

module.exports = router;
