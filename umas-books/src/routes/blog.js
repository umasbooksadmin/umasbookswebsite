const express = require("express");
const { pool } = require("../db");
const blogPosts = require("../lib/blogPosts");

const router = express.Router();

// Public JSON, cross-origin — same CORS treatment as /api/events/upcoming and /api/books/new-in. Consumed by
// assets/blog-live.js for the home page's "What's New" slider; the blog pages themselves are rendered by the server
// (routes/blogPages.js) from the same lib/blogPosts.js, so the two can never disagree about what is public.
// ?lang=fr asks for the French text where a post has a READY French version; every post says which language its text
// is in (`lang`), so a page can label an English fallback.

// The list is light: no bodies (a post's body is fetched on demand from /api/blog/posts/:slug), and
// one page of PAGE_SIZE posts at a time (?offset=N for the next page; ?limit=N up to MAX_PAGE_SIZE).
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

router.get("/api/blog/posts", async (req, res) => {
  const adminPreview = setFeedHeaders(req, res);
  const lang = blogPosts.normLang(req.query.lang);
  const limit = Math.min(blogPosts.MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(req.query.limit)) || blogPosts.PAGE_SIZE));
  const offset = Math.min(100000, Math.max(0, Math.floor(Number(req.query.offset)) || 0));
  const rows = await blogPosts.listPosts(pool, { adminPreview, limit, offset });
  res.json(rows.map((p) => blogPosts.shapePost(p, lang, { adminPreview })));
});

// One post with its body. Same visibility rules as the list: only published posts, or any post
// for an admin's preview.
router.get("/api/blog/posts/:slug", async (req, res) => {
  const adminPreview = setFeedHeaders(req, res);
  const row = await blogPosts.getPost(pool, req.params.slug, { adminPreview });
  if (!row) {
    res.set("Cache-Control", "no-store");
    return res.status(404).json({ error: "not_found" });
  }
  res.json(blogPosts.shapePost(row, blogPosts.normLang(req.query.lang), { adminPreview, withBody: true }));
});

module.exports = router;
