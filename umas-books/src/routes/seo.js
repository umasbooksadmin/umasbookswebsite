// robots.txt, sitemap.xml and the per-page SEO locals for the marketing
// pages. Mounted in src/index.js BEFORE the session/CSRF middleware so a
// crawler fetching these never creates a session row.

const express = require("express");
const config = require("../lib/config");
const { pool } = require("../db");
const { baseUrl } = require("../lib/baseUrl");
const { listSitemapCollections } = require("../lib/collections");
const { isNonLive } = require("../lib/preview");
const { localize, seoLinks } = require("../lib/frUrls");
const { cachedByKey } = require("../lib/runLimited");
const blogPosts = require("../lib/blogPosts");

const router = express.Router();

const MARKETING_PAGES = require("../lib/marketingPages");

// Dynamic public pages worth indexing (besides "/" and the pages above).
const DYNAMIC_PAGES = ["/sessions", "/events", "/contact", "/request-a-book"];

// The sitemap protocol allows 50,000 URLs and 50 MB (uncompressed) per file. Every book is listed twice (English and
// French address), each with three hreflang alternates: about 1 KB per book, so 20,000 URLs (10,000 books) is about
// 10 MB, well inside both limits. /sitemap.xml is an INDEX pointing at /sitemap-pages.xml and
// /sitemap-blog.xml (the published blog posts) and /sitemap-books-1.xml, -2.xml, ... (newest books first), so the number of books is not capped.
const MAX_URLS_PER_FILE = 20000;
const URLS_PER_BOOK = 2;
// SITEMAP_BOOKS_PER_FILE exists only so tests can exercise several files without inserting thousands of books.
function booksPerFile() {
  return Math.min(config.get("SITEMAP_BOOKS_PER_FILE"), MAX_URLS_PER_FILE / URLS_PER_BOOK);
}
const SITEMAP_TTL_MS = 60 * 60 * 1000;
const IN_STOCK = "EXISTS (SELECT 1 FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock')";
const URLSET_OPEN = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n`;

// baseUrl() throws in production when neither APP_BASE_URL nor
// RENDER_EXTERNAL_URL is set (it will not trust the Host header there).
// A crawler-facing file or a page's <head> must not 500 over that.
function safeBaseUrl(req) {
  try {
    return String(baseUrl(req)).replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function robotsTxt(base) {
  const lines = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /admin",
    "Disallow: /account",
    "Disallow: /cart",
    "Disallow: /login",
    "Disallow: /signup",
    "Disallow: /api/",
  ];
  if (base) lines.push("", `Sitemap: ${base}/sitemap.xml`);
  return lines.join("\n") + "\n";
}

// Every public page is listed twice, at its English and its French address
// (/fr/...), each entry carrying the full set of alternates (hreflang en, fr and
// x-default = English), as Google asks for.
function sitemapEntry(base, path, lastmod) {
  const en = base + path;
  const fr = base + localize(path);
  const links = [["en", en], ["fr", fr], ["x-default", en]]
    .map(([lang, href]) => `<xhtml:link rel="alternate" hreflang="${lang}" href="${xmlEscape(href)}"/>`).join("");
  return [en, fr].map((loc) => `  <url><loc>${xmlEscape(loc)}</loc>${lastmod || ""}${links}</url>`);
}

const HOME_PATH = "/";
const FIXED_PAGES = [HOME_PATH].concat(MARKETING_PAGES.map((f) => `/${f}`), DYNAMIC_PAGES);

function urlsetXml(urls) {
  return `${URLSET_OPEN}${urls.length ? urls.join("\n") + "\n" : ""}</urlset>\n`;
}

// The static pages and the PUBLISHED curated collections that still have a book to show (lib/collections.js).
function buildPagesSitemapXml(base, collectionRows = []) {
  const urls = [];
  for (const p of FIXED_PAGES) urls.push(...sitemapEntry(base, p));
  for (const c of collectionRows) urls.push(...sitemapEntry(base, `/collections/${c.slug}`));
  return urlsetXml(urls);
}

function buildBooksSitemapXml(base, bookRows) {
  const urls = [];
  for (const b of bookRows) {
    const lastmod = b.updated_at ? `<lastmod>${new Date(b.updated_at).toISOString()}</lastmod>` : "";
    urls.push(...sitemapEntry(base, `/books/${b.id}`, lastmod));
  }
  return urlsetXml(urls);
}

// Published blog posts (lib/blogPosts.js): one entry for the English address, and a second one for the French address
// only when the post has a READY French text (otherwise /fr/blog/<slug> shows English under a canonical pointing at the
// English address, so it is not listed). Alternates (hreflang) are listed only for versions that exist. lastmod = updated_at.
function buildBlogSitemapXml(base, postRows) {
  const urls = [];
  for (const p of postRows) {
    const lastmod = p.updated_at ? `<lastmod>${new Date(p.updated_at).toISOString()}</lastmod>` : "";
    const path = `/blog/${p.slug}`;
    if (blogPosts.frenchState(p) === "ready") {
      urls.push(...sitemapEntry(base, path, lastmod));
    } else {
      const en = base + path;
      const link = `<xhtml:link rel="alternate" hreflang="en" href="${xmlEscape(en)}"/><xhtml:link rel="alternate" hreflang="x-default" href="${xmlEscape(en)}"/>`;
      urls.push(`  <url><loc>${xmlEscape(en)}</loc>${lastmod}${link}</url>`);
    }
  }
  return urlsetXml(urls);
}

function buildSitemapIndexXml(base, bookFiles) {
  const names = ["sitemap-pages.xml", "sitemap-blog.xml"];
  for (let i = 1; i <= bookFiles; i++) names.push(`sitemap-books-${i}.xml`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    names.map((n) => `  <sitemap><loc>${xmlEscape(`${base}/${n}`)}</loc></sitemap>`).join("\n") + `\n</sitemapindex>\n`;
}

async function countInStockBooks() {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM books b WHERE ${IN_STOCK}`);
  return rows[0].n;
}

// One cached value per file for an hour (cachedByKey also bounds how many are kept). Key: "<base>|<name>".
// Values: the XML text, or null for a book file that does not exist (past the last one).
const sitemapCache = cachedByKey(async (key) => {
  const sep = key.indexOf("|");
  const base = key.slice(0, sep);
  const name = key.slice(sep + 1);
  if (name === "index") return buildSitemapIndexXml(base, Math.ceil((await countInStockBooks()) / booksPerFile()));
  if (name === "pages") return buildPagesSitemapXml(base, await listSitemapCollections(pool));
  if (name === "blog") return buildBlogSitemapXml(base, await blogPosts.listForSitemap(pool, MAX_URLS_PER_FILE / URLS_PER_BOOK));
  const n = Number(name);
  const per = booksPerFile();
  // Newest first, so a new book always lands in file 1 and never falls off the end; id breaks ties for a stable order.
  const { rows } = await pool.query(
    `SELECT b.id, b.updated_at
     FROM books b
     WHERE ${IN_STOCK}
     ORDER BY b.created_at DESC, b.id DESC
     LIMIT $1 OFFSET $2`,
    [per, (n - 1) * per]
  );
  return rows.length ? buildBooksSitemapXml(base, rows) : null;
}, SITEMAP_TTL_MS, 10);
function clearSitemapCache() { sitemapCache.clear(); }

router.get("/robots.txt", (req, res) => {
  // Preview mode: keep every crawler out (see lib/preview.js).
  if (isNonLive()) return res.set("Cache-Control", "no-cache").type("text/plain").send("User-agent: *\nDisallow: /\n");
  res.set("Cache-Control", "public, max-age=3600");
  res.type("text/plain").send(robotsTxt(safeBaseUrl(req)));
});

// Serves one sitemap file. In preview/staging every one of them is an empty urlset (nothing to index); without a
// base URL none is served (503), as before.
async function sendSitemap(req, res, name) {
  if (isNonLive()) {
    return res.set("Cache-Control", "no-cache").type("application/xml").send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n`
    );
  }
  const base = safeBaseUrl(req);
  if (!base) return res.status(503).type("text/plain").send("Sitemap unavailable: base URL is not configured.");
  const xml = await sitemapCache(`${base}|${name}`);
  if (xml == null) return res.status(404).end();
  res.set("Cache-Control", "public, max-age=3600");
  res.type("application/xml").send(xml);
}

router.get("/sitemap.xml", (req, res) => sendSitemap(req, res, "index"));
router.get("/sitemap-pages.xml", (req, res) => sendSitemap(req, res, "pages"));
router.get("/sitemap-blog.xml", (req, res) => sendSitemap(req, res, "blog"));
router.get("/sitemap-books-:n.xml", (req, res) => {
  if (!/^[1-9]\d{0,5}$/.test(req.params.n)) return res.status(404).end();
  return sendSitemap(req, res, req.params.n);
});

// Sets the locals views/marketing/partials/mkt_header.ejs reads for the
// canonical link, Open Graph URL and image.
function setMarketingSeoLocals(req, res, pagePath) {
  res.locals.siteUrl = safeBaseUrl(req);
  res.locals.canonicalPath = pagePath;
  res.locals.seoUrls = () => seoLinks(res.locals.siteUrl, res.locals.canonicalPath, res.locals.lang);
}

// Members-only areas: their pages keep "Members" in the title and are not
// advertised to search engines (see views/partials/header.ejs).
const MEMBERS_AREA = /^\/(dashboard|forum|charity|meetings|announcements|admin)(\/|$)/;

// Runs for every app-rendered page (after the language middleware): the
// <head> reads siteUrl (absolute base, '' when unknown), canonicalPath (the
// path WITHOUT its query string, so ?genre= / ?month= variants share one
// canonical URL) and membersArea.
function seoLocals(req, res, next) {
  res.locals.siteUrl = safeBaseUrl(req);
  res.locals.canonicalPath = req.path;
  res.locals.membersArea = MEMBERS_AREA.test(req.path);
  // <head> links: the canonical URL in the page's own language and the hreflang
  // alternates (lib/frUrls.js). req.path is the page's own path: a /fr/ request
  // has already had its prefix stripped by the language middleware.
  res.locals.seoUrls = () => seoLinks(res.locals.siteUrl, res.locals.canonicalPath, res.locals.lang);
  next();
}

module.exports = {
  seoLocals,
  router,
  MARKETING_PAGES,
  setMarketingSeoLocals,
  robotsTxt,
  buildPagesSitemapXml,
  buildBooksSitemapXml,
  buildBlogSitemapXml,
  buildSitemapIndexXml,
  clearSitemapCache,
};
