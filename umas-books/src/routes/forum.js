const express = require("express");
const { pool } = require("../db");
const { requireMember } = require("../middleware/auth");
const { forumPostLimiter, forumReplyLimiter } = require("../middleware/rateLimits");
const { clean } = require("../lib/validation");

const { validateIdParams } = require("../middleware/idParams");

const router = express.Router();
// Garbage ids get the 404 page, not a Postgres 22P02 and a 500.
validateIdParams(router, "id");

const MAX_THREAD_TITLE = 200;
const MAX_POST_BODY = 5000;

router.get("/forum", requireMember, async (req, res) => {
  const { rows: threads } = await pool.query(
    `SELECT t.*, u.display_name AS author_name,
            (SELECT COUNT(*) FROM forum_replies r WHERE r.thread_id = t.id) AS reply_count
     FROM forum_threads t LEFT JOIN users u ON u.id = t.author_id
     ORDER BY t.created_at DESC`
  );
  res.render("forum_list", { threads });
});

router.get("/forum/new", requireMember, (req, res) => {
  res.render("forum_new", { error: null });
});

router.post("/forum/new", requireMember, forumPostLimiter, async (req, res) => {
  const title = clean(req.body.title, MAX_THREAD_TITLE);
  const body = clean(req.body.body, MAX_POST_BODY);
  if (!title || !body) {
    return res.status(400).render("forum_new", { error: "Title and message are both required." });
  }
  const { rows } = await pool.query(
    "INSERT INTO forum_threads (title, body, author_id) VALUES ($1, $2, $3) RETURNING id",
    [title, body, req.session.user.id]
  );
  res.redirect(`/forum/${rows[0].id}`);
});

router.get("/forum/:id", requireMember, async (req, res) => {
  const threadId = Number(req.params.id);
  const { rows: threadRows } = await pool.query(
    `SELECT t.*, u.display_name AS author_name FROM forum_threads t
     LEFT JOIN users u ON u.id = t.author_id WHERE t.id = $1`,
    [threadId]
  );
  if (!threadRows.length) return res.status(404).send("Thread not found.");

  const { rows: replies } = await pool.query(
    `SELECT r.*, u.display_name AS author_name FROM forum_replies r
     LEFT JOIN users u ON u.id = r.author_id WHERE r.thread_id = $1 ORDER BY r.created_at ASC`,
    [threadId]
  );

  res.render("forum_thread", { thread: threadRows[0], replies, error: null });
});

router.post("/forum/:id/replies", requireMember, forumReplyLimiter, async (req, res) => {
  const threadId = Number(req.params.id);
  const body = clean(req.body.body, MAX_POST_BODY);
  if (!body) return res.redirect(`/forum/${threadId}`);
  try {
    await pool.query(
      "INSERT INTO forum_replies (thread_id, body, author_id) VALUES ($1, $2, $3)",
      [threadId, body, req.session.user.id]
    );
  } catch (err) {
    // A well-formed id for a thread that doesn't exist (foreign key).
    if (err.code === "23503") return res.status(404).render("404");
    throw err;
  }
  res.redirect(`/forum/${threadId}`);
});

module.exports = router;
