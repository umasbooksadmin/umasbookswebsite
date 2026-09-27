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
  res.set("Cache-Control", "no-store");

  const { rows } = await pool.query(
    `SELECT slug, title, excerpt, body, category, image_url, published_at
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
    }))
  );
});

module.exports = router;
