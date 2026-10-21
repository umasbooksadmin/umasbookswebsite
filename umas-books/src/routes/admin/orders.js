const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { setFlash, takeFlash } = require("../../lib/flash");
const { audit } = require("../../lib/audit");
const { parseId, clean } = require("../../lib/validation");
const { validDay } = require("../../lib/reports");
const { SITE_TIME_ZONE } = require("../../lib/tz");
const {
  markOrderCollected, collectReservation, cancelReservationByAdmin, markReservationNoShow, extendReservation,
  markOrderRefunded, cancelUnpaidOrder, NOTE_MAX, ORDER_VIEWS, OVERDUE_DAYS, PAYMENT_METHODS,
} = require("../../lib/orderActions");
const { expireStaleReservations, RESERVATION_EXTENSION_DAYS } = require("../../lib/reservations");
const { reservationLastDay } = require("../../lib/orderItems");
const { likeContains, parseIntParam } = require("../../lib/parseParams");

const router = express.Router();

const PAGE_SIZE = 50;

// The "Show" filter: a reservation status, or one of the work lists (lib/orderActions.js).
// The default view is "Reserved: awaiting pickup"; show=all lists every reservation.
const STATUSES = ["reserved", "paid", "refunded", "expired", "cancelled", "pending"];
const STATUS_LABELS = { reserved: "Reserved: awaiting pickup", pending: "Pending (old online payment flow)" };
const SPECIAL = ORDER_VIEWS;
const cap = (s) => STATUS_LABELS[s] || s.charAt(0).toUpperCase() + s.slice(1);
const DEFAULT_VIEW = "reserved";

function parseFilters(query) {
  const show = String(query.show || "");
  const anyOther = query.from || query.to || query.q;
  const f = {
    show: STATUSES.includes(show) || SPECIAL[show] ? show : (show === "all" || anyOther || show ? "" : DEFAULT_VIEW),
    from: validDay(String(query.from || "")) || "",
    to: validDay(String(query.to || "")) || "",
    q: clean(query.q, 100) || "",
    page: parseIntParam(query.page, { min: 1, max: 100000, default: 1 }),
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
    const like = add(likeContains(f.q));
    const idMatch = /^#?(\d{1,9})$/.exec(f.q);
    const byId = idMatch && Number(idMatch[1]) <= 2147483647 ? `o.id = ${add(Number(idMatch[1]))} OR ` : "";
    where.push(`(${byId}o.buyer_email ILIKE ${like} OR o.buyer_name ILIKE ${like})`);
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

function queryString(f, extra = {}) {
  const p = new URLSearchParams();
  const all = { ...f, ...extra };
  // An empty show means "every order" (the default view, when the parameter is missing, is the reservations).
  p.set("show", all.show || "all");
  for (const k of ["from", "to", "q"]) if (all[k]) p.set(k, all[k]);
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
  await expireStaleReservations(pool); // the list never shows a reservation that is already past its deadline as "awaiting pickup"
  const f = parseFilters(req.query);
  const { sql, params } = whereFor(f);
  const { rows: totalRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM orders o ${sql}`, params);
  const total = totalRows[0].n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(f.page, pages);
  const { rows: orders } = await pool.query(
    `SELECT o.*, (
       SELECT json_agg(json_build_object('title', i.item_title, 'price', i.price, 'seat', i.class_dropin_seat_id IS NOT NULL) ORDER BY i.id)
       FROM order_items i WHERE i.order_id = o.id
     ) AS items
     FROM orders o ${sql}
     ORDER BY ${f.show === "reserved" || f.show === "expiring_soon" ? "o.reserved_until ASC NULLS LAST, o.id ASC" : "o.created_at DESC, o.id DESC"}
     LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
    params
  );
  res.render("admin/orders", {
    active: "orders", orders, f: { ...f, page }, total, pages, page, pageSize: PAGE_SIZE,
    counts: await countsFor(), STATUSES, SPECIAL, cap, qs: (extra) => queryString({ ...f, page }, extra), lastDay: reservationLastDay,
    notice: noticeFor(req.query.notice),
  });
});

const NOTICES = {
  collected: "Marked as collected.",
  "already-collected": "This reservation was already marked collected. Nothing changed.",
  "collected-paid": "Collected and paid: the books and seats are sold and the reservation now counts as a sale.",
  "collected-partial": "Collected and paid for the selected items. The other items stay reserved on a new reservation with the same deadline.",
  "reservation-cancelled": "The reservation was cancelled: its books are back on the shelf and its seats are free again.",
  "reservation-expired": "Marked as no-show: the books are back on the shelf and the seats are free again.",
  "reservation-extended": `The deadline was extended by ${RESERVATION_EXTENSION_DAYS} days.`,
  "not-reserved": "This reservation is no longer a reservation: nothing was changed. Reload the page.",
  refunded: "Marked as refunded. The books are back on sale and the reservation no longer counts as a sale.",
  "already-refunded": "This reservation was already marked refunded. Nothing was changed.",
  cancelled: "The unpaid reservation was cancelled and its books and seats are free again.",
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

async function renderOrder(req, res, { error = null, status = 200, formValues = {} } = {}) {
  const id = parseId(req.params.id);
  if (id) await expireStaleReservations(pool);
  const order = id ? await loadOrder(id) : null;
  if (!order) return res.status(404).render("404");
  const [{ rows: items }, { rows: history }, { rows: related }] = await Promise.all([
    pool.query(
      `SELECT i.id, i.item_title, i.price, i.book_copy_id, i.class_dropin_seat_id,
              bc.status AS copy_status, bc.cart_order_id AS copy_order_id, bc.location AS copy_location, bc.book_id, ds.status AS seat_status
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
    pool.query("SELECT id, status FROM orders WHERE split_from_order_id = $1 OR id = $2 ORDER BY id", [id, order.split_from_order_id || 0]),
  ]);
  // Held right now for THIS order (what "Mark collected and paid" can still collect).
  for (const i of items) {
    i.active = i.book_copy_id != null ? i.copy_status === "reserved" && i.copy_order_id === order.id : i.seat_status === "reserved";
  }
  return res.status(status).render("admin/order", {
    active: "orders", order, items, history, related, overdueDays: OVERDUE_DAYS, paymentMethods: PAYMENT_METHODS,
    extensionDays: RESERVATION_EXTENSION_DAYS, lastDay: reservationLastDay(order), formValues,
    notice: status === 200 ? noticeFor(req.query.notice) : null, error,
  });
}

// A refused action on an order redirects here (Post/Redirect/Get) and carries the
// message (and what was typed in the payment form) once in the session.
async function refusedBack(req, res, error, formValues) {
  await setFlash(req, `order-${req.params.id}`, { error, formValues });
  res.redirect(303, `/admin/orders/${req.params.id}`);
}

router.get("/admin/orders/:id", requireAdmin, (req, res, next) => {
  if (req.params.id === "pickup-list") return next();
  const f = takeFlash(req, `order-${req.params.id}`);
  return renderOrder(req, res, f && f.error ? { error: String(f.error), formValues: f.formValues || {} } : {});
});

// One printable page for the staff: every reservation waiting, grouped by
// customer, with where each book is shelved and what to collect. ?print=1 gives
// the compact layout for paper (print conventions: Print button, the
// admin chrome is hidden by print CSS).
router.get("/admin/orders/pickup-list", requireAdmin, async (req, res) => {
  await expireStaleReservations(pool);
  const { rows } = await pool.query(
    `SELECT o.id, o.buyer_name, o.buyer_email, o.buyer_phone, o.total_amount, o.reserved_until, o.created_at,
            i.id AS item_id, i.item_title, i.price, i.class_dropin_seat_id, bc.location, bc.condition
     FROM orders o
     JOIN order_items i ON i.order_id = o.id
     LEFT JOIN book_copies bc ON bc.id = i.book_copy_id
     WHERE o.status = 'reserved'
     ORDER BY lower(o.buyer_name), lower(o.buyer_email), o.reserved_until, o.id, i.id`
  );
  const byCustomer = new Map();
  for (const r of rows) {
    const key = r.buyer_email.toLowerCase();
    if (!byCustomer.has(key)) byCustomer.set(key, { name: r.buyer_name, email: r.buyer_email, phone: r.buyer_phone, orders: new Map(), total: 0 });
    const c = byCustomer.get(key);
    if (!c.orders.has(r.id)) {
      c.orders.set(r.id, { id: r.id, until: r.reserved_until, total: Number(r.total_amount), items: [] });
      c.total += Number(r.total_amount);
    }
    c.orders.get(r.id).items.push({ title: r.item_title, price: Number(r.price), location: r.location, seat: r.class_dropin_seat_id != null });
  }
  const customers = [...byCustomer.values()].map((c) => ({ ...c, orders: [...c.orders.values()] }));
  res.render("admin/orders_pickup_list", {
    active: "orders", customers, print: req.query.print === "1", lastDay: reservationLastDay,
    grandTotal: customers.reduce((sum, c) => sum + c.total, 0),
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

const COLLECT_ERRORS = {
  method_required: "Choose how the customer paid (cash, card at the shop, cheque or other).",
  nothing_to_collect: "None of the selected items is still being held for this reservation, so there is nothing to collect. Reload the page.",
  amount_invalid: "The amount received must be a number of euros, zero or more.",
  amount_too_high: "The amount received cannot be more than the total. If the customer gave more, record the exact total and handle the difference at the till.",
  note_required: "When the amount received is lower than the total, please write a note saying why (for example a discount you gave).",
};

// "Mark collected and paid": all the items still held, or (collect-selected) only
// the ticked ones. See lib/orderActions.js collectReservation.
async function collect(req, res, { selected }) {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).render("404");
  const itemIds = selected ? [].concat(req.body.itemIds || []).map((v) => parseId(v)).filter(Boolean) : undefined;
  const note = clean(req.body.note, NOTE_MAX) || "";
  const method = String(req.body.method || "");
  const result = await collectReservation(pool, id, {
    adminUserId: req.session.user.id, method, note,
    amountReceived: selected ? undefined : req.body.amountReceived, itemIds,
  });
  if (result.outcome === "not_found") return res.status(404).render("404");
  if (result.outcome === "not_reserved") return res.redirect(`/admin/orders/${id}?notice=not-reserved`);
  if (result.outcome !== "collected") {
    return refusedBack(req, res, COLLECT_ERRORS[result.outcome] || "Could not record the payment.", { method, note, amountReceived: String(req.body.amountReceived || "").slice(0, 40) });
  }
  await audit(req, {
    action: "order.collected_paid", targetType: "order", targetId: id,
    detail: `${method}, €${result.total.toFixed(2)} of €${result.reservedTotal.toFixed(2)}, ${result.items} item(s)${result.partial ? `, rest moved to reservation #${result.newOrderId}` : ""}${result.dropped.length ? `, dropped ${result.dropped.length} no longer held` : ""}${note ? `; ${note}` : ""}`,
  });
  res.redirect(`/admin/orders/${id}?notice=${result.partial ? "collected-partial" : "collected-paid"}`);
}

router.post("/admin/orders/:id/collect", requireAdmin, (req, res) => collect(req, res, { selected: false }));
router.post("/admin/orders/:id/collect-selected", requireAdmin, (req, res) => collect(req, res, { selected: true }));

router.post("/admin/orders/:id/cancel-reservation", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).render("404");
  const result = await cancelReservationByAdmin(pool, id);
  if (result.outcome === "not_found") return res.status(404).render("404");
  if (result.outcome === "released") await audit(req, { action: "order.reservation_cancelled", targetType: "order", targetId: id, detail: `books back in stock ${result.copies}, seats released ${result.seats}` });
  res.redirect(`/admin/orders/${id}?notice=${result.outcome === "released" ? "reservation-cancelled" : "not-reserved"}`);
});

router.post("/admin/orders/:id/no-show", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).render("404");
  const result = await markReservationNoShow(pool, id);
  if (result.outcome === "not_found") return res.status(404).render("404");
  if (result.outcome === "released") await audit(req, { action: "order.reservation_no_show", targetType: "order", targetId: id, detail: `books back in stock ${result.copies}, seats released ${result.seats}` });
  res.redirect(`/admin/orders/${id}?notice=${result.outcome === "released" ? "reservation-expired" : "not-reserved"}`);
});

router.post("/admin/orders/:id/extend", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).render("404");
  const result = await extendReservation(pool, id);
  if (result.outcome === "not_found") return res.status(404).render("404");
  if (result.outcome === "extended") {
    await audit(req, { action: "order.reservation_extended", targetType: "order", targetId: id, detail: `+${RESERVATION_EXTENSION_DAYS} days` });
    return res.redirect(`/admin/orders/${id}?notice=reservation-extended`);
  }
  const message = {
    already_extended: "This reservation was already extended once: it cannot be extended again.",
    no_books: "Only a reservation holding books can be extended (a drop-in seat is held until its session).",
    not_reserved: "This reservation is no longer a reservation: nothing was changed.",
  }[result.outcome] || "Could not extend this reservation.";
  return refusedBack(req, res, message, {});
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

router.get("/admin/orders/:id/refund", requireAdmin, (req, res) => {
  const f = takeFlash(req, `refund-${req.params.id}`);
  return renderRefundConfirm(req, res, f ? { error: f.error ? String(f.error) : null, note: String(f.note || "") } : {});
});

// A refused refund goes back to the confirmation page (Post/Redirect/Get) with the note kept.
const refundRefused = async (req, res, note, error) => {
  await setFlash(req, `refund-${req.params.id}`, { error, note });
  return res.redirect(303, `/admin/orders/${req.params.id}/refund`);
};

router.post("/admin/orders/:id/refund", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).render("404");
  const note = clean(req.body.note, NOTE_MAX) || "";
  if (req.body.confirmRefunded !== "on") {
    return refundRefused(req, res, note, "Tick the box to confirm that you already gave the money back to the customer.");
  }
  if (!note) return refundRefused(req, res, note, "Please write a note (for example how it was refunded: cash, cheque or card, and the date, or who asked for it).");

  const result = await markOrderRefunded(pool, id, { note });
  if (result.outcome === "not_found") return res.status(404).render("404");
  if (result.outcome === "already") return res.redirect(`/admin/orders/${id}?notice=already-refunded`);
  if (result.outcome === "not_paid") {
    return refundRefused(req, res, note, `Only a paid reservation can be marked refunded (this one is ${result.status}).`);
  }
  if (result.outcome === "note_required") return refundRefused(req, res, note, "Please write a note.");
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
  if (result.outcome === "cancelled") await audit(req, { action: "order.cancelled", targetType: "order", targetId: id, detail: "unpaid reservation cancelled by admin" });
  const notice = result.outcome === "cancelled" ? "cancelled" : "";
  res.redirect(`/admin/orders/${id}${notice ? `?notice=${notice}` : ""}`);
});

module.exports = router;
