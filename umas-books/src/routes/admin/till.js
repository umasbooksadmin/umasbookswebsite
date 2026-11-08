// The till (/admin/till): scan books, take cash or card, record the sale.
// Plus receipts, voids and the end of the day
// (/admin/till/day). English only. Admins, plus accounts with "Till access"
// (requireTillOrAdmin: the till page, scan, check, sale, release, void, receipts and the
// read-only end of day); the quick items page (routes/admin/otherStock.js), closing/reopening the day and every override
// beyond the rules stay admin only. The page keeps the sale in the
// browser (public/till.js); the server re-checks everything when the sale is
// confirmed (lib/till.js completeSale).

const crypto = require("crypto");
const express = require("express");
const { pool } = require("../../db");
const { requireAdmin, requireTillOrAdmin } = require("../../middleware/auth");
const { alertOnError } = require("../../lib/errorAlert");
const { validateIdParams } = require("../../middleware/idParams");
const { limit } = require("../../middleware/rateLimits");
const { audit } = require("../../lib/audit");
const { expireStaleReservations } = require("../../lib/reservations");
const till = require("../../lib/till");
const { getCardProvider } = require("../../lib/cardPayments");
const { todayParis, validDay, csvCell, CSV_SEP } = require("../../lib/reports");
const { formatDateTime, formatTime, forLocale, LOCALES } = require("../../lib/dates");
const { formatEuro } = require("../../lib/money");
const { SELLER_LINES } = require("../../lib/orderEmail");
const { vatNotice } = require("../../lib/legalText");
const { SITE_TIME_ZONE } = require("../../lib/tz");
const { variantUrl } = require("../../lib/imageVariants");

const router = express.Router();
validateIdParams(router, "id");

const scanLimiter = limit({ windowMs: 15 * 60 * 1000, max: 1500 });
const saleLimiter = limit({ windowMs: 60 * 60 * 1000, max: 400 });
const voidLimiter = limit({ windowMs: 60 * 60 * 1000, max: 60 });
const writeLimiter = limit({ windowMs: 60 * 60 * 1000, max: 200 });

const money = (cents) => (cents == null ? "" : (cents / 100).toFixed(2));
const parseJson = (raw) => {
  try { return JSON.parse(String(raw || "")); } catch { return null; }
};

// JSON answers for the till page's calls: a refusal carries its message (and extra fields
// such as the new total); an unexpected failure is a JSON 500 too, never an HTML page the
// browser cannot read.
function jsonRoute(handler) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof till.TillError) return res.status(err.status).json({ ok: false, error: err.message, ...err.extra });
      console.error("Till request failed:", err);
      Promise.resolve(alertOnError("Till request failed", err)).catch(() => {});
      res.status(500).json({ ok: false, serverError: true, error: "The server had a problem and could not finish this. Nothing was confirmed by the server." });
    }
  };
}

const isAdminReq = (req) => Boolean(req.session.user && req.session.user.isAdmin);

// ---------- the till page ----------

async function recentSales(day) {
  const { rows } = await pool.query(
    `SELECT s.id, s.created_at, s.payment_method, s.total_cents, s.status, s.void_reason, s.refund_confirmed,
            (SELECT string_agg(i.description || CASE WHEN i.quantity > 1 THEN ' x' || i.quantity ELSE '' END, ', ' ORDER BY i.id) FROM till_sale_items i WHERE i.sale_id = s.id) AS summary
     FROM till_sales s WHERE (s.created_at AT TIME ZONE '${SITE_TIME_ZONE}')::date = $1::date
     ORDER BY s.created_at DESC, s.id DESC LIMIT 15`, [day]
  );
  return rows;
}

const NOTICES = { "sell-retired": "Sales are made at the Till now." };

router.get("/admin/till", requireTillOrAdmin, async (req, res) => {
  const today = todayParis();
  const [{ rows: quickItems }, recent, summary] = await Promise.all([
    pool.query("SELECT id, name, price_cents, category, stock, image_url FROM till_quick_items WHERE active ORDER BY lower(name), id"),
    recentSales(today),
    till.daySummary(pool, today),
  ]);
  res.render("admin/till/index", {
    active: "till", mainWide: true, title: "Till", pageTitle: "Till",
    token: crypto.randomBytes(18).toString("base64url"),
    quickItems, recent, today, summary, categories: till.OTHER_CATEGORIES,
    cardInstruction: getCardProvider().name, variantUrl, formatTime, eur: till.eur, isAdmin: isAdminReq(req),
    maxTotalCents: till.MAX_TOTAL_CENTS,
    flash: /^\d{1,9}$/.test(String(req.query.voided || ""))
      ? `Sale ${Number(req.query.voided)} voided: its books are back in stock.${req.query.card === "1" ? " It was a card sale: refund the card on the SumUp reader or app yourself, then tick \"I refunded the card\"." : ""}`
      : (NOTICES[req.query.notice] || null),
    error: typeof req.query.error === "string" ? req.query.error.slice(0, 200) : null,
  });
});

router.post("/admin/till/scan", requireTillOrAdmin, scanLimiter, jsonRoute(async (req, res) => {
  await expireStaleReservations(pool);
  const have = Array.isArray(parseJson(req.body.have)) ? parseJson(req.body.have) : [];
  const result = await till.lookupScan(pool, String(req.body.code || ""), have.slice(0, 100));
  // Opening a reservation at the till shows the customer's name: recorded, so a run of ORDER-<n> lookups is visible
  // in the audit log (review 6A L1).
  if (result.type === "reservation") {
    await audit(req, { action: "till.reservation_open", targetType: "order", targetId: result.order.id, detail: `opened at the till${isAdminReq(req) ? "" : " by till account"}` });
  }
  res.json(result);
}));

// An in_cart copy whose online cart hold has expired: release it (the cart's own release
// function) and hand back its line. Refused, with the time left, while the hold is live.
router.post("/admin/till/release", requireTillOrAdmin, scanLimiter, jsonRoute(async (req, res) => {
  if (!/^\d{1,9}$/.test(String(req.body.copyId || ""))) throw new till.TillError("A copy could not be found.");
  const copyId = Number(req.body.copyId);
  const r = await till.releaseExpiredCartCopy(pool, copyId);
  await audit(req, { action: "till.release_cart", targetType: "book_copy", targetId: copyId, detail: r.orderId ? `released from the expired cart of reservation ${r.orderId}` : "released from an expired cart" });
  res.json({ type: "line", line: r.line });
}));

// What the sale and the check both read from the browser's form.
function saleInput(req) {
  return {
    token: req.body.token, method: req.body.method, items: parseJson(req.body.items),
    expectedTotalCents: req.body.expectedTotalCents,
    soldAtTime: req.body.soldAtTime, soldAtDay: req.body.soldAtDay, backdateReason: req.body.backdateReason,
    reopen: req.body.reopen, reopenReason: req.body.reopenReason,
    userId: req.session.user.id, isAdmin: isAdminReq(req),
  };
}

// The same line building and validation as the sale, WITHOUT writing anything. The Cash and
// Card screens call it when they open, so a refusal is shown BEFORE the customer pays.
router.post("/admin/till/check", requireTillOrAdmin, saleLimiter, jsonRoute(async (req, res) => {
  await expireStaleReservations(pool);
  const r = await till.checkSale(pool, saleInput(req));
  res.json({ ok: true, totalCents: r.totalCents, lines: r.lines });
}));

router.post("/admin/till/sale", requireTillOrAdmin, saleLimiter, jsonRoute(async (req, res) => {
  await expireStaleReservations(pool);
  const r = await till.completeSale(pool, {
    ...saleInput(req),
    received: req.body.received, cardReference: req.body.cardReference, cardConfirmed: req.body.cardConfirmed,
  });
  if (!r.duplicate) {
    await audit(req, { action: "till.sale", targetType: "till_sale", targetId: r.saleId, detail: `${req.body.method} ${money(r.totalCents)}${r.adjusted ? " (time adjusted)" : ""}` });
    for (const o of r.overrides) {
      await audit(req, { action: "till.price_override", targetType: "book_copy", targetId: o.copyId, detail: `${money(o.from)} -> ${money(o.to)}${o.reason ? `: ${o.reason}` : ""} (sale ${r.saleId})` });
    }
    for (const c of r.collected || []) {
      await audit(req, { action: "order.collected_paid", targetType: "order", targetId: c.orderId, detail: `${req.body.method === "card" ? "card" : "cash"} at the till (sale ${r.saleId}), ${c.items} item(s)${c.partial ? `, rest moved to reservation #${c.newOrderId}` : ""}` });
    }
    if (r.adjusted) await audit(req, { action: "till.sale_backdated", targetType: "till_sale", targetId: r.saleId, detail: `sold at ${String(req.body.soldAtDay === "yesterday" ? "yesterday " : "")}${String(req.body.soldAtTime).slice(0, 5)}: ${r.backdateReason}` });
    if (r.reopened) {
      const p = r.reopened.previous;
      await audit(req, { action: "till.day_reopen", targetType: "till_day", detail: `${r.reopened.day} reopened to record sale ${r.saleId}: ${r.reopened.reason} (was counted ${p.counted == null ? "-" : money(p.counted)}, expected ${p.expected == null ? "-" : money(p.expected)})` });
    }
  }
  res.json({
    ok: true, saleId: r.saleId, totalCents: r.totalCents, changeCents: r.changeCents, duplicate: r.duplicate,
    receiptUrl: `/admin/till/sales/${r.saleId}/receipt`,
  });
}));

const ticked = (v) => v === "1" || v === "on" || v === "true";

router.post("/admin/till/sales/:id/void", requireTillOrAdmin, voidLimiter, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const r = await till.voidSale(pool, { saleId: id, reason: req.body.reason, userId: req.session.user.id, refundConfirmed: ticked(req.body.refundConfirmed), isAdmin: isAdminReq(req) });
    await audit(req, { action: "till.void", targetType: "till_sale", targetId: id, detail: `${money(r.totalCents)}${isAdminReq(req) ? "" : " by till account"}: ${till.cleanText(req.body.reason, 120)}${r.card ? (r.refundConfirmed ? " (card refunded)" : " (card refund not confirmed yet)") : ""}` });
    res.redirect(`/admin/till?voided=${id}${r.card && !r.refundConfirmed ? "&card=1" : ""}`);
  } catch (err) {
    if (!(err instanceof till.TillError)) throw err;
    res.redirect(`/admin/till?error=${encodeURIComponent(err.message)}`);
  }
});

// "I refunded the card": ticked after the void, once the card was refunded on the SumUp
// reader or app. Until then a voided card sale is listed in Needs attention.
router.post("/admin/till/sales/:id/refunded", requireTillOrAdmin, voidLimiter, async (req, res) => {
  const id = Number(req.params.id);
  const back = typeof req.body.back === "string" && /^\/admin\/till(\/day\?day=\d{4}-\d{2}-\d{2})?$/.test(req.body.back) ? req.body.back : "/admin/till/day";
  try {
    const r = await till.confirmRefund(pool, { saleId: id, userId: req.session.user.id, isAdmin: isAdminReq(req) });
    await audit(req, { action: "till.refund_confirmed", targetType: "till_sale", targetId: id, detail: `card refunded ${money(r.totalCents)}` });
  } catch (err) {
    if (!(err instanceof till.TillError)) throw err;
    return res.redirect(`${back}${back.includes("?") ? "&" : "?"}error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(back);
});

// ---------- receipt ----------

router.get("/admin/till/sales/:id/receipt", requireTillOrAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM till_sales WHERE id = $1", [Number(req.params.id)]);
  if (!rows.length) return res.status(404).render("404");
  const { rows: items } = await pool.query("SELECT * FROM till_sale_items WHERE sale_id = $1 ORDER BY id", [rows[0].id]);
  res.render("admin/till/receipt", {
    // A receipt is a consumer document: French (loi Toubon), amounts and Paris date/time in French format.
    sale: rows[0], items, eur: (c) => formatEuro(c / 100, "fr"), formatDateTime: forLocale(LOCALES.fr).formatDateTime, receiptNo: till.receiptNumber(rows[0]),
    sellerLines: SELLER_LINES, vat: vatNotice(),
  });
});

// ---------- end of day ----------

function dayFrom(req) {
  const today = todayParis();
  const day = validDay(typeof req.query.day === "string" ? req.query.day : "") || today;
  return { day: day > today ? today : day, today };
}

const DAY_LIST_LIMIT = 500;
async function daySales(day) {
  const { rows } = await pool.query(
    `SELECT s.id, s.created_at, s.payment_method, s.total_cents, s.status, s.void_reason, s.card_reference, s.refund_confirmed, s.voided_at,
            COALESCE(NULLIF(u.display_name, ''), u.email) AS voided_by_name,
            (SELECT string_agg(i.description || CASE WHEN i.quantity > 1 THEN ' x' || i.quantity ELSE '' END, '; ' ORDER BY i.id) FROM till_sale_items i WHERE i.sale_id = s.id) AS summary
     FROM till_sales s LEFT JOIN users u ON u.id = s.voided_by WHERE (s.created_at AT TIME ZONE '${SITE_TIME_ZONE}')::date = $1::date
     ORDER BY s.created_at, s.id LIMIT ${DAY_LIST_LIMIT}`, [day]
  );
  return rows;
}

router.get("/admin/till/day", requireTillOrAdmin, async (req, res) => {
  const { day, today } = dayFrom(req);
  const [summary, sales, unclosed] = await Promise.all([till.daySummary(pool, day), daySales(day), till.unclosedDays(pool)]);
  const catLabel = (k) => k === "books_used" ? "Books used" : k === "books_new" ? "Books new" : k === till.SEAT_CATEGORY ? "Class seats" : k === till.EDU_CATEGORY ? "Educational items" : (till.OTHER_CATEGORIES.find((c) => c.value === k) || {}).label || k;

  if (req.query.format === "csv" || req.query.format === "csv-fr") {
    await audit(req, { action: "till.day_csv", targetType: "till_day", detail: day });
    const head = ["Sale", "Time (Paris)", "Payment method", "Status", "Total (EUR)", "Items", "Card reference", "Void reason", "Voided by", "Voided at (Paris)"].map(csvCell).join(CSV_SEP);
    const lines = sales.map((s) => [
      s.id, csvCell(formatTime(s.created_at)), csvCell(s.payment_method), csvCell(s.status), money(s.total_cents),
      csvCell(s.summary), csvCell(s.card_reference), csvCell(s.void_reason),
      csvCell(s.status === "voided" ? s.voided_by_name : ""), csvCell(s.status === "voided" && s.voided_at ? formatTime(s.voided_at) : ""),
    ].join(CSV_SEP));
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="umas-books-till-${day}.csv"`,
      "Cache-Control": "no-store",
    });
    return res.send("\uFEFF" + [head, ...lines].join("\r\n") + "\r\n");
  }

  res.render("admin/till/day", {
    active: "till", title: "End of day", pageTitle: "End of day", mainWide: true,
    day, today, summary, sales, unclosed, catLabel, eur: till.eur, money, formatTime, formatDateTime,
    canManage: isAdminReq(req),
    error: typeof req.query.error === "string" ? req.query.error.slice(0, 200) : null,
    notice: req.query.closed ? "The day is closed." : req.query.opened ? "Opening float saved." : req.query.reopened ? "The day is open again: count the drawer and close it again when you are done." : null,
  });
});

// The opening float of today, or of a past day that was never closed (typed late).
router.post("/admin/till/day/open", requireAdmin, writeLimiter, async (req, res) => {
  const today = todayParis();
  const day = validDay(String(req.body.day || "")) || today;
  const f = till.parseCents(req.body.openingFloat, { label: "Opening float" });
  const back = req.body.back === "till" ? "/admin/till" : `/admin/till/day?day=${day}`;
  const fail = (message) => res.redirect(`${back}${back.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`);
  if (f.error) return fail(f.error);
  if (day > today) return fail("A future day cannot be opened.");
  try {
    await till.openDay(pool, { day, floatCents: f.cents, userId: req.session.user.id });
  } catch (err) {
    if (!(err instanceof till.TillError)) throw err;
    return fail(err.message);
  }
  await audit(req, { action: "till.day_open", targetType: "till_day", detail: `${day} float ${money(f.cents)}` });
  res.redirect(back === "/admin/till" ? back : `${back}&opened=1`);
});

router.post("/admin/till/day/close", requireAdmin, writeLimiter, async (req, res) => {
  const today = todayParis();
  const day = validDay(String(req.body.day || "")) || today;
  const c = till.parseCents(req.body.counted, { label: "Counted cash" });
  const back = `/admin/till/day?day=${day}`;
  if (c.error) return res.redirect(`${back}&error=${encodeURIComponent(c.error)}`);
  try {
    const r = await till.closeDay(pool, { day, countedCents: c.cents, note: req.body.note, userId: req.session.user.id, today, confirmNoFloat: ticked(req.body.confirmNoFloat) });
    await audit(req, { action: "till.day_close", targetType: "till_day", detail: `${day} expected ${money(r.expectedCents)} counted ${money(c.cents)} difference ${money(r.differenceCents)}` });
  } catch (err) {
    if (!(err instanceof till.TillError)) throw err;
    return res.redirect(`${back}&error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`${back}&closed=1`);
});

// Reopen a closed day (admin, reason required): the counted cash is cleared, the close is done again.
router.post("/admin/till/day/reopen", requireAdmin, writeLimiter, async (req, res) => {
  const day = validDay(String(req.body.day || "")) || todayParis();
  const back = `/admin/till/day?day=${day}`;
  try {
    const r = await till.reopenDay(pool, { day, reason: req.body.reason, userId: req.session.user.id });
    const p = r.previous;
    await audit(req, { action: "till.day_reopen", targetType: "till_day", detail: `${day} reopened: ${r.reason} (was counted ${p.counted == null ? "-" : money(p.counted)}, expected ${p.expected == null ? "-" : money(p.expected)})` });
  } catch (err) {
    if (!(err instanceof till.TillError)) throw err;
    return res.redirect(`${back}&error=${encodeURIComponent(err.message)}`);
  }
  res.redirect(`${back}&reopened=1`);
});

module.exports = router;
