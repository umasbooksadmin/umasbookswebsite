const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { parseId, clean } = require("../../lib/validation");
const { validDay } = require("../../lib/reports");
const { SITE_TIME_ZONE } = require("../../lib/tz");
const { markOrderCollected, markOrderRefunded, cancelUnpaidOrder, NOTE_MAX, ORDER_VIEWS, OVERDUE_DAYS } = require("../../lib/orderActions");

const router = express.Router();

const PAGE_SIZE = 50;

// The "Show" filter: an order status, or one of the work lists (lib/orderActions.js).
const STATUSES = ["pending", "paid", "refunded", "expired", "cancelled"];
const SPECIAL = ORDER_VIEWS;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function parseFilters(query) {
  const show = String(query.show || "");
  const f = {
    show: STATUSES.includes(show) || SPECIAL[show] ? show : "",
    from: validDay(String(query.from || "")) || "",
    to: validDay(String(query.to || "")) || "",
    q: clean(query.q, 100) || "",
    page: Math.max(1, Math.min(100000, parseInt(query.page, 10) || 1)),
  };
  return f;
}

function whereFor(f) {
  const where = [];
  const params = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  if (STATUSES.includes(f.show)) where.push(`o.status = ${add(f.show)}`);
  else if (SPECIAL[f.show]) where.push(`(${SPECIAL[f.show].sql})`);
  // Paris days, like the reports: [midnight Paris of `from`, midnight Paris after `to`).
  if (f.from) where.push(`o.created_at >= (${add(f.from)}::date)::timestamp AT TIME ZONE '${SITE_TIME_ZONE}'`);
  if (f.to) where.push(`o.created_at < ((${add(f.to)}::date) + 1)::timestamp AT TIME ZONE '${SITE_TIME_ZONE}'`);
  if (f.q) {
    const like = add(`%${f.q.replace(/[\\%_]/g, "\\$&")}%`);
    const idMatch = /^#?(\d{1,9})$/.exec(f.q);
    const byId = idMatch && Number(idMatch[1]) <= 2147483647 ? `o.id = ${add(Number(idMatch[1]))} OR ` : "";
    where.push(`(${byId}o.buyer_email ILIKE ${like} OR o.buyer_name ILIKE ${like})`);
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

function queryString(f, extra = {}) {
  const p = new URLSearchParams();
  const all = { ...f, ...extra };
  for (const k of ["show", "from", "to", "q"]) if (all[k]) p.set(k, all[k]);
  if (all.page && all.page > 1) p.set("page", String(all.page));
  const s = p.toString();
  return s ? `?${s}` : "";
}

async function countsFor() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            ${STATUSES.map((s) => `COUNT(*) FILTER (WHERE o.status = '${s}')::int AS ${s}`).join(", ")},
            ${Object.entries(SPECIAL).map(([k, v]) => `COUNT(*) FILTER (WHERE ${v.sql})::int AS ${k}`).join(", ")}
     FROM orders o`
  );
  return rows[0];
}

router.get("/admin/orders", requireAdmin, async (req, res) => {
  const f = parseFilters(req.query);
  const { sql, params } = whereFor(f);
  const { rows: totalRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM orders o ${sql}`, params);
  const total = totalRows[0].n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(f.page, pages);
  const { rows: orders } = await pool.query(
    `SELECT o.*, (
       SELECT json_agg(json_build_object('title', i.item_title, 'price', i.price) ORDER BY i.id)
       FROM order_items i WHERE i.order_id = o.id
     ) AS items
     FROM orders o ${sql}
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
    params
  );
  res.render("admin/orders", {
    active: "orders", orders, f: { ...f, page }, total, pages, page, pageSize: PAGE_SIZE,
    counts: await countsFor(), STATUSES, SPECIAL, cap, qs: (extra) => queryString({ ...f, page }, extra),
    notice: noticeFor(req.query.notice),
  });
});

const NOTICES = {
  collected: "Marked as collected.",
  "already-collected": "This order was already marked collected. Nothing changed.",
  refunded: "Marked as refunded. The books are back on sale and the order no longer counts as a sale.",
  "already-refunded": "This order was already marked refunded. Nothing was changed.",
  cancelled: "The unpaid order was cancelled and its books and seats are free again.",
  "now-paid": "This order turned out to be PAID at HelloAsso, so it was not cancelled. Reload the page.",
};
const noticeFor = (key) => NOTICES[String(key || "")] || null;

async function loadOrder(id) {
  const { rows } = await pool.query(
    `SELECT o.*, u.display_name AS account_name, u.email AS account_email, cu.email AS collected_by_email
     FROM orders o LEFT JOIN users u ON u.id = o.user_id LEFT JOIN users cu ON cu.id = o.collected_by
     WHERE o.id = $1`,
    [id]
  );
  return rows[0] || null;
}

router.get("/admin/orders/:id", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  const order = id ? await loadOrder(id) : null;
  if (!order) return res.status(404).render("404");
  const [{ rows: items }, { rows: history }] = await Promise.all([
    pool.query(
      `SELECT i.id, i.item_title, i.price, i.book_copy_id, i.class_dropin_seat_id,
              bc.status AS copy_status, bc.book_id, ds.status AS seat_status
       FROM order_items i
       LEFT JOIN book_copies bc ON bc.id = i.book_copy_id
       LEFT JOIN class_dropin_seats ds ON ds.id = i.class_dropin_seat_id
       WHERE i.order_id = $1 ORDER BY i.id`,
      [id]
    ),
    pool.query(
      `SELECT at, actor_label, action, detail FROM admin_audit_log
       WHERE target_type = 'order' AND target_id = $1 ORDER BY at, id`,
      [id]
    ),
  ]);
  res.render("admin/order", {
    active: "orders", order, items, history, overdueDays: OVERDUE_DAYS,
    notice: noticeFor(req.query.notice), error: null,
  });
});

router.post("/admin/orders/:id/collected", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).render("404");
  const result = await markOrderCollected(pool, id, req.session.user.id);
  if (result.outcome === "not_found") return res.status(404).render("404");
  if (result.outcome === "collected") await audit(req, { action: "order.collected", targetType: "order", targetId: id });
  const notice = result.outcome === "collected" ? "collected" : result.outcome === "already" ? "already-collected" : "";
  res.redirect(`/admin/orders/${id}${notice ? `?notice=${notice}` : ""}`);
});

// Step 1: the warning and the form. Nothing changes until the POST below.
async function renderRefundConfirm(req, res, { error = null, note = "", status = 200 } = {}) {
  const id = parseId(req.params.id);
  const order = id ? await loadOrder(id) : null;
  if (!order) return res.status(404).render("404");
  if (order.status === "refunded") return res.redirect(`/admin/orders/${id}?notice=already-refunded`);
  const { rows: items } = await pool.query("SELECT item_title, price FROM order_items WHERE order_id = $1 ORDER BY id", [id]);
  return res.status(status).render("admin/order_refund", { active: "orders", order, items, error, note, noteMax: NOTE_MAX });
}

router.get("/admin/orders/:id/refund", requireAdmin, (req, res) => renderRefundConfirm(req, res));

router.post("/admin/orders/:id/refund", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).render("404");
  const note = clean(req.body.note, NOTE_MAX) || "";
  if (req.body.confirmHelloasso !== "on") {
    return renderRefundConfirm(req, res, { status: 400, note, error: "Tick the box to confirm that you already refunded this payment in the HelloAsso dashboard." });
  }
  if (!note) return renderRefundConfirm(req, res, { status: 400, note, error: "Please write a note (for example the date of the refund in HelloAsso, or who asked for it)." });

  const result = await markOrderRefunded(pool, id, { note });
  if (result.outcome === "not_found") return res.status(404).render("404");
  if (result.outcome === "already") return res.redirect(`/admin/orders/${id}?notice=already-refunded`);
  if (result.outcome === "not_paid") {
    return renderRefundConfirm(req, res, { status: 409, note, error: `Only a paid order can be marked refunded (this one is ${result.status}).` });
  }
  if (result.outcome === "note_required") return renderRefundConfirm(req, res, { status: 400, note, error: "Please write a note." });
  await audit(req, {
    action: "order.refunded", targetType: "order", targetId: id,
    detail: `restocked ${result.restocked}${result.kept.length ? `, kept sold (resold) ${result.kept.length}` : ""}, seats released ${result.seatsReleased}; ${note}`,
  });
  res.redirect(`/admin/orders/${id}?notice=refunded`);
});

router.post("/admin/orders/:id/cancel", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).render("404");
  const result = await cancelUnpaidOrder(pool, id);
  if (result.outcome === "not_found") return res.status(404).render("404");
  if (result.outcome === "cancelled") await audit(req, { action: "order.cancelled", targetType: "order", targetId: id, detail: "unpaid order cancelled by admin" });
  const notice = result.outcome === "cancelled" ? "cancelled" : result.outcome === "paid" ? "now-paid" : "";
  res.redirect(`/admin/orders/${id}${notice ? `?notice=${notice}` : ""}`);
});

module.exports = router;
