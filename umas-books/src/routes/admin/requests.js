// Admin "Requests" page: customers' book requests (lib/bookRequests.js).
// English only. Admins see the requester's name and email because they have
// to contact people; every action writes an audit row with ids only (never an
// email, name or title).
//
// Notification is one click and never automatic: "Notify" emails the
// requester that the matched copy is here; "Notify and hold 7 days" also
// reserves that copy for them.

const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { baseUrl } = require("../../lib/baseUrl");
const { parseId } = require("../../lib/validation");
const { normalizeIsbn } = require("../../lib/bookLookup");
const { isbnVariants } = require("../../lib/inventory");
const br = require("../../lib/bookRequests");

const router = express.Router();

const STATUS_FILTERS = [
  { value: "active", label: "Active (open, matched, notified)" },
  { value: "open", label: "Open (nothing in stock yet)" },
  { value: "matched", label: "Matched (a copy is in the shop)" },
  { value: "notified", label: "Notified" },
  { value: "unconfirmed", label: "Waiting for email confirmation" },
  { value: "fulfilled", label: "Fulfilled" },
  { value: "cancelled", label: "Cancelled" },
  { value: "expired", label: "Expired" },
  { value: "all", label: "All" },
];

const NOTICES = {
  notified: "Email sent.",
  held: "Email sent and the copy is held for 7 days.",
  fulfilled: "Marked as fulfilled.",
  cancelled: "Request cancelled and the requester's contact details removed.",
  deleted: "Request deleted.",
  noted: "Note saved.",
  matched: "Request matched to the book.",
  "no-match": "Couldn't match: enter a book id or ISBN that is in inventory with a copy in stock.",
  gone: "That request no longer exists, or it can't be changed that way any more.",
};

function backTo(req) {
  const body = req.body || {};
  const q = new URLSearchParams();
  for (const k of ["status", "q", "book"]) {
    const v = typeof body[`return_${k}`] === "string" ? body[`return_${k}`] : "";
    if (v) q.set(k, v.slice(0, 200));
  }
  return q.toString();
}

function redirectWith(req, res, params) {
  const q = new URLSearchParams(backTo(req));
  for (const [k, v] of Object.entries(params)) q.set(k, v);
  res.redirect(`/admin/requests?${q.toString()}`);
}

router.get("/admin/requests", requireAdmin, async (req, res) => {
  const status = STATUS_FILTERS.some((f) => f.value === req.query.status) ? req.query.status : "active";
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  const bookId = parseId(typeof req.query.book === "string" ? req.query.book : "");
  const params = [];
  const where = [];
  if (status === "active") where.push("r.status IN ('open', 'matched', 'notified')");
  else if (status !== "all") {
    params.push(status);
    where.push(`r.status = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    const n = params.length;
    where.push(`(r.title ILIKE $${n} OR r.author ILIKE $${n} OR r.isbn ILIKE $${n} OR r.email ILIKE $${n} OR r.name ILIKE $${n})`);
  }
  if (bookId) {
    params.push(bookId);
    where.push(`c.book_id = $${params.length}`);
  }
  const { rows: requests } = await pool.query(
    `SELECT r.*, c.book_id, c.status AS copy_status, c.price AS copy_price, b.title AS book_title
     FROM book_requests r
     LEFT JOIN book_copies c ON c.id = r.matched_copy_id
     LEFT JOIN books b ON b.id = c.book_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY r.created_at DESC, r.id DESC LIMIT 300`,
    params
  );
  const { rows: counts } = await pool.query("SELECT status, count(*)::int AS n FROM book_requests GROUP BY status");
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));
  res.render("admin/requests", {
    active: "requests",
    requests,
    statusFilters: STATUS_FILTERS,
    status,
    q,
    bookId: bookId || "",
    byStatus,
    notice: NOTICES[req.query.notice] || null,
    noticeIsError: req.query.notice === "no-match" || req.query.notice === "gone",
    error: Object.values(br.NOTIFY_ERRORS).includes(req.query.error) ? req.query.error : null,
  });
});

router.post("/admin/requests/:id/notify", requireAdmin, async (req, res) => {
  await notify(req, res, false);
});

router.post("/admin/requests/:id/notify-hold", requireAdmin, async (req, res) => {
  await notify(req, res, true);
});

async function notify(req, res, hold) {
  const id = parseId(req.params.id);
  if (id === null) return redirectWith(req, res, { notice: "gone" });
  const result = await br.notifyRequest(pool, id, { hold, base: baseUrl(req) });
  if (result.error) return redirectWith(req, res, { error: result.error });
  await audit(req, {
    action: hold ? "request.notify_hold" : "request.notify",
    targetType: "book_request", targetId: id,
    detail: `copy ${result.copyId}`,
  });
  redirectWith(req, res, { notice: hold ? "held" : "notified" });
}

router.post("/admin/requests/:id/fulfil", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  const r = id === null ? { rowCount: 0 } : await pool.query(
    `UPDATE book_requests SET status = 'fulfilled', updated_at = now()
     WHERE id = $1 AND status IN ('open', 'matched', 'notified')`,
    [id]
  );
  if (!r.rowCount) return redirectWith(req, res, { notice: "gone" });
  await audit(req, { action: "request.fulfil", targetType: "book_request", targetId: id });
  redirectWith(req, res, { notice: "fulfilled" });
});

router.post("/admin/requests/:id/cancel", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  const done = id !== null && (await br.cancelRequest(pool, id));
  if (!done) return redirectWith(req, res, { notice: "gone" });
  await audit(req, { action: "request.cancel", targetType: "book_request", targetId: id });
  redirectWith(req, res, { notice: "cancelled" });
});

router.post("/admin/requests/:id/note", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  const note = typeof (req.body || {}).adminNote === "string" ? req.body.adminNote.trim().slice(0, 500) : "";
  const r = id === null ? { rowCount: 0 } : await pool.query(
    "UPDATE book_requests SET admin_note = $2, updated_at = now() WHERE id = $1 AND status = ANY($3::text[])",
    [id, note || null, br.ACTIVE_STATUSES]
  );
  if (!r.rowCount) return redirectWith(req, res, { notice: "gone" });
  await audit(req, { action: "request.note", targetType: "book_request", targetId: id });
  redirectWith(req, res, { notice: "noted" });
});

router.post("/admin/requests/:id/delete", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  const r = id === null ? { rowCount: 0 } : await pool.query("DELETE FROM book_requests WHERE id = $1", [id]);
  if (!r.rowCount) return redirectWith(req, res, { notice: "gone" });
  await audit(req, { action: "request.delete", targetType: "book_request", targetId: id });
  redirectWith(req, res, { notice: "deleted" });
});

// Manual "Match to a book": a book id or an ISBN; matches the book's newest in-stock copy.
router.post("/admin/requests/:id/match", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  const raw = typeof (req.body || {}).book === "string" ? req.body.book.trim() : "";
  const isbn = normalizeIsbn(raw);
  const asIsbn = /^(\d{13}|\d{9}[\dX])$/.test(isbn);
  const bookId = asIsbn ? null : parseId(raw);
  if (id === null || (!asIsbn && bookId === null)) return redirectWith(req, res, { notice: "no-match" });
  const { rows } = await pool.query(
    `SELECT c.id, c.book_id FROM book_copies c JOIN books b ON b.id = c.book_id
     WHERE c.status = 'in_stock' AND ${asIsbn ? "b.isbn = ANY($1)" : "b.id = $1"}
     ORDER BY c.created_at DESC, c.id DESC LIMIT 1`,
    [asIsbn ? isbnVariants(isbn) : bookId]
  );
  if (!rows.length) return redirectWith(req, res, { notice: "no-match" });
  const r = await pool.query(
    `UPDATE book_requests SET status = 'matched', matched_copy_id = $2, updated_at = now()
     WHERE id = $1 AND status IN ('open', 'matched')`,
    [id, rows[0].id]
  );
  if (!r.rowCount) return redirectWith(req, res, { notice: "gone" });
  await audit(req, { action: "request.match", targetType: "book_request", targetId: id, detail: `copy ${rows[0].id}` });
  redirectWith(req, res, { notice: "matched" });
});

module.exports = router;
