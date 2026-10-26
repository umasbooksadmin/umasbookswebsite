// Public curated-collection pages: /collections/<slug> (English) and /fr/collections/<slug> (French; the language
// middleware strips the /fr/ prefix, see lib/frUrls.js). Only collections an admin has published are found: an
// unpublished or unknown slug is an ordinary 404. The books shown are the approved ones that are in stock RIGHT NOW
// (lib/collections.js), so a sold book leaves the page by itself. The list is the Browse genre results: the first 24 books are
// in the HTML (no JavaScript needed to see them, search engines read them), "Show more" (public/page-collection.js) fetches the
// next 24 at a time from /api/collections/:slug/books, the same JSON shape as /api/books/new-in.
const express = require("express");
const { pool } = require("../db");
const { getPublishedCollection, approvedInStockBooks, countApprovedInStock, COLLECTION_PAGE_SIZE, localized } = require("../lib/collections");
const { publicJson, bookJson, PUBLIC_JSON_CACHE } = require("../lib/publicBookJson");
const { baseUrl } = require("../lib/baseUrl");
const { parseIntParam, parseLimitParam } = require("../lib/parseParams");
const { renderMarketing } = require("../lib/pageDictionary");
const { setMarketingSeoLocals } = require("./seo");
const { coverSrcset, variantUrl } = require("../lib/imageVariants");

// A stored banner: the 600 px copy for a phone, the full 1600 px file for a computer. Anything else: no srcset.
const bannerSrcset = (url) => (/^\/img\/[0-9a-f]{64}\.jpg$/.test(url || "") ? `${variantUrl(url, 600)} 600w, ${url} 1600w` : "");

// No collection is this deep; a bigger ?offset= is clamped to it (an empty page).
const COLLECTION_MAX_OFFSET = 100000;

// marketingCsp: the relaxed policy the marketing pages carry (src/index.js builds it).
function createCollectionsRouter({ marketingCsp }) {
  const router = express.Router();

  router.get("/collections/:slug", async (req, res, next) => {
    const collection = await getPublishedCollection(pool, req.params.slug);
    if (!collection) return res.status(404).render("404");
    const [books, total] = await Promise.all([
      approvedInStockBooks(pool, collection.id, { offset: 0, limit: COLLECTION_PAGE_SIZE }),
      countApprovedInStock(pool, collection.id),
    ]);
    const { title, description, bannerAlt } = localized(collection, req.lang);
    res.set("Content-Security-Policy", marketingCsp);
    setMarketingSeoLocals(req, res, `/collections/${collection.slug}`);
    Object.assign(res.locals, { collection, collectionTitle: title, collectionDescription: description, bannerAlt, books, moreOffset: total > books.length ? books.length : null, coverSrcset, bannerSrcset });
    renderMarketing(req, res, next, "marketing/collection");
  });

  // The next books of a published collection: { total, nextOffset, books } like /api/books/new-in. ?offset= (0 up to
  // COLLECTION_MAX_OFFSET, larger is clamped: an empty page) and ?limit= (1-48, default 24). Unknown or unpublished slug: 404.
  // Same order as the page, the books in stock right now. Public, the same for everyone, cached a minute like new-in.
  router.get("/api/collections/:slug/books", publicJson(PUBLIC_JSON_CACHE), async (req, res) => {
    const collection = await getPublishedCollection(pool, req.params.slug);
    if (!collection) {
      res.set("Cache-Control", "no-store"); // publishing it a moment later must not be hidden by a cached 404
      return res.status(404).end();
    }
    const limit = parseLimitParam(req.query.limit, { max: 48, default: COLLECTION_PAGE_SIZE });
    const offset = parseIntParam(req.query.offset, { min: 0, max: COLLECTION_MAX_OFFSET, default: 0 });
    const [rows, total] = await Promise.all([approvedInStockBooks(pool, collection.id, { offset, limit }), countApprovedInStock(pool, collection.id)]);
    const end = offset + rows.length;
    res.json({
      total,
      nextOffset: rows.length && end < total ? end : null,
      books: rows.map((b) => ({ ...bookJson(b), url: `${baseUrl(req)}/books/${b.id}` })),
    });
  });

  return router;
}

module.exports = { createCollectionsRouter };
