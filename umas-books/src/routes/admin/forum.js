const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { clean, parseId } = require("../../lib/validation");
const { MAX_NOTE, isReason, packReason, sendStatementOfReasons } = require("../../lib/forumModeration");

const router = express.Router();

// The thread page (routes/forum.js) shows the admin-only Hide / Restore
// controls that post here. Hiding keeps the text in the row.

async function loadTarget(kind, id) {
  const { rows } = kind === "thread"
    ? await pool.query("SELECT id, id AS thread_id, title, body, author_id, hidden_at FROM forum_threads WHERE id = $1", [id])
    : await pool.query("SELECT id, thread_id, body, author_id, hidden_at FROM forum_replies WHERE id = $1", [id]);
  return rows[0] ? { ...rows[0], kind } : null;
}

function parseTarget(req) {
  const kind = req.body.kind === "thread" || req.body.kind === "reply" ? req.body.kind : null;
  const id = parseId(String(req.body.id || ""));
  return kind && id !== null ? { kind, id } : null;
}

const table = (kind) => (kind === "thread" ? "forum_threads" : "forum_replies");

router.post("/admin/forum/hide", requireAdmin, async (req, res) => {
  const parsed = parseTarget(req);
  if (!parsed) return res.status(404).render("404");
  const code = String(req.body.reason || "");
  if (!isReason(code)) return res.status(400).type("text/plain").send("Please choose a reason.");
  const note = clean(req.body.note, MAX_NOTE);

  const target = await loadTarget(parsed.kind, parsed.id);
  if (!target) return res.status(404).render("404");

  // Already hidden: nothing to do (and no second email to the author).
  if (!target.hidden_at) {
    await pool.query(
      `UPDATE ${table(parsed.kind)} SET hidden_at = now(), hidden_reason = $2, hidden_by = $3 WHERE id = $1`,
      [parsed.id, packReason(code, note), req.session.user.id]
    );
    // Only the kind and the reason code: never the post text or the note.
    await audit(req, { action: "forum.hide", targetType: `forum_${parsed.kind}`, targetId: parsed.id, detail: `${parsed.kind} ${code}` });
    await sendStatementOfReasons(pool, target, code, note);
  }
  res.redirect(`/forum/${target.thread_id}`);
});

router.post("/admin/forum/restore", requireAdmin, async (req, res) => {
  const parsed = parseTarget(req);
  if (!parsed) return res.status(404).render("404");
  const target = await loadTarget(parsed.kind, parsed.id);
  if (!target) return res.status(404).render("404");

  if (target.hidden_at) {
    await pool.query(
      `UPDATE ${table(parsed.kind)} SET hidden_at = NULL, hidden_reason = NULL, hidden_by = NULL WHERE id = $1`,
      [parsed.id]
    );
    await audit(req, { action: "forum.restore", targetType: `forum_${parsed.kind}`, targetId: parsed.id, detail: parsed.kind });
  }
  res.redirect(`/forum/${target.thread_id}`);
});

module.exports = router;
