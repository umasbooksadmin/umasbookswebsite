const express = require("express");
const { pool } = require("../db");
const { requireMember } = require("../middleware/auth");
const { forumPostLimiter, forumReplyLimiter, limit } = require("../middleware/rateLimits");
const { clean, parseId, emailSafeName } = require("../lib/validation");
const { sendEmail } = require("../lib/outbox");
const { baseUrl } = require("../lib/baseUrl");
const { unpackReason } = require("../lib/forumModeration");

const { validateIdParams } = require("../middleware/idParams");

const router = express.Router();
// Garbage ids get the 404 page, not a Postgres 22P02 and a 500.
validateIdParams(router, "id");

const MAX_THREAD_TITLE = 200;
const MAX_POST_BODY = 5000;
const MAX_REPORT_COMMENT = 1000;
const REPORT_EXCERPT = 300;

// Same destination as the contact form and the error alerts.
const REPORT_TO = process.env.CONTACT_TO || "admin@umasbooks.org";

const REPORT_REASONS = {
  illegal: "Illegal content",
  harassment: "Harassment",
  spam: "Spam",
  other: "Other",
};

// Per member (not per IP), so one person can't flood the inbox.
const forumReportLimiter = limit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `user:${req.session.user.id}`,
});

const isAdminReq = (req) => !!(req.session.user && req.session.user.isAdmin);

// Hidden posts (admin moderation, routes/admin/forum.js): members never get
// the text, so it is blanked here and the views show a placeholder. Admins
// keep the original plus the reason.
function maskHidden(row, admin) {
  if (!row.hidden_at) return row;
  const info = unpackReason(row.hidden_reason);
  const out = { ...row, hidden: true, hidden_code: info.code, hidden_note: info.note };
  if (!admin) {
    out.title = "";
    out.body = "";
    out.hidden_code = null;
    out.hidden_note = "";
  }
  return out;
}

router.get("/forum", requireMember, async (req, res) => {
  const { rows: threads } = await pool.query(
    `SELECT t.*, u.display_name AS author_name,
            (SELECT COUNT(*) FROM forum_replies r WHERE r.thread_id = t.id) AS reply_count
     FROM forum_threads t LEFT JOIN users u ON u.id = t.author_id
     ORDER BY t.created_at DESC`
  );
  const admin = isAdminReq(req);
  res.render("forum_list", { threads: threads.map((t) => maskHidden(t, admin)) });
});

router.get("/forum/new", requireMember, (req, res) => {
  res.render("forum_new", { error: null });
});

router.post("/forum/new", requireMember, forumPostLimiter, async (req, res) => {
  const title = clean(req.body.title, MAX_THREAD_TITLE);
  const body = clean(req.body.body, MAX_POST_BODY);
  if (!title || !body) {
    return res.status(400).render("forum_new", { error: req.tr("Title and message are both required.", "Le titre et le message sont tous deux obligatoires.") });
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
  if (!threadRows.length) return res.status(404).send(req.tr("Thread not found.", "Discussion introuvable."));

  const admin = isAdminReq(req);
  const thread = maskHidden(threadRows[0], admin);

  // A hidden thread is hidden as a whole for members: no replies, no form.
  const { rows: replyRows } = thread.hidden && !admin ? { rows: [] } : await pool.query(
    `SELECT r.*, u.display_name AS author_name FROM forum_replies r
     LEFT JOIN users u ON u.id = r.author_id WHERE r.thread_id = $1 ORDER BY r.created_at ASC`,
    [threadId]
  );

  const replies = replyRows.map((r) => maskHidden(r, admin));

  res.render("forum_thread", { thread, replies, error: null, reported: req.query.reported === "1" });
});

router.post("/forum/:id/replies", requireMember, forumReplyLimiter, async (req, res) => {
  const threadId = Number(req.params.id);
  const body = clean(req.body.body, MAX_POST_BODY);
  if (!body) return res.redirect(`/forum/${threadId}`);
  if (!isAdminReq(req)) {
    const { rows } = await pool.query("SELECT hidden_at FROM forum_threads WHERE id = $1", [threadId]);
    if (rows[0] && rows[0].hidden_at) return res.redirect(`/forum/${threadId}`);
  }
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

// Notice-and-action (EU Digital Services Act): a member flags a thread or
// reply and the administrators get an email. Nothing is stored.
router.post("/forum/report", requireMember, forumReportLimiter, async (req, res) => {
  const kind = req.body.kind === "thread" || req.body.kind === "reply" ? req.body.kind : null;
  const id = parseId(String(req.body.id || ""));
  if (!kind || id === null) return res.status(404).render("404");
  const reasonKey = Object.prototype.hasOwnProperty.call(REPORT_REASONS, req.body.reason) ? req.body.reason : null;
  if (!reasonKey) return res.status(400).type("text/plain").send(req.tr("Please choose a reason for the report.", "Veuillez choisir un motif pour le signalement."));
  const comment = clean(req.body.comment, MAX_REPORT_COMMENT);

  const { rows } = kind === "thread"
    ? await pool.query(
        `SELECT t.id AS thread_id, t.body, u.display_name AS author_name
         FROM forum_threads t LEFT JOIN users u ON u.id = t.author_id WHERE t.id = $1`, [id])
    : await pool.query(
        `SELECT r.thread_id, r.body, u.display_name AS author_name
         FROM forum_replies r LEFT JOIN users u ON u.id = r.author_id WHERE r.id = $1`, [id]);
  const target = rows[0];
  if (!target) return res.status(404).render("404");

  // Never built from the Host header; with no configured base URL, no link.
  let link;
  try { link = `${baseUrl(req)}/forum/${target.thread_id}`; } catch { /* no link */ }

  const reporter = emailSafeName(req.session.user.displayName || "") || "A member";
  const excerpt = String(target.body || "").replace(/\s+/g, " ").trim().slice(0, REPORT_EXCERPT);
  const lines = [
    `A forum ${kind} was reported.`,
    "",
    `Reported by: ${reporter} (member #${req.session.user.id})`,
    `Reason: ${REPORT_REASONS[reasonKey]}`,
    `Comment: ${comment || "(none)"}`,
    `Author of the post: ${emailSafeName(target.author_name || "") || "unknown"}`,
    ...(link ? [`Thread: ${link}`] : []),
    "",
    "Text reported (first 300 characters):",
    excerpt,
  ];
  try {
    await sendEmail({
      kind: "forum_report",
      to: REPORT_TO,
      subject: `Forum report: ${REPORT_REASONS[reasonKey]} (${kind} ${id})`,
      text: lines.join("\n") + "\n",
    });
  } catch (err) {
    console.error("Forum report email failed:", err);
    return res.status(500).type("text/plain").send(req.tr(
      "Sorry, your report couldn't be sent just now. Please email admin@umasbooks.org.",
      "Désolé, votre signalement n’a pas pu être envoyé pour le moment. Veuillez écrire à admin@umasbooks.org."
    ));
  }
  res.redirect(`/forum/${target.thread_id}?reported=1`);
});

module.exports = router;
