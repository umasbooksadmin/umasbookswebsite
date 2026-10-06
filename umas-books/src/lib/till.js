// The till: scan lookup, building a sale, recording it, voiding it and the
// end-of-day numbers. Money is whole CENTS everywhere in here.
//
// A sale is recorded in ONE transaction: the copies are locked FOR UPDATE (in
// id order, so two tills cannot deadlock), each must still be in stock, then
// till_sales + till_sale_items + shop_sales (one row per book copy, so the
// Reports pages count it once) are written and the copies become sold.
// sale_token is unique: the same token again returns the same sale.

const { SITE_TIME_ZONE } = require("./tz");
const { parseMoney } = require("./validation");
const inv = require("./inventory");
const colors = require("./priceColors");
const { parseTillScan } = require("./tillScan");
const { loadReservation } = require("./tillReservations");

const TZ = SITE_TIME_ZONE;
const MAX_LINES = 60;
const MAX_QTY = 99;
const DESCRIPTION_MAX = 80;
const REASON_MAX = 120;

// Categories a non-book line can have (manual item and quick item).
const OTHER_CATEGORIES = [
  { value: "books_other", label: "Books (other)" },
  { value: "merchandise", label: "Merchandise" },
  { value: "refreshments", label: "Refreshments" },
  { value: "donation", label: "Donation" },
  { value: "other", label: "Other" },
];
const OTHER_CATEGORY_VALUES = new Set(OTHER_CATEGORIES.map((c) => c.value));
// What the accounting export calls each line category.
const EXPORT_CATEGORY = {
  books_used: "Books used", books_new: "Books new", books_other: "Other",
  merchandise: "Merchandise", refreshments: "Refreshments", donation: "Donation", other: "Other",
};

class TillError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const eur = (cents) => `€${(cents / 100).toFixed(2)}`;
const toCents = (euros) => Math.round(Number(euros) * 100);

// A money text -> cents, or { error }.
function parseCents(raw, opts = {}) {
  const r = parseMoney(raw, opts);
  if (r.error) return { error: r.error };
  return { cents: r.value === null ? null : toCents(r.value) };
}

// Cash: what to hand back. Both in cents: no floating point.
function cashChange(totalCents, receivedCents) {
  if (!Number.isInteger(totalCents) || !Number.isInteger(receivedCents) || receivedCents < 0) return { error: "Enter the amount received." };
  if (receivedCents < totalCents) return { error: `Not enough: €${((totalCents - receivedCents) / 100).toFixed(2)} still to pay.` };
  return { changeCents: receivedCents - totalCents };
}

const STATUS_REASON = {
  sold: "it is already sold",
  reserved: "it is reserved for a customer",
  in_cart: "it is in someone's online cart",
  damaged: "it was withdrawn (damaged)",
  donated: "it was donated",
};
const refusal = (title, status) => `Cannot sell "${title}": ${STATUS_REASON[status] || `its status is ${status}`}.`;

// ---------- quick item barcodes ----------

const SHOP_CODE_PREFIX = "ITEM-";
// A barcode typed for a quick item: manufacturer code (8-14 digits: EAN/UPC/ITF)
// or the shop's own code (letters, digits, - . _ up to 32 characters). Stored
// upper-case so "tote-green" and "TOTE-GREEN" are one code. Returns { code }
// (null when blank) or { error }.
function parseBarcode(raw) {
  const t = String(raw == null ? "" : raw).trim().toUpperCase();
  if (!t) return { code: null };
  if (/^UB[-_ ]?\d/.test(t) || t.startsWith("UB-")) return { error: "A barcode cannot start with UB-: that is the prefix of the copy labels." };
  if (/^ORDER[-_ ]?\d/.test(t)) return { error: "A barcode cannot look like ORDER-<number>: that is for reservations." };
  if (/^\d+$/.test(t)) {
    if (t.length < 8 || t.length > 14) return { error: "A numeric barcode (EAN/UPC) has 8 to 14 digits." };
    return { code: t };
  }
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(t)) return { error: "A shop code uses letters, digits, - . _ and is at most 32 characters, like TOTE-GREEN." };
  return { code: t };
}

// Checks a code against the other active quick items and the books' ISBNs.
// -> { error } (taken) or { warning } (equals a book's ISBN: scans would add the
// quick item instead of the book) or {}.
async function checkBarcodeFree(db, code, excludeId = null) {
  const { rows } = await db.query("SELECT name FROM till_quick_items WHERE active AND barcode = $1 AND id <> COALESCE($2, 0)", [code, excludeId]);
  if (rows.length) return { error: `That barcode is already used by "${rows[0].name}". Each active quick item needs its own.` };
  const scan = parseTillScan(code);
  if (scan.type === "isbn") {
    const b = await db.query("SELECT title FROM books WHERE isbn = ANY($1) LIMIT 1", [inv.isbnVariants(scan.isbn)]);
    if (b.rows.length) return { warning: `This code is also the ISBN of "${b.rows[0].title}": at the till it will add this quick item, not the book. Scan that book by its UB- label instead.` };
  }
  return {};
}

// ---------- scan ----------

function copyLine(r) {
  const level = colors.colorFor(r);
  const isNew = r.condition === "new";
  const asking = r.price != null ? toCents(r.price) : (isNew && r.publisher_price != null ? toCents(r.publisher_price) : null);
  return {
    kind: "book", copyId: r.id, title: r.title, authors: r.authors || "", isbn: r.isbn || "",
    condition: r.condition, conditionLabel: inv.conditionLabel(r.condition), isNew,
    priceCents: asking, publisherPriceCents: r.publisher_price != null ? toCents(r.publisher_price) : null,
    location: r.location || "", category: isNew ? "books_new" : "books_used",
    color: { key: level.key, label: level.label, hex: level.hex, text: level.text, border: level.border || null },
  };
}

const COPY_COLUMNS = `c.id, c.condition, c.price, c.publisher_price, c.location, c.status, c.is_clearance, b.title, b.authors, b.isbn`;

// Resolves one scan. `have` = copy ids already on the sale. Returns one of
//   { type: "line", line }  { type: "choose", copies: [line...] }  { type: "error", message }
async function lookupScan(db, code, have = []) {
  const scan = parseTillScan(code);
  const onSale = new Set(have.map(Number));
  // Order of lookup: UB- label, exact quick-item barcode, (reservation), ISBN, unknown.
  if (scan.type !== "copy") {
    const bc = parseBarcode(code);
    if (bc.code) {
      const { rows: q } = await db.query("SELECT id, name, price_cents, category, stock FROM till_quick_items WHERE active AND barcode = $1", [bc.code]);
      if (q.length) {
        const it = q[0];
        if (it.stock !== null && it.stock <= 0) return { type: "error", message: `No more "${it.name}" in stock.` };
        return { type: "quick", item: { id: it.id, name: it.name, priceCents: it.price_cents, category: it.category, stock: it.stock } };
      }
    }
  }
  if (scan.type === "unknown") return { type: "error", message: `Code not recognised: ${String(code).trim().slice(0, 40)}. Scan a copy label (UB-…) or a book barcode.` };
  if (scan.type === "order") {
    const r = await loadReservation(db, scan.orderId);
    return { type: "error", message: r.error };
  }
  if (scan.type === "copy") {
    const { rows } = await db.query(`SELECT ${COPY_COLUMNS} FROM book_copies c JOIN books b ON b.id = c.book_id WHERE c.id = $1`, [scan.copyId]);
    if (!rows.length) return { type: "error", message: `Unknown label: UB-${scan.copyId}. No such copy.` };
    const r = rows[0];
    if (onSale.has(r.id)) return { type: "error", message: `"${r.title}" is already on this sale.` };
    if (r.status !== "in_stock") return { type: "error", message: refusal(r.title, r.status) };
    return { type: "line", line: copyLine(r) };
  }
  const variants = inv.isbnVariants(scan.isbn);
  const { rows } = await db.query(
    `SELECT ${COPY_COLUMNS} FROM book_copies c JOIN books b ON b.id = c.book_id
     WHERE b.isbn = ANY($1) ORDER BY c.created_at ASC, c.id ASC LIMIT 200`,
    [variants]
  );
  if (!rows.length) return { type: "error", message: `Not in inventory: ${scan.isbn}. Scan the copy label (UB-…) if it has one.` };
  const stock = rows.filter((r) => r.status === "in_stock");
  const free = stock.filter((r) => !onSale.has(r.id));
  if (!stock.length) {
    const why = rows.find((r) => r.status !== "in_stock");
    return { type: "error", message: refusal(why.title, why.status) };
  }
  if (!free.length) return { type: "error", message: `"${stock[0].title}" is already on this sale (no other copy in stock).` };
  if (free.length === 1) return { type: "line", line: copyLine(free[0]) };
  return { type: "choose", copies: free.slice(0, 30).map(copyLine) };
}

// ---------- building lines ----------

function cleanText(v, max) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); // eslint-disable-line no-control-regex
}

function parseQty(v) {
  const n = v === undefined || v === "" ? 1 : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_QTY) throw new TillError(`Quantity must be a whole number from 1 to ${MAX_QTY}.`);
  return n;
}

// Turns what the browser sent into verified lines, locking copies and quick
// items. Must run inside a transaction (db is the client).
async function buildLines(db, rawItems) {
  if (!Array.isArray(rawItems) || !rawItems.length) throw new TillError("The sale is empty.");
  if (rawItems.length > MAX_LINES) throw new TillError(`At most ${MAX_LINES} lines per sale.`);
  const copyIds = [];
  const quickIds = [];
  for (const it of rawItems) {
    if (!it || typeof it !== "object") throw new TillError("A line could not be read.");
    if (it.kind === "book") {
      if (!/^\d{1,9}$/.test(String(it.copyId))) throw new TillError("A copy could not be found.");
      copyIds.push(Number(it.copyId));
    } else if (it.kind === "quick") {
      if (!/^\d{1,9}$/.test(String(it.id))) throw new TillError("A quick item could not be found.");
      quickIds.push(Number(it.id));
    } else if (it.kind !== "manual") throw new TillError("A line could not be read.");
  }
  if (new Set(copyIds).size !== copyIds.length) throw new TillError("The same copy is on the sale twice.");

  const copies = new Map();
  if (copyIds.length) {
    const { rows } = await db.query(
      `SELECT ${COPY_COLUMNS} FROM book_copies c JOIN books b ON b.id = c.book_id
       WHERE c.id = ANY($1) ORDER BY c.id FOR UPDATE OF c`,
      [copyIds]
    );
    for (const r of rows) copies.set(r.id, r);
  }
  const quick = new Map();
  if (quickIds.length) {
    const { rows } = await db.query("SELECT * FROM till_quick_items WHERE id = ANY($1) ORDER BY id FOR UPDATE", [[...new Set(quickIds)]]);
    for (const r of rows) quick.set(r.id, r);
  }

  const lines = [];
  const quickQty = new Map();
  for (const it of rawItems) {
    if (it.kind === "book") {
      const copy = copies.get(Number(it.copyId));
      if (!copy) throw new TillError("A copy could not be found.");
      if (copy.status !== "in_stock") throw new TillError(refusal(copy.title, copy.status), 409);
      const asking = copyLine(copy).priceCents;
      const typed = it.price === undefined || it.price === null ? "" : String(it.price).trim();
      let cents;
      let original = null;
      let reason = null;
      if (copy.condition === "new") {
        // Loi Lang: the publisher's price, at most 5% off.
        const pricing = inv.resolveCopyPricing("new", typed, copy.publisher_price);
        if (pricing.error) throw new TillError(`"${copy.title}": ${pricing.error}`);
        cents = toCents(pricing.price);
        if (asking !== null && cents !== asking) { original = asking; reason = cleanText(it.reason, REASON_MAX) || null; }
      } else if (typed === "") {
        if (asking === null) throw new TillError(`Enter a price for "${copy.title}": it has none yet.`);
        cents = asking;
      } else {
        const p = parseCents(typed, { label: `Price of "${copy.title}"` });
        if (p.error) throw new TillError(p.error);
        cents = p.cents;
        if (asking === null && cents <= 0) throw new TillError(`Enter a price above 0 for "${copy.title}".`);
        if (asking !== null && cents !== asking) { original = asking; reason = cleanText(it.reason, REASON_MAX) || null; }
      }
      lines.push({
        kind: "book", copyId: copy.id, description: copy.title, quantity: 1, unitCents: cents,
        category: copy.condition === "new" ? "books_new" : "books_used", originalCents: original, reason,
      });
    } else if (it.kind === "quick") {
      const q = quick.get(Number(it.id));
      if (!q || !q.active) throw new TillError("That quick item is no longer available.", 409);
      const qty = parseQty(it.quantity);
      quickQty.set(q.id, (quickQty.get(q.id) || 0) + qty);
      if (q.stock !== null && quickQty.get(q.id) > q.stock) throw new TillError(`Not enough "${q.name}" in stock (${q.stock} left).`, 409);
      lines.push({ kind: "quick", quickId: q.id, description: q.name, quantity: qty, unitCents: q.price_cents, category: q.category });
    } else {
      const description = cleanText(it.description, DESCRIPTION_MAX + 1);
      if (!description) throw new TillError("A manual item needs a description.");
      if (description.length > DESCRIPTION_MAX) throw new TillError(`The description is limited to ${DESCRIPTION_MAX} characters.`);
      const p = parseCents(it.price, { label: "Price" });
      if (p.error) throw new TillError(p.error);
      if (p.cents <= 0) throw new TillError("A manual item needs a price above 0.");
      const category = OTHER_CATEGORY_VALUES.has(it.category) ? it.category : null;
      if (!category) throw new TillError("Choose a category for the manual item.");
      lines.push({ kind: "manual", description, quantity: parseQty(it.quantity), unitCents: p.cents, category });
    }
  }
  return { lines, quick };
}

// ---------- recording a sale ----------

// "HH:MM" earlier today -> timestamptz (Paris), or null for "now".
async function resolveSoldAt(db, soldAtTime) {
  const t = String(soldAtTime == null ? "" : soldAtTime).trim();
  if (!t) return { at: null, adjusted: false };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new TillError("The time must look like 14:30.");
  const { rows } = await db.query(
    `SELECT ((now() AT TIME ZONE '${TZ}')::date + $1::time) AT TIME ZONE '${TZ}' AS t, now() AS n`, [t]
  );
  if (rows[0].t > rows[0].n) throw new TillError("The sale time cannot be in the future.");
  return { at: rows[0].t, adjusted: true };
}

// input: { token, method, items, received, cardReference, cardConfirmed, soldAtTime, userId }
// -> { saleId, totalCents, changeCents, duplicate, overrides: [{copyId, from, to}], adjusted }
async function completeSale(pool, { token, method, items, received, cardReference, cardConfirmed, soldAtTime, userId }) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ""))) throw new TillError("The sale could not be identified: reload the till page.");
  if (method !== "cash" && method !== "card") throw new TillError("Choose Cash or Card.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { at, adjusted } = await resolveSoldAt(client, soldAtTime);
    const ins = await client.query(
      `INSERT INTO till_sales (staff_user_id, payment_method, total_cents, sale_token, created_at, adjusted_time)
       VALUES ($1, $2, 0, $3, COALESCE($4, now()), $5) ON CONFLICT (sale_token) DO NOTHING RETURNING id`,
      [userId, method, token, at, adjusted]
    );
    if (!ins.rows.length) {
      // The same sale again (double click, retry): answer with the first one.
      const { rows } = await client.query("SELECT id, total_cents, change_given_cents FROM till_sales WHERE sale_token = $1", [token]);
      await client.query("ROLLBACK");
      return { saleId: rows[0].id, totalCents: rows[0].total_cents, changeCents: rows[0].change_given_cents, duplicate: true, overrides: [], adjusted: false };
    }
    const saleId = ins.rows[0].id;
    const { lines } = await buildLines(client, items);
    const totalCents = lines.reduce((a, l) => a + l.unitCents * l.quantity, 0);
    if (totalCents <= 0) throw new TillError("The total must be above 0.");

    let receivedCents = null;
    let changeCents = null;
    let ref = null;
    if (method === "cash") {
      const r = parseCents(received, { label: "Amount received" });
      if (r.error) throw new TillError(r.error);
      const c = cashChange(totalCents, r.cents);
      if (c.error) throw new TillError(c.error);
      receivedCents = r.cents;
      changeCents = c.changeCents;
    } else {
      const { getCardProvider } = require("./cardPayments");
      const charge = await getCardProvider().startCharge(totalCents, token, { confirmed: cardConfirmed === true || cardConfirmed === "1" || cardConfirmed === "true", reference: cardReference });
      if (charge.status !== "paid") throw new TillError("The card payment is not confirmed. Charge the reader, then press Card paid.");
      ref = charge.reference;
    }

    await client.query(
      `UPDATE till_sales SET total_cents = $2, cash_received_cents = $3, change_given_cents = $4, card_reference = $5 WHERE id = $1`,
      [saleId, totalCents, receivedCents, changeCents, ref]
    );
    const overrides = [];
    for (const l of lines) {
      await client.query(
        `INSERT INTO till_sale_items (sale_id, kind, copy_id, quick_item_id, description, quantity, unit_price_cents, category, original_price_cents, override_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [saleId, l.kind, l.copyId || null, l.quickId || null, l.description, l.quantity, l.unitCents, l.category, l.originalCents ?? null, l.reason ?? null]
      );
      if (l.kind === "book") {
        await client.query(
          "INSERT INTO shop_sales (copy_id, price, sold_at, sold_by, payment_method, till_sale_id) VALUES ($1, $2, COALESCE($3, now()), $4, $5, $6)",
          [l.copyId, (l.unitCents / 100).toFixed(2), at, userId, method, saleId]
        );
        await client.query(
          `UPDATE book_copies SET status = 'sold', sold_at = COALESCE($2, now()), sold_via = 'till', reserved_by_name = NULL, reserved_by_email = NULL,
                  reserved_by_phone = NULL, reserved_at = NULL, cart_order_id = NULL, cart_added_at = NULL, updated_at = now()
           WHERE id = $1`,
          [l.copyId, at]
        );
        if (l.originalCents != null) overrides.push({ copyId: l.copyId, from: l.originalCents, to: l.unitCents, reason: l.reason });
      } else if (l.kind === "quick") {
        await client.query("UPDATE till_quick_items SET stock = stock - $2 WHERE id = $1 AND stock IS NOT NULL", [l.quickId, l.quantity]);
      }
    }
    await client.query("COMMIT");
    return { saleId, totalCents, changeCents, duplicate: false, overrides, adjusted };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------- voiding ----------

const parisDay = (ts) => `(${ts} AT TIME ZONE '${TZ}')::date`;

async function voidSale(pool, { saleId, reason, userId }) {
  const why = cleanText(reason, REASON_MAX);
  if (!why) throw new TillError("A reason is required to void a sale.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT s.*, ${parisDay("s.created_at")} = ${parisDay("now()")} AS same_day, ${parisDay("s.created_at")}::text AS day
       FROM till_sales s WHERE s.id = $1 FOR UPDATE`, [saleId]);
    const sale = rows[0];
    if (!sale) throw new TillError("That sale could not be found.", 404);
    if (sale.status === "voided") throw new TillError("That sale is already voided.", 409);
    if (!sale.same_day) throw new TillError("Only a sale made today can be voided. For an older sale, record the correction with your treasurer.", 409);
    const { rows: closed } = await client.query("SELECT 1 FROM till_days WHERE day = $1 AND closed_at IS NOT NULL", [sale.day]);
    if (closed.length) throw new TillError("The day is closed: sales can no longer be voided.", 409);
    const { rows: items } = await client.query("SELECT * FROM till_sale_items WHERE sale_id = $1 ORDER BY id", [saleId]);
    const copyIds = items.filter((i) => i.copy_id).map((i) => i.copy_id);
    if (copyIds.length) {
      await client.query("SELECT id FROM book_copies WHERE id = ANY($1) ORDER BY id FOR UPDATE", [copyIds]);
      await client.query(
        "UPDATE book_copies SET status = 'in_stock', sold_at = NULL, sold_via = NULL, updated_at = now() WHERE id = ANY($1) AND status = 'sold'", [copyIds]
      );
      await client.query("DELETE FROM shop_sales WHERE till_sale_id = $1", [saleId]);
    }
    for (const i of items) {
      if (i.kind === "quick" && i.quick_item_id) {
        await client.query("UPDATE till_quick_items SET stock = stock + $2 WHERE id = $1 AND stock IS NOT NULL", [i.quick_item_id, i.quantity]);
      }
    }
    await client.query(
      "UPDATE till_sales SET status = 'voided', voided_at = now(), void_reason = $2, voided_by = $3 WHERE id = $1", [saleId, why, userId]
    );
    await client.query("COMMIT");
    return { totalCents: sale.total_cents, copyIds };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------- end of day ----------

// Sales of one Paris day, by payment method and category, plus the drawer maths.
async function daySummary(db, day) {
  const [{ rows: totals }, { rows: cats }, { rows: dayRows }, { rows: after }] = await Promise.all([
    db.query(
      `SELECT payment_method, status, COUNT(*)::int AS n, COALESCE(SUM(total_cents), 0)::int AS total
       FROM till_sales WHERE ${parisDay("created_at")} = $1::date GROUP BY 1, 2`, [day]),
    db.query(
      `SELECT i.category, COALESCE(SUM(i.quantity), 0)::int AS n, COALESCE(SUM(i.quantity * i.unit_price_cents), 0)::int AS total
       FROM till_sale_items i JOIN till_sales s ON s.id = i.sale_id
       WHERE ${parisDay("s.created_at")} = $1::date AND s.status = 'completed' GROUP BY 1 ORDER BY 1`, [day]),
    db.query("SELECT * FROM till_days WHERE day = $1::date", [day]),
    db.query(
      `SELECT COUNT(*)::int AS n FROM till_sales s JOIN till_days d ON d.day = $1::date AND d.closed_at IS NOT NULL
       WHERE ${parisDay("s.created_at")} = $1::date AND s.status = 'completed' AND s.created_at > d.closed_at`, [day]),
  ]);
  const pick = (method, status) => totals.find((t) => t.payment_method === method && t.status === status) || { n: 0, total: 0 };
  const cash = pick("cash", "completed");
  const card = pick("card", "completed");
  const voided = { n: pick("cash", "voided").n + pick("card", "voided").n, total: pick("cash", "voided").total + pick("card", "voided").total };
  const row = dayRows[0] || null;
  const floatCents = row ? row.opening_float_cents : 0;
  return {
    day, cash, card, voided, categories: cats,
    count: cash.n + card.n, total: cash.total + card.total,
    dayRow: row, hasFloat: !!row, floatCents, expectedCashCents: floatCents + cash.total,
    closed: !!(row && row.closed_at), salesAfterClose: after[0].n,
  };
}

async function openDay(pool, { day, floatCents, userId }) {
  const { rows } = await pool.query("SELECT closed_at FROM till_days WHERE day = $1::date", [day]);
  if (rows.length && rows[0].closed_at) throw new TillError("That day is already closed.", 409);
  await pool.query(
    `INSERT INTO till_days (day, opening_float_cents, opened_by) VALUES ($1::date, $2, $3)
     ON CONFLICT (day) DO UPDATE SET opening_float_cents = EXCLUDED.opening_float_cents, opened_by = EXCLUDED.opened_by
     WHERE till_days.closed_at IS NULL`,
    [day, floatCents, userId]
  );
}

async function closeDay(pool, { day, countedCents, note, userId, today }) {
  if (day > today) throw new TillError("A future day cannot be closed.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO till_days (day, opening_float_cents, opened_by) VALUES ($1::date, 0, $2) ON CONFLICT (day) DO NOTHING", [day, userId]);
    const { rows } = await client.query("SELECT * FROM till_days WHERE day = $1::date FOR UPDATE", [day]);
    if (rows[0].closed_at) throw new TillError("That day is already closed.", 409);
    const s = await daySummary(client, day);
    const diff = countedCents - s.expectedCashCents;
    await client.query(
      `UPDATE till_days SET counted_cash_cents = $2, expected_cash_cents = $3, difference_cents = $4, closed_by = $5, closed_at = now(), note = $6
       WHERE day = $1::date`,
      [day, countedCents, s.expectedCashCents, diff, userId, cleanText(note, 300) || null]
    );
    await client.query("COMMIT");
    return { expectedCents: s.expectedCashCents, differenceCents: diff };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Past days (before today, Paris) that have completed sales and were never closed.
async function unclosedDays(db) {
  const { rows } = await db.query(
    `SELECT ${parisDay("s.created_at")}::text AS day FROM till_sales s
     WHERE s.status = 'completed' AND ${parisDay("s.created_at")} < ${parisDay("now()")}
       AND NOT EXISTS (SELECT 1 FROM till_days d WHERE d.day = ${parisDay("s.created_at")} AND d.closed_at IS NOT NULL)
     GROUP BY 1 ORDER BY 1`
  );
  return rows.map((r) => r.day);
}

module.exports = {
  TillError, OTHER_CATEGORIES, EXPORT_CATEGORY, DESCRIPTION_MAX, MAX_QTY, eur, toCents, parseCents, cashChange, cleanText,
  parseBarcode, checkBarcodeFree, SHOP_CODE_PREFIX, lookupScan, buildLines, completeSale, voidSale, daySummary, openDay, closeDay, unclosedDays,
};
