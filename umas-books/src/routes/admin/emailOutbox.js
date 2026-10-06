// Email outbox admin (English only, like the rest of /admin): what mail could
// not be sent, retry it, and resend an order confirmation. See lib/outbox.js.
// Kept apart from routes/admin/dashboard.js (the orders list) on purpose: the
// orders pages are edited by other changes, this file only adds routes.
const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { retryNow, markFailedHandled, sendEmail } = require("../../lib/outbox");
const mailer = require("../../mailer");
const { resendOrderConfirmation } = require("../../lib/cart");
const { parseId } = require("../../lib/validation");
const { validateIdParams } = require("../../middleware/idParams");

const router = express.Router();
validateIdParams(router, "id");

router.get("/admin/email-outbox", requireAdmin, async (req, res) => {
  const [{ rows }, { rows: counts }] = await Promise.all([
    pool.query(
      `SELECT id, to_email, subject, kind, status, attempts, next_try_at, sent_at, last_error, created_at, related_order_id, purged_at
       FROM email_outbox ORDER BY id DESC LIMIT 100`
    ),
    pool.query("SELECT status, COUNT(*)::int AS n FROM email_outbox GROUP BY status"),
  ]);
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));
  // Result of "Send a test email": the row itself says sent / the exact error.
  let test = null;
  const testId = parseId(req.query.test);
  if (testId) {
    const { rows: t } = await pool.query("SELECT id, status, attempts, last_error, to_email FROM email_outbox WHERE id = $1 AND kind = 'test'", [testId]);
    test = t[0] || null;
  }
  res.render("admin/email_outbox", { active: "email-outbox", rows, byStatus, notice: String(req.query.notice || ""), test, mailConfigured: mailer.isMailConfigured() });
});

router.post("/admin/email-outbox/:id/retry", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const r = await retryNow(pool, id);
  await audit(req, { action: "email.retry", targetType: "email_outbox", targetId: id });
  res.redirect(`/admin/email-outbox?notice=${r.ok ? (r.sent ? "retry-sent" : "retry-queued") : "retry-refused"}`);
});

// Sends a real email to the logged-in admin through the SAME path as customer
// mail (stored in the outbox, then an immediate SMTP attempt), so the page can
// show the exact error Gmail gives, or "sent".
router.post("/admin/email-outbox/test-email", requireAdmin, async (req, res) => {
  const to = req.session.user.email;
  const r = await sendEmail(
    { kind: "test", to, subject: "Uma's Books: test email", text: "This is a test email sent from /admin/email-outbox. If you can read it, the website can send mail." },
    { db: pool, waitMs: 20000 }
  );
  await audit(req, { action: "email.test", targetType: "email_outbox", targetId: r.id });
  res.redirect(`/admin/email-outbox?test=${r.id}`);
});

router.post("/admin/email-outbox/handled", requireAdmin, async (req, res) => {
  const n = await markFailedHandled(pool);
  await audit(req, { action: "email.mark_handled", detail: `${n} failed email(s) marked as handled` });
  res.redirect("/admin/email-outbox?notice=handled");
});

// Resend an order's confirmation (the button lives in views/partials/admin_resend_confirmation.ejs,
// included by the orders list).
router.post("/admin/orders/:id/resend-confirmation", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const r = await resendOrderConfirmation(pool, id);
  await audit(req, { action: "order.resend_confirmation", targetType: "order", targetId: id, detail: r.ok ? (r.sent ? "sent" : "queued") : r.reason });
  const notice = r.ok ? (r.sent ? "resent" : "resend-queued") : `resend-${r.reason}`;
  res.redirect(`/admin/orders?notice=${notice}#order-${id}`);
});

// Flash text for the orders list after a resend (it lives in routes/admin/orders*.js
// and views/admin/orders.ejs, which this file does not own): the redirect carries
// ?notice=..., this middleware (mounted first in routes/admin/index.js) exposes it to the view.
router.resendNoticeLocals = (req, res, next) => {
  res.locals.resendNotice = String(req.query.notice || "");
  next();
};

module.exports = router;
