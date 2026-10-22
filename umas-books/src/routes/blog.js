const express = require("express");
const { pool } = require("../db");
const { sanitizeHtml } = require("../lib/sanitizeHtml");
const { parisDateString } = require("../lib/tz");

const router = express.Router();

// Public JSON, cross-origin — same CORS treatment as /api/events/upcoming
// and /api/books/latest-arrivals. Consumed by assets/blog-live.js on the
// static marketing pages (blog.html, index.html's "What's New" slider),
// which populate window.UMAS_POSTS from this instead of a hand-edited
// file — see migrations/027_blog_redesign.sql for the one-time import of
// what used to live in assets/posts.js.
// Defence in depth: bodies are sanitised when they are WRITTEN (routes/admin/blog.js), and again
// here when they are SERVED, so a row that got into the table another way (an import, a migration,
// a hand-run SQL fix) can never put script or event handlers on the public pages. Sanitising is
// about 0.3 ms for a 6 KB post (1 ms for 24 KB); the result is remembered by body text so a busy
// feed costs nothing after the first request (bounded: cleared when it grows past 300 bodies).
const SANITISED = new Map();
function safeBody(body) {
  const raw = String(body || "");
  let out = SANITISED.get(raw);
  if (out === undefined) {
    if (SANITISED.size >= 300) SANITISED.clear();
    out = sanitizeHtml(raw);
    SANITISED.set(raw, out);
  }
  return out;
}

// The list is light: no bodies (a post's body is fetched on demand from /api/blog/posts/:slug), and
// one page of FEED_PAGE posts at a time (?offset=N for the next page; ?limit=N up to FEED_MAX).
const FEED_PAGE = 24;
const FEED_MAX = 100;

function setFeedHeaders(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  // Public and identical for every person, so safe to cache; 5 minutes
  // keeps a newly published post from lingering long.
  res.set("Cache-Control", "public, max-age=300");
  // An admin's own preview (?preview=1): every post including drafts and
  // scheduled ones, so the real blog page can show them before they go public.
  // Anyone else asking for it just gets the public list. Never cached.
  const u = req.session && req.session.user;
  const adminPreview = req.query.preview === "1" && Boolean(u && u.isAdmin);
  if (adminPreview) res.set("Cache-Control", "no-store");
  return adminPreview;
}

function shapePost(p, adminPreview, withBody) {
  return {
    slug: p.slug,
    title: p.title,
    excerpt: p.excerpt || "",
    ...(withBody ? { body: safeBody(p.body) } : {}),
    category: p.category || undefined,
    image: p.image_url || undefined,
    date: parisDateString(p.published_at), // the Paris calendar day, not the UTC one
    ...(adminPreview ? { status: p.status, live: p.status === "published" && p.published_at <= new Date() } : {}),
  };
}

router.get("/api/blog/posts", async (req, res) => {
  const adminPreview = setFeedHeaders(req, res);
  const limit = Math.min(FEED_MAX, Math.max(1, Math.floor(Number(req.query.limit)) || FEED_PAGE));
  const offset = Math.min(100000, Math.max(0, Math.floor(Number(req.query.offset)) || 0));

  const { rows } = await pool.query(
    adminPreview
      ? `SELECT slug, title, excerpt, category, image_url, status,
                COALESCE(published_at, created_at) AS published_at
         FROM blog_posts ORDER BY COALESCE(published_at, created_at) DESC, id DESC LIMIT $1 OFFSET $2`
      : `SELECT slug, title, excerpt, category, image_url, published_at
         FROM blog_posts
         WHERE status = 'published' AND published_at <= now()
         ORDER BY published_at DESC, id DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  res.json(rows.map((p) => shapePost(p, adminPreview, false)));
});

// One post with its body. Same visibility rules as the list: only published posts, or any post
// for an admin's preview.
router.get("/api/blog/posts/:slug", async (req, res) => {
  const adminPreview = setFeedHeaders(req, res);
  const { rows } = await pool.query(
    adminPreview
      ? `SELECT slug, title, excerpt, body, category, image_url, status,
                COALESCE(published_at, created_at) AS published_at
         FROM blog_posts WHERE slug = $1`
      : `SELECT slug, title, excerpt, body, category, image_url, published_at
         FROM blog_posts WHERE slug = $1 AND status = 'published' AND published_at <= now()`,
    [String(req.params.slug).slice(0, 200)]
  );
  if (!rows[0]) {
    res.set("Cache-Control", "no-store");
    return res.status(404).json({ error: "not_found" });
  }
  res.json(shapePost(rows[0], adminPreview, true));
});

module.exports = router;
