// The pieces every public book-list JSON endpoint shares (routes/books.js: /api/books/search, /new-in, /by-ids;
// routes/collections.js: /api/collections/:slug/books), so a card drawn from any of them is the same card (public/ui.js bookCardHtml).
const { localCover } = require("./coverStore");
const { cardBuy } = require("./cardCart");

// The public JSON lists are the same for everyone (no session, no per-person data) and change slowly: a browser or the CDN
// may keep them a minute.
const PUBLIC_JSON_CACHE = "public, max-age=60, s-maxage=60";

// Public JSON, cross-origin (the cache header differs per route, so it is a parameter). Access-Control-Allow-Origin alone
// isn't enough: helmet sets a global Cross-Origin-Resource-Policy: same-origin, which blocks cross-origin reads
// independently of CORS unless relaxed here too. Only ever what is already publicly visible at /books/:id.
const publicJson = (cacheControl) => (req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  res.set("Cache-Control", cacheControl);
  next();
};

// The part of a book every public list shares (key order is part of the response: keep it).
const bookJson = (b) => ({
  id: b.id,
  title: b.title,
  author: b.authors,
  coverUrl: localCover(b.cover_url),
  price: b.min_price != null ? Number(b.min_price) : null,
  // The card's cart icon (lib/cardCart.js): null (none), { copyId } (adds that copy) or { choose: true } (opens the book page).
  buy: cardBuy(b.buy_copy_id),
});

module.exports = { PUBLIC_JSON_CACHE, publicJson, bookJson };
