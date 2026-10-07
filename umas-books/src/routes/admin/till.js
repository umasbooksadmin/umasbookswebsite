// The till (/admin/till): scan books, take cash or card, record the sale.
// Plus quick items (/admin/till/items), receipts, voids and the end of the day
// (/admin/till/day). English only. Admins, plus accounts with "Till access"
// (requireTillOrAdmin: the till page, scan, check, sale, release, void, receipts and the
// read-only end of day); quick items, closing/reopening the day and every override
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
const { todayParis, validDay, csvCell, csvDialect, csvDecimal, wantsFrenchCsv } = require("../../lib/reports");
const { formatDateTime, formatTime, forLocale, LOCALES } = require("../../lib/dates");
const { formatEuro } = require("../../lib/money");
const { SELLER_LINES } = require("../../lib/orderEmail");
const { vatNotice } = require("../../lib/legalText");
const { SITE_TIME_ZONE } = require("../../lib/tz");
const code128 = require("../../lib/code128");
const { parseSize } = require("./labels");

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
    pool.query("SELECT id, name, price_cents, category, stock FROM till_quick_items WHERE active ORDER BY sort_order, name, id"),
    recentSales(today),
    till.daySummary(pool, today),
  ]);
  res.render("admin/till/index", {
    active: "till", mainWide: true, title: "Till", pageTitle: "Till",
    token: crypto.randomBytes(18).toString("base64url"),
    quickItems, recent, today, summary, categories: till.OTHER_CATEGORIES,
    cardInstruction: getCardProvider().name, formatTime, eur: till.eur, isAdmin: isAdminReq(req),
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
    const r = await till.voidSale(pool, { saleId: id, reason: req.body.reason, userId: req.session.user.id, refundConfirmed: ticked(req.body.refundConfirmed) });
    await audit(req, { action: "till.void", targetType: "till_sale", targetId: id, detail: `${money(r.totalCents)}: ${till.cleanText(req.body.reason, 120)}${r.card ? (r.refundConfirmed ? " (card refunded)" : " (card refund not confirmed yet)") : ""}` });
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
    const r = await till.confirmRefund(pool, { saleId: id, userId: req.session.user.id });
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

// ---------- quick items ----------

const ITEM_ERR = {
  name: "Name is required (at most 80 characters).",
  price: "Price must be above 0.",
};

function parseItemForm(body) {
  const name = till.cleanText(body.name, 81);
  if (!name || name.length > 80) return { error: ITEM_ERR.name };
  const p = till.parseCents(body.price, { label: "Price" });
  if (p.error) return { error: p.error };
  if (p.cents <= 0) return { error: ITEM_ERR.price };
  const category = till.OTHER_CATEGORIES.some((c) => c.value === body.category) ? body.category : null;
  if (!category) return { error: "Choose a category." };
  let stock = null;
  if (String(body.stock == null ? "" : body.stock).trim() !== "") {
    if (!/^\d{1,6}$/.test(String(body.stock).trim())) return { error: "Stock must be a whole number (or empty for not counted)." };
    stock = Number(String(body.stock).trim());
  }
  let sort = 0;
  if (String(body.sortOrder == null ? "" : body.sortOrder).trim() !== "") {
    if (!/^\d{1,4}$/.test(String(body.sortOrder).trim())) return { error: "Order must be a whole number." };
    sort = Number(String(body.sortOrder).trim());
  }
  const bc = till.parseBarcode(body.barcode);
  if (bc.error) return { error: bc.error };
  return { name, priceCents: p.cents, category, stock, sort, barcode: bc.code };
}

const TAKEN = "That barcode is already used by another active quick item.";
// Validates the barcode of a parsed form against other active items and ISBNs (a code equal to a book's ISBN is refused).
async function barcodeChecks(f, excludeId, active = true) {
  if (!f.barcode || !active) return {};
  return till.checkBarcodeFree(pool, f.barcode, excludeId);
}

async function renderItems(res, { status = 200, error = null, notice = null } = {}) {
  const { rows } = await pool.query("SELECT * FROM till_quick_items ORDER BY active DESC, sort_order, name, id");
  res.status(status).render("admin/till/items", { active: "till", title: "Other stock (not books)", pageTitle: "Other stock (not books)", pageSub: "Tote bags, bookmarks and anything else you sell that is not a book", items: rows, shopCode: till.SHOP_CODE_PREFIX, categories: till.OTHER_CATEGORIES, error, notice, money });
}

// A refused form redirects back to the list with the message (Post/Redirect/Get),
// like the end-of-day form does: Back never offers to resubmit it.
const itemsRefused = (res, message) => res.redirect(303, `/admin/till/items?error=${encodeURIComponent(String(message).slice(0, 200))}`);

router.get("/admin/till/items", requireAdmin, (req, res) => renderItems(res, {
  notice: req.query.saved ? "Saved." : null,
  error: typeof req.query.error === "string" ? req.query.error.slice(0, 200) : null,
}));

// "ITEM-<id>": the shop's own code for an item without a manufacturer barcode.
async function generateShopCode(id) {
  const code = `${till.SHOP_CODE_PREFIX}${id}`;
  await pool.query("UPDATE till_quick_items SET barcode = $2 WHERE id = $1 AND barcode IS NULL", [id, code]);
  return code;
}

router.post("/admin/till/items", requireAdmin, writeLimiter, async (req, res) => {
  const f = parseItemForm(req.body);
  if (f.error) return itemsRefused(res, f.error);
  const chk = await barcodeChecks(f, null);
  if (chk.error) return itemsRefused(res, chk.error);
  let rows;
  try {
    ({ rows } = await pool.query(
      "INSERT INTO till_quick_items (name, price_cents, category, stock, sort_order, barcode) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [f.name, f.priceCents, f.category, f.stock, f.sort, f.barcode]
    ));
  } catch (err) {
    if (err.code === "23505") return itemsRefused(res, TAKEN);
    throw err;
  }
  let code = f.barcode;
  if (!code && req.body.generate === "1") code = await generateShopCode(rows[0].id);
  await audit(req, { action: "till.item_add", targetType: "till_quick_item", targetId: rows[0].id, detail: `${f.name} ${money(f.priceCents)}${code ? ` code ${code}` : ""}` });
  res.redirect("/admin/till/items?saved=1");
});

router.post("/admin/till/items/:id", requireAdmin, writeLimiter, async (req, res) => {
  const f = parseItemForm(req.body);
  if (f.error) return itemsRefused(res, f.error);
  const active = req.body.active === "1";
  const chk = await barcodeChecks(f, Number(req.params.id), active);
  if (chk.error) return itemsRefused(res, chk.error);
  let rowCount;
  try {
    ({ rowCount } = await pool.query(
      "UPDATE till_quick_items SET name = $2, price_cents = $3, category = $4, stock = $5, sort_order = $6, active = $7, barcode = $8 WHERE id = $1",
      [Number(req.params.id), f.name, f.priceCents, f.category, f.stock, f.sort, active, f.barcode]
    ));
  } catch (err) {
    if (err.code === "23505") return itemsRefused(res, TAKEN);
    throw err;
  }
  if (!rowCount) return res.status(404).render("404");
  await audit(req, { action: "till.item_edit", targetType: "till_quick_item", targetId: req.params.id, detail: `${f.name} ${money(f.priceCents)}${req.body.active === "1" ? "" : " (disabled)"}` });
  res.redirect("/admin/till/items?saved=1");
});

router.post("/admin/till/items/:id/generate-code", requireAdmin, writeLimiter, async (req, res) => {
  const { rows } = await pool.query("SELECT id, barcode FROM till_quick_items WHERE id = $1", [Number(req.params.id)]);
  if (!rows.length) return res.status(404).render("404");
  if (rows[0].barcode) return itemsRefused(res, "That item already has a barcode.");
  let code;
  try {
    code = await generateShopCode(rows[0].id);
  } catch (err) {
    if (err.code === "23505") return itemsRefused(res, TAKEN);
    throw err;
  }
  await audit(req, { action: "till.item_code", targetType: "till_quick_item", targetId: rows[0].id, detail: `generated ${code}` });
  res.redirect("/admin/till/items?saved=1");
});

// The Code 128 label of an item's own shop code (items with a manufacturer barcode have it printed on the item).
router.get("/admin/till/items/:id/label", requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM till_quick_items WHERE id = $1", [Number(req.params.id)]);
  const it = rows[0];
  if (!it) return res.status(404).render("404");
  if (!it.barcode || /^\d{8,14}$/.test(it.barcode)) {
    return res.redirect("/admin/till/items?error=" + encodeURIComponent("Only items with a shop code need a label. Generate a shop code first."));
  }
  const size = parseSize(req.query);
  await audit(req, { action: "labels.print", targetType: "till_quick_item", targetId: it.id, detail: `item ${it.barcode} ${size.w}x${size.h}mm ${size.layout}` });
  res.render("admin/inventory/label_sheet", {
    active: "till", mainWide: true, title: "Item label", pageTitle: "Item label",
    labels: [{ id: it.id, code: it.barcode, svg: code128.svg(it.barcode, { height: 40 }), level: null, price: `€${(it.price_cents / 100).toFixed(2)}`, title: it.name.slice(0, 42), author: "", isbn: "", meta: `Shop code ${it.barcode}` }],
    size, truncated: false, sheetLimit: 1, filters: {}, ids: [], backUrl: "/admin/till/items",
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
    `SELECT s.id, s.created_at, s.payment_method, s.total_cents, s.status, s.void_reason, s.card_reference, s.refund_confirmed,
            (SELECT string_agg(i.description || CASE WHEN i.quantity > 1 THEN ' x' || i.quantity ELSE '' END, '; ' ORDER BY i.id) FROM till_sale_items i WHERE i.sale_id = s.id) AS summary
     FROM till_sales s WHERE (s.created_at AT TIME ZONE '${SITE_TIME_ZONE}')::date = $1::date
     ORDER BY s.created_at, s.id LIMIT ${DAY_LIST_LIMIT}`, [day]
  );
  return rows;
}

router.get("/admin/till/day", requireTillOrAdmin, async (req, res) => {
  const { day, today } = dayFrom(req);
  const [summary, sales, unclosed] = await Promise.all([till.daySummary(pool, day), daySales(day), till.unclosedDays(pool)]);
  const catLabel = (k) => k === "books_used" ? "Books used" : k === "books_new" ? "Books new" : (till.OTHER_CATEGORIES.find((c) => c.value === k) || {}).label || k;

  if (req.query.format === "csv" || req.query.format === "csv-fr") {
    const french = wantsFrenchCsv(req.query);
    const d = csvDialect(french ? "fr" : "en");
    await audit(req, { action: "till.day_csv", targetType: "till_day", detail: french ? `${day} (French Excel)` : day });
    const head = ["Sale", "Time (Paris)", "Payment method", "Status", "Total (EUR)", "Items", "Card reference", "Void reason"].map(csvCell).join(d.sep);
    const lines = sales.map((s) => [
      s.id, csvCell(formatTime(s.created_at)), csvCell(s.payment_method), csvCell(s.status), csvDecimal(money(s.total_cents), d),
      csvCell(s.summary), csvCell(s.card_reference), csvCell(s.void_reason),
    ].join(d.sep));
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="umas-books-till-${day}${french ? "-fr" : ""}.csv"`,
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
