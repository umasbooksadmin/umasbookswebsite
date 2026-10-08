const express = require("express");
const { pool } = require("../db");

const router = express.Router();

// Public JSON, cross-origin — same CORS treatment as /api/events/upcoming
// and /api/books/latest-arrivals. Consumed by assets/blog-live.js on the
// static marketing pages (blog.html, index.html's "What's New" slider),
// which populate window.UMAS_POSTS from this instead of a hand-edited
// file — see migrations/027_blog_redesign.sql for the one-time import of
// what used to live in assets/posts.js.
router.get("/api/blog/posts", async (req, res) => {
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

  const { rows } = await pool.query(
    adminPreview
      ? `SELECT slug, title, excerpt, body, category, image_url, status,
                COALESCE(published_at, created_at) AS published_at
         FROM blog_posts ORDER BY COALESCE(published_at, created_at) DESC LIMIT 100`
      : `SELECT slug, title, excerpt, body, category, image_url, published_at
         FROM blog_posts
         WHERE status = 'published' AND published_at <= now()
         ORDER BY published_at DESC LIMIT 100`
  );

  res.json(
    rows.map((p) => ({
      slug: p.slug,
      title: p.title,
      excerpt: p.excerpt || "",
      body: p.body,
      category: p.category || undefined,
      image: p.image_url || undefined,
      date: p.published_at.toISOString().slice(0, 10),
      ...(adminPreview ? { status: p.status, live: p.status === "published" && p.published_at <= new Date() } : {}),
    }))
  );
});

module.exports = router;
