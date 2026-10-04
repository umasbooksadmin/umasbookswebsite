// robots.txt, sitemap.xml and the per-page SEO locals for the marketing
// pages. Mounted in src/index.js BEFORE the session/CSRF middleware so a
// crawler fetching these never creates a session row.

const express = require("express");
const { pool } = require("../db");
const { baseUrl } = require("../lib/baseUrl");
const { isPreviewMode } = require("../lib/preview");

const router = express.Router();

const MARKETING_PAGES = require("../lib/marketingPages");

// Dynamic public pages worth indexing (besides "/" and the pages above).
const DYNAMIC_PAGES = ["/sessions", "/events"];

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

function buildSitemapXml(base, bookRows) {
  const urls = ["/", ...MARKETING_PAGES.map((f) => "/" + f), ...DYNAMIC_PAGES]
    .map((p) => `  <url><loc>${xmlEscape(base + p)}</loc></url>`);
  for (const b of bookRows) {
    const lastmod = b.updated_at ? `<lastmod>${new Date(b.updated_at).toISOString()}</lastmod>` : "";
    urls.push(`  <url><loc>${xmlEscape(`${base}/books/${b.id}`)}</loc>${lastmod}</url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

let sitemapCache = null; // { base, at, xml }
function clearSitemapCache() { sitemapCache = null; }

router.get("/robots.txt", (req, res) => {
  // Preview mode: keep every crawler out (see lib/preview.js).
  if (isPreviewMode()) return res.set("Cache-Control", "no-cache").type("text/plain").send("User-agent: *\nDisallow: /\n");
  res.set("Cache-Control", "public, max-age=3600");
  res.type("text/plain").send(robotsTxt(safeBaseUrl(req)));
});

router.get("/sitemap.xml", async (req, res) => {
  if (isPreviewMode()) {
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
}

module.exports = {
  router,
  MARKETING_PAGES,
  setMarketingSeoLocals,
  robotsTxt,
  buildSitemapXml,
  clearSitemapCache,
};
