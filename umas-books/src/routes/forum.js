const express = require("express");
const { pool } = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/forum", requireAuth, async (req, res) => {
  const { rows: threads } = await pool.query(
    `SELECT t.*, u.display_name AS author_name,
            (SELECT COUNT(*) FROM forum_replies r WHERE r.thread_id = t.id) AS reply_count
     FROM forum_threads t LEFT JOIN users u ON u.id = t.author_id
     ORDER BY t.created_at DESC`
  );
  res.render("forum_list", { threads });
});

router.get("/forum/new", requireAuth, (req, res) => {
  res.render("forum_new", { error: null });
});

router.post("/forum/new", requireAuth, async (req, res) => {
  const title = (req.body.title || "").trim();
  const body = (req.body.body || "").trim();
  if (!title || !body) {
    return res.status(400).render("forum_new", { error: "Title and message are both required." });
  }
  const { rows } = await pool.query(
    "INSERT INTO forum_threads (title, body, author_id) VALUES ($1, $2, $3) RETURNING id",
    [title, body, req.session.user.id]
  );
  res.redirect(`/forum/${rows[0].id}`);
});

router.get("/forum/:id", requireAuth, async (req, res) => {
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

router.post("/forum/:id/replies", requireAuth, async (req, res) => {
  const threadId = Number(req.params.id);
  const body = (req.body.body || "").trim();
  if (!body) return res.redirect(`/forum/${threadId}`);
  await pool.query(
    "INSERT INTO forum_replies (thread_id, body, author_id) VALUES ($1, $2, $3)",
    [threadId, body, req.session.user.id]
  );
  res.redirect(`/forum/${threadId}`);
});

module.exports = router;
