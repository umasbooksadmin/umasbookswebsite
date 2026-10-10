// robots.txt, sitemap.xml and the per-page SEO locals for the marketing
// pages. Mounted in src/index.js BEFORE the session/CSRF middleware so a
// crawler fetching these never creates a session row.

const express = require("express");
const { pool } = require("../db");
const { baseUrl } = require("../lib/baseUrl");
const { isNonLive } = require("../lib/preview");
const { localize, seoLinks } = require("../lib/frUrls");

const router = express.Router();

const MARKETING_PAGES = require("../lib/marketingPages");

// Dynamic public pages worth indexing (besides "/" and the pages above).
const DYNAMIC_PAGES = ["/sessions", "/events", "/contact", "/request-a-book"];

const MAX_BOOK_URLS = 5000; // the sitemap protocol allows 50,000 per file
const SITEMAP_TTL_MS = 60 * 60 * 1000;

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

function buildSitemapXml(base, bookRows) {
  const urls = [];
  for (const p of ["/", ...MARKETING_PAGES.map((f) => "/" + f), ...DYNAMIC_PAGES]) urls.push(...sitemapEntry(base, p));
  for (const b of bookRows) {
    const lastmod = b.updated_at ? `<lastmod>${new Date(b.updated_at).toISOString()}</lastmod>` : "";
    urls.push(...sitemapEntry(base, `/books/${b.id}`, lastmod));
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join("\n")}\n</urlset>\n`;
}

let sitemapCache = null; // { base, at, xml }
function clearSitemapCache() { sitemapCache = null; }

router.get("/robots.txt", (req, res) => {
  // Preview mode: keep every crawler out (see lib/preview.js).
  if (isNonLive()) return res.set("Cache-Control", "no-cache").type("text/plain").send("User-agent: *\nDisallow: /\n");
  res.set("Cache-Control", "public, max-age=3600");
  res.type("text/plain").send(robotsTxt(safeBaseUrl(req)));
});

router.get("/sitemap.xml", async (req, res) => {
  if (isNonLive()) {
    return res.set("Cache-Control", "no-cache").type("application/xml").send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n`
    );
  }
  const base = safeBaseUrl(req);
  if (!base) return res.status(503).type("text/plain").send("Sitemap unavailable: base URL is not configured.");
  if (!sitemapCache || sitemapCache.base !== base || Date.now() - sitemapCache.at > SITEMAP_TTL_MS) {
    const { rows } = await pool.query(
      `SELECT b.id, b.updated_at
       FROM books b
       WHERE EXISTS (SELECT 1 FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock')
       ORDER BY b.id
       LIMIT $1`,
      [MAX_BOOK_URLS]
    );
    sitemapCache = { base, at: Date.now(), xml: buildSitemapXml(base, rows) };
  }
  res.set("Cache-Control", "public, max-age=3600");
  res.type("application/xml").send(sitemapCache.xml);
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
  buildSitemapXml,
  clearSitemapCache,
};
