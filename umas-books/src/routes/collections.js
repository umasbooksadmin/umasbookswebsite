// Public curated-collection pages: /collections/<slug> (English) and /fr/collections/<slug> (French; the language
// middleware strips the /fr/ prefix, see lib/frUrls.js). Only collections an admin has published are found: an
// unpublished or unknown slug is an ordinary 404. The books shown are the approved ones that are in stock RIGHT NOW
// (lib/collections.js), so a sold book leaves the page by itself. Server-rendered: no JavaScript needed.
const express = require("express");
const { pool } = require("../db");
const { getPublishedCollection, approvedInStockBooks, localized } = require("../lib/collections");
const { renderMarketing } = require("../lib/pageDictionary");
const { setMarketingSeoLocals } = require("./seo");
const { coverSrcset, variantUrl } = require("../lib/imageVariants");

// A stored banner: the 600 px copy for a phone, the full 1600 px file for a computer. Anything else: no srcset.
const bannerSrcset = (url) => (/^\/img\/[0-9a-f]{64}\.jpg$/.test(url || "") ? `${variantUrl(url, 600)} 600w, ${url} 1600w` : "");

// marketingCsp: the relaxed policy the marketing pages carry (src/index.js builds it).
function createCollectionsRouter({ marketingCsp }) {
  const router = express.Router();

  router.get("/collections/:slug", async (req, res, next) => {
    const collection = await getPublishedCollection(pool, req.params.slug);
    if (!collection) return res.status(404).render("404");
    const books = await approvedInStockBooks(pool, collection.id);
    const { title, description, bannerAlt } = localized(collection, req.lang);
    res.set("Content-Security-Policy", marketingCsp);
    setMarketingSeoLocals(req, res, `/collections/${collection.slug}`);
    Object.assign(res.locals, { collection, collectionTitle: title, collectionDescription: description, bannerAlt, books, coverSrcset, bannerSrcset });
    renderMarketing(req, res, next, "marketing/collection");
  });

  return router;
}

module.exports = { createCollectionsRouter };
