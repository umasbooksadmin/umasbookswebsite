// The till: scan lookup, building a sale, recording it, voiding it and the
// end-of-day numbers. Money is whole CENTS everywhere in here.
//
// A sale is recorded in ONE transaction: the copies are locked FOR UPDATE (in
// id order, so two tills cannot deadlock), each must still be in stock, then
// till_sales + till_sale_items + shop_sales (one row per book copy, so the
// Reports pages count it once) are written and the copies become sold.
// sale_token is unique: the same token again returns the same sale.

const crypto = require("crypto");
const { SITE_TIME_ZONE } = require("./tz");
const { parseMoney } = require("./validation");
const inv = require("./inventory");
const colors = require("./priceColors");
const { parseTillScan } = require("./tillScan");
const { loadReservation, reservationOfCopy, lockReservedLines, collectReserved } = require("./tillReservations");

const TZ = SITE_TIME_ZONE;
const MAX_LINES = 60;
const MAX_QTY = 99;
// The most one sale can come to (cents). The database column is an int4 and a
// typing slip (an extra zero, a price pasted twice) must give a clear refusal.
const MAX_TOTAL_CENTS = 10_000_00;
// A price override beyond this (above the asking price) or any price below the
// asking price needs a reason and an admin.
const OVERRIDE_UP_PERCENT = 20;
const DESCRIPTION_MAX = 80;
const REASON_MAX = 120;

// Categories a non-book line can have (manual item and quick item).
const OTHER_CATEGORIES = [
  { value: "books_other", label: "Other (not new books: scan new books so the price rules apply)" },
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

// extra: fields sent to the browser with the message (code, newTotalCents...).
class TillError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const eur = (cents) => `€${(cents / 100).toFixed(2)}`;
const toCents = (euros) => Math.round(Number(euros) * 100);

// A money text -> cents, or { error }. trailingDot: accept "20." (the keypad
// leaves it when the dot is pressed last); used for cash received only.
function parseCents(raw, opts = {}) {
  const { trailingDot = false, ...moneyOpts } = opts;
  if (trailingDot && typeof raw === "string") raw = raw.trim().replace(/^(\d+)[.,]$/, "$1");
  const r = parseMoney(raw, moneyOpts);
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
  reserved: "it is reserved for a customer (scan the reservation, ORDER-<number>, to collect it)",
  in_cart: "it is in someone's online cart",
  damaged: "it was withdrawn (damaged)",
  donated: "it was donated",
};
const refusal = (title, status, minutesLeft = null) => {
  if (status === "in_cart" && minutesLeft != null) {
    return `Cannot sell "${title}": it is in someone's online cart (the hold ends in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}).`;
  }
  return `Cannot sell "${title}": ${STATUS_REASON[status] || `its status is ${status}`}.`;
};

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
// -> { error } (taken, or equal to a book's ISBN: scanning it would add the
// quick item instead of the book, so it cannot be saved) or {}.
async function checkBarcodeFree(db, code, excludeId = null) {
  const { rows } = await db.query("SELECT name FROM till_quick_items WHERE active AND barcode = $1 AND id <> COALESCE($2, 0)", [code, excludeId]);
  if (rows.length) return { error: `That barcode is already used by "${rows[0].name}". Each active quick item needs its own.` };
  const scan = parseTillScan(code);
  if (scan.type === "isbn") {
    const b = await db.query("SELECT title FROM books WHERE isbn = ANY($1) LIMIT 1", [inv.isbnVariants(scan.isbn)]);
    if (b.rows.length) {
      return { error: `This code is the ISBN of "${b.rows[0].title}": at the till it would add this item instead of the book. Use another code (a shop code such as TOTE-GREEN, or press Generate a shop code).` };
    }
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

// cart_expired: the online cart hold on an in_cart copy has run out (the sweep
// has not released it yet); cart_minutes_left: how long a live hold still has.
const HOLD_MINUTES = () => require("./cart").CART_HOLD_TTL_MINUTES;
const COPY_COLUMNS = () => `c.id, c.condition, c.price, c.publisher_price, c.location, c.status, c.is_clearance, c.cart_order_id, b.title, b.authors, b.isbn,
  (c.status = 'in_cart' AND c.cart_added_at < now() - interval '${HOLD_MINUTES()} minutes') AS cart_expired,
  CASE WHEN c.status = 'in_cart' AND c.cart_added_at IS NOT NULL
       THEN GREATEST(1, CEIL(EXTRACT(EPOCH FROM (c.cart_added_at + interval '${HOLD_MINUTES()} minutes' - now())) / 60))::int END AS cart_minutes_left`;

// Resolves one scan. `have` = copy ids already on the sale. Returns one of
//   { type: "line", line }  { type: "choose", copies: [line...] }  { type: "error", message }
//   { type: "expired_cart", line, message }: the copy sits in an expired online cart; the
//   till may offer to release it (releaseExpiredCartCopy) and add it.
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
  if (scan.type === "order") return reservationResult(db, scan.orderId);
  const expiredOffer = (r) => ({
    type: "expired_cart", line: copyLine(r),
    message: `"${r.title}" is still in an online cart that has expired (nobody paid). Release it from that cart and add it to this sale?`,
  });
  if (scan.type === "copy") {
    const { rows } = await db.query(`SELECT ${COPY_COLUMNS()} FROM book_copies c JOIN books b ON b.id = c.book_id WHERE c.id = $1`, [scan.copyId]);
    if (!rows.length) return { type: "error", message: `Unknown label: UB-${scan.copyId}. No such copy.` };
    const r = rows[0];
    // A book that an online reservation holds: the label opens that reservation.
    if (r.status === "reserved") {
      const orderId = await reservationOfCopy(db, r.id);
      if (orderId) return reservationResult(db, orderId);
    }
    if (onSale.has(r.id)) return { type: "error", message: `"${r.title}" is already on this sale.` };
    if (r.cart_expired) return expiredOffer(r);
    if (r.status !== "in_stock") return { type: "error", message: refusal(r.title, r.status, r.cart_minutes_left) };
    return { type: "line", line: copyLine(r) };
  }
  const variants = inv.isbnVariants(scan.isbn);
  const { rows } = await db.query(
    `SELECT ${COPY_COLUMNS()} FROM book_copies c JOIN books b ON b.id = c.book_id
     WHERE b.isbn = ANY($1) ORDER BY c.created_at ASC, c.id ASC LIMIT 200`,
    [variants]
  );
  if (!rows.length) return { type: "error", message: `Not in inventory: ${scan.isbn}. Scan the copy label (UB-…) if it has one.` };
  const stock = rows.filter((r) => r.status === "in_stock");
  const free = stock.filter((r) => !onSale.has(r.id));
  if (!stock.length) {
    const expired = rows.find((r) => r.cart_expired && !onSale.has(r.id));
    if (expired) return expiredOffer(expired);
    const why = rows.find((r) => r.status !== "in_stock");
    return { type: "error", message: refusal(why.title, why.status, why.cart_minutes_left) };
  }
  if (!free.length) return { type: "error", message: `"${stock[0].title}" is already on this sale (no other copy in stock).` };
  if (free.length === 1) return { type: "line", line: copyLine(free[0]) };
  return { type: "choose", copies: free.slice(0, 30).map(copyLine) };
}

// A reservation's lines for the till: books at the reserved price (nothing to
// override), seats as plain lines. { type: "reservation", order, lines } or an error.
async function reservationResult(db, orderId) {
  const r = await loadReservation(db, orderId);
  if (r.error) return { type: "error", message: r.error };
  const lines = r.items.map((i) => {
    const priceCents = toCents(i.price);
    if (i.book_copy_id != null) {
      const base = copyLine({ id: i.book_copy_id, condition: i.condition, price: i.price, publisher_price: i.publisher_price, location: i.location, is_clearance: i.is_clearance, title: i.title, authors: i.authors, isbn: i.isbn });
      return { ...base, priceCents, reserved: true, orderId: r.order.id, itemId: i.item_id };
    }
    return { kind: "seat", description: i.item_title, title: i.item_title, quantity: 1, priceCents, reserved: true, orderId: r.order.id, itemId: i.item_id };
  });
  return { type: "reservation", order: r.order, lines };
}

// An in_cart copy whose online cart hold ran out: put it (and the rest of that
// abandoned cart) back on the shelf with the cart's own release function, then
// return its till line. Refused with the time left while the hold is live.
async function releaseExpiredCartCopy(pool, copyId) {
  const { rows } = await pool.query(`SELECT ${COPY_COLUMNS()} FROM book_copies c JOIN books b ON b.id = c.book_id WHERE c.id = $1`, [copyId]);
  const r = rows[0];
  if (!r) throw new TillError("That copy could not be found.", 404);
  if (r.status === "in_cart") {
    if (!r.cart_expired) throw new TillError(refusal(r.title, "in_cart", r.cart_minutes_left), 409);
    if (r.cart_order_id) {
      await require("./cart").releaseCartHold(pool, r.cart_order_id, "expired");
    } else {
      await pool.query("UPDATE book_copies SET status = 'in_stock', cart_added_at = NULL, updated_at = now() WHERE id = $1 AND status = 'in_cart'", [copyId]);
    }
  }
  const after = (await pool.query(`SELECT ${COPY_COLUMNS()} FROM book_copies c JOIN books b ON b.id = c.book_id WHERE c.id = $1`, [copyId])).rows[0];
  if (after.status !== "in_stock") {
    throw new TillError(after.status === "sold" ? `"${after.title}" was just paid for online: it is sold.` : refusal(after.title, after.status, after.cart_minutes_left), 409);
  }
  return { line: copyLine(after), orderId: r.cart_order_id || null };
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

// The price the screen showed for a line (cents), or null when not sent.
function parseExpected(v) {
  if (v === undefined || v === null || v === "") return null;
  return /^\d{1,9}$/.test(String(v)) ? Number(v) : NaN;
}

// A price different from the asking price: free to raise it by up to 20%;
// anything lower, or higher by more, needs a reason and an admin.
function overrideRule(askingCents, cents) {
  if (cents === askingCents) return { override: false, needsReason: false };
  const below = cents < askingCents;
  const farAbove = cents * 100 > askingCents * (100 + OVERRIDE_UP_PERCENT);
  return { override: true, needsReason: below || farAbove };
}

// Turns what the browser sent into verified lines, locking copies and quick
// items. Must run inside a transaction (db is the client). lock: false is for
// the read-only check before payment. isAdmin: only an admin may override a
// price beyond the rule above.
async function buildLines(db, rawItems, { isAdmin = true, lock = true } = {}) {
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
    } else if (it.kind !== "manual" && it.kind !== "reserved") throw new TillError("A line could not be read.");
  }
  if (new Set(copyIds).size !== copyIds.length) throw new TillError("The same copy is on the sale twice.");
  const forUpdate = lock ? "FOR UPDATE" : "";

  // Reserved lines first: their ORDERS are locked before any copy (the order every
  // order action uses), and each must still be held for its order.
  const reservedRows = await lockReservedLines(db, rawItems.filter((it) => it.kind === "reserved"), TillError);
  const reservedCopyIds = [...reservedRows.values()].filter((r) => r.book_copy_id != null).map((r) => r.book_copy_id);
  if (reservedCopyIds.some((id) => copyIds.includes(id))) throw new TillError("The same copy is on the sale twice.");

  const copies = new Map();
  if (copyIds.length) {
    const { rows } = await db.query(
      `SELECT ${COPY_COLUMNS()} FROM book_copies c JOIN books b ON b.id = c.book_id
       WHERE c.id = ANY($1) ORDER BY c.id ${lock ? "FOR UPDATE OF c" : ""}`,
      [copyIds]
    );
    for (const r of rows) copies.set(r.id, r);
  }
  const quick = new Map();
  if (quickIds.length) {
    const { rows } = await db.query(`SELECT * FROM till_quick_items WHERE id = ANY($1) ORDER BY id ${forUpdate}`, [[...new Set(quickIds)]]);
    for (const r of rows) quick.set(r.id, r);
  }

  const lines = [];
  const quickQty = new Map();
  for (const it of rawItems) {
    const expected = parseExpected(it.expected);
    if (Number.isNaN(expected)) throw new TillError("A line price could not be read: reload the till page.", 422);
    if (it.kind === "reserved") {
      const row = reservedRows.get(it);
      const isBook = row.book_copy_id != null;
      lines.push({
        kind: "reserved", orderId: Number(it.orderId), itemId: Number(it.itemId), copyId: isBook ? row.book_copy_id : null,
        description: row.item_title, quantity: 1, unitCents: toCents(row.price), expectedCents: expected,
        category: isBook ? (row.condition === "new" ? "books_new" : "books_used") : "other",
      });
    } else if (it.kind === "book") {
      const copy = copies.get(Number(it.copyId));
      if (!copy) throw new TillError("A copy could not be found.");
      if (copy.status !== "in_stock") throw new TillError(refusal(copy.title, copy.status, copy.cart_minutes_left), 409);
      const asking = copyLine(copy).priceCents;
      const typed = it.price === undefined || it.price === null ? "" : String(it.price).trim();
      let cents;
      if (copy.condition === "new") {
        // Loi Lang: the publisher's price, at most 5% off.
        const pricing = inv.resolveCopyPricing("new", typed, copy.publisher_price);
        if (pricing.error) throw new TillError(`"${copy.title}": ${pricing.error}`);
        cents = toCents(pricing.price);
      } else if (typed === "") {
        if (asking === null) throw new TillError(`Enter a price for "${copy.title}": it has none yet.`);
        cents = asking;
      } else {
        const p = parseCents(typed, { label: `Price of "${copy.title}"` });
        if (p.error) throw new TillError(p.error);
        cents = p.cents;
      }
      // A book is never given away at the till (only a manual Donation line can be 0).
      if (cents <= 0) throw new TillError(`Enter a price above 0 for "${copy.title}".`);
      let original = null;
      let reason = cleanText(it.reason, REASON_MAX) || null;
      if (asking !== null && cents !== asking) {
        original = asking;
        const rule = overrideRule(asking, cents);
        if (rule.needsReason) {
          if (!isAdmin) throw new TillError(`Only an admin can change the price of "${copy.title}" like this (below the asking price, or more than ${OVERRIDE_UP_PERCENT}% above it).`, 403);
          if (!reason || reason.length < 3) throw new TillError(`Give a reason for changing the price of "${copy.title}" from ${eur(asking)} to ${eur(cents)}.`, 422);
        }
      } else {
        reason = null;
      }
      lines.push({
        kind: "book", copyId: copy.id, description: copy.title, quantity: 1, unitCents: cents,
        category: copy.condition === "new" ? "books_new" : "books_used", originalCents: original, reason, expectedCents: expected,
      });
    } else if (it.kind === "quick") {
      const q = quick.get(Number(it.id));
      if (!q || !q.active) throw new TillError("That quick item is no longer available.", 409);
      const qty = parseQty(it.quantity);
      quickQty.set(q.id, (quickQty.get(q.id) || 0) + qty);
      if (q.stock !== null && quickQty.get(q.id) > q.stock) throw new TillError(`Not enough "${q.name}" in stock (${q.stock} left).`, 409);
      lines.push({ kind: "quick", quickId: q.id, description: q.name, quantity: qty, unitCents: q.price_cents, category: q.category, expectedCents: expected });
    } else {
      const description = cleanText(it.description, DESCRIPTION_MAX + 1);
      if (!description) throw new TillError("A manual item needs a description.");
      if (description.length > DESCRIPTION_MAX) throw new TillError(`The description is limited to ${DESCRIPTION_MAX} characters.`);
      const p = parseCents(it.price, { label: "Price" });
      if (p.error) throw new TillError(p.error);
      const category = OTHER_CATEGORY_VALUES.has(it.category) ? it.category : null;
      if (!category) throw new TillError("Choose a category for the manual item.");
      // Only a Donation line may be 0.
      if (p.cents <= 0 && category !== "donation") throw new TillError("A manual item needs a price above 0.");
      lines.push({ kind: "manual", description, quantity: parseQty(it.quantity), unitCents: p.cents, category, expectedCents: expected });
    }
  }
  return { lines, quick };
}

const totalOf = (lines) => lines.reduce((a, l) => a + l.unitCents * l.quantity, 0);

// The sale must be above 0 and at most MAX_TOTAL_CENTS (the int4 column).
function checkTotal(totalCents) {
  if (totalCents > MAX_TOTAL_CENTS) {
    throw new TillError(`Sale total too large: the most the till takes in one sale is ${eur(MAX_TOTAL_CENTS)} (this one is ${eur(totalCents)}). Check the quantities and prices.`, 422, { code: "too_large" });
  }
  if (totalCents <= 0) throw new TillError("The total must be above 0.");
}

// The screen's total (and each line's price) must still be what the server
// charges: a price edited between scanning and confirming is refused, nothing is
// recorded, so the amount typed into the card reader can never differ from the sale.
function checkExpected(lines, totalCents, expectedTotalCents) {
  const exp = parseExpected(expectedTotalCents);
  if (exp === null || Number.isNaN(exp)) throw new TillError("The total shown on the screen was not sent with the sale: reload the till page.", 422, { code: "no_expected_total" });
  const changed = lines.filter((l) => l.expectedCents != null && l.expectedCents !== l.unitCents)
    .map((l) => ({ description: l.description, fromCents: l.expectedCents, toCents: l.unitCents }));
  if (changed.length || exp !== totalCents) {
    throw new TillError(`The price changed: new total ${eur(totalCents)} (the screen showed ${eur(exp)}).`, 409, { code: "price_changed", newTotalCents: totalCents, expectedTotalCents: exp, changed });
  }
}

// ---------- the sale day: lock, closed, backdating ----------

const DAY_LOCK_KEY = 7243902;
// A sale or void takes the Paris day's lock SHARED; closing or reopening takes it
// EXCLUSIVE, so a sale or void committing while the day is being closed cannot
// slip past the counted figures. Works before a till_days row exists.
function lockDay(client, day, mode = "share") {
  const fn = mode === "exclusive" ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared";
  return client.query(`SELECT ${fn}($1::int, ($2::date - DATE '2000-01-01'))`, [DAY_LOCK_KEY, day]);
}

// "now" in Paris: today and yesterday as dates.
async function parisToday(db) {
  const { rows } = await db.query(`SELECT (now() AT TIME ZONE '${TZ}')::date::text AS today, ((now() AT TIME ZONE '${TZ}')::date - 1)::text AS yesterday`);
  return rows[0];
}

// When the sale happened. Default: now. An earlier time (a sale written on
// paper while the internet was down) is admin-only, only today or yesterday, never
// in the future, and always needs a reason.
async function resolveSoldAt(db, { soldAtTime, soldAtDay, backdateReason, isAdmin }) {
  const t = String(soldAtTime == null ? "" : soldAtTime).trim();
  const dayChoice = String(soldAtDay == null ? "" : soldAtDay).trim() || "today";
  const { today, yesterday } = await parisToday(db);
  if (dayChoice !== "today" && dayChoice !== "yesterday") throw new TillError("A sale can only be dated today or yesterday.");
  if (!t && dayChoice === "today") return { at: null, adjusted: false, day: today, reason: null };
  if (!isAdmin) throw new TillError("Only an admin can enter a sale with an earlier time.", 403);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new TillError("The time must look like 14:30.");
  const reason = cleanText(backdateReason, REASON_MAX);
  if (reason.length < 3) throw new TillError("Give the reason this sale is entered with an earlier time (for example: internet was down).", 422, { code: "backdate_reason" });
  const day = dayChoice === "yesterday" ? yesterday : today;
  const { rows } = await db.query(`SELECT (($1::date + $2::time) AT TIME ZONE '${TZ}') AS t, now() AS n`, [day, t]);
  if (rows[0].t > rows[0].n) throw new TillError("The sale time cannot be in the future.");
  return { at: rows[0].t, adjusted: true, day, reason };
}

async function reopenInTx(client, day, why, userId) {
  const { rows } = await client.query("SELECT * FROM till_days WHERE day = $1::date FOR UPDATE", [day]);
  const row = rows[0];
  if (!row || !row.closed_at) return null;
  await client.query(
    `UPDATE till_days SET closed_at = NULL, closed_by = NULL, counted_cash_cents = NULL, expected_cash_cents = NULL, difference_cents = NULL,
            reopened_at = now(), reopened_by = $2, reopen_reason = $3
     WHERE day = $1::date`,
    [day, userId, why]
  );
  return { day, reason: why, previous: { counted: row.counted_cash_cents, expected: row.expected_cash_cents, difference: row.difference_cents } };
}

// A sale (or a check) on a closed day is refused unless an admin ticks "Reopen this day
// to record this sale" with a reason: that reopens the day (the close must then be
// done again). dry: only decide (the check before payment writes nothing).
async function ensureDayOpen(client, day, { reopen, reopenReason, isAdmin, userId, dry = false }) {
  const isClosed = async () => {
    const { rows } = await client.query("SELECT closed_at FROM till_days WHERE day = $1::date", [day]);
    return !!(rows[0] && rows[0].closed_at);
  };
  const closedError = async () => {
    const { today } = await parisToday(client);
    const what = day === today ? "Today's till is closed" : `The till for ${day} is closed`;
    return new TillError(`${what}: a sale cannot be added to a closed day. ${isAdmin ? "Tick \"Reopen this day to record this sale\" and give a reason, or" : "Ask an admin to reopen the day, or"} do not record it here.`, 409, { code: "day_closed", day });
  };
  const wantsReopen = reopen === true || reopen === "1" || reopen === "true" || reopen === "on";
  if (await isClosed()) {
    if (!wantsReopen) throw await closedError();
    if (!isAdmin) throw new TillError("Only an admin can reopen a closed day.", 403, { code: "day_closed", day });
    const why = cleanText(reopenReason, REASON_MAX);
    if (why.length < 3) throw new TillError("Give the reason for reopening the day.", 422, { code: "day_closed", day });
    if (dry) return { wouldReopen: true };
    await lockDay(client, day, "exclusive");
    return { reopened: await reopenInTx(client, day, why, userId) };
  }
  if (!dry) {
    await lockDay(client, day, "share");
    if (await isClosed()) throw await closedError(); // closed while we waited for the lock
  }
  return {};
}

// ---------- recording a sale ----------

// The receipt number of a sale: the next one of its Paris year, taken from the
// counter row, which this transaction holds locked until it commits or rolls
// back, so numbers are chronological, unique and gapless (sale ids may skip).
async function assignReceiptNumber(client, saleId) {
  const { rows } = await client.query(
    `WITH y AS (SELECT id, EXTRACT(YEAR FROM created_at AT TIME ZONE 'Europe/Paris')::int AS yr FROM till_sales WHERE id = $1),
          c AS (INSERT INTO till_receipt_counters (year, last_no) SELECT yr, 1 FROM y
                ON CONFLICT (year) DO UPDATE SET last_no = till_receipt_counters.last_no + 1 RETURNING year, last_no)
     UPDATE till_sales s SET receipt_year = c.year, receipt_no = c.last_no FROM c WHERE s.id = $1 RETURNING s.receipt_year, s.receipt_no`, [saleId]
  );
  return rows[0];
}

// "2026-0007"
const receiptNumber = (sale) => (sale && sale.receipt_no ? `${sale.receipt_year}-${String(sale.receipt_no).padStart(4, "0")}` : String(sale.id));

// Same token + same basket = the same sale. A hash of the payment method and the
// lines as the browser sent them (not the cash given, the time or a reason).
function basketHash(method, rawItems) {
  try {
    const norm = rawItems.map((it) => [
      it.kind,
      it.kind === "book" ? Number(it.copyId) : it.kind === "quick" ? Number(it.id) : it.kind === "reserved" ? `${Number(it.orderId)}-${Number(it.itemId)}` : `${cleanText(it.description, 81)}|${it.category}`,
      Number(it.quantity === undefined || it.quantity === "" ? 1 : it.quantity),
      it.kind === "quick" ? "" : String(it.price == null ? "" : it.price).trim(),
    ]).map((x) => JSON.stringify(x)).sort();
    return crypto.createHash("sha256").update(JSON.stringify([method, norm])).digest("hex");
  } catch {
    return null;
  }
}

const REPLAY_REFUSED = "This sale was already recorded with different items. Start a new sale (reload the till page).";
function duplicateAnswer(row, hash) {
  if (row.basket_hash && hash && row.basket_hash !== hash) throw new TillError(REPLAY_REFUSED, 409, { code: "token_replay" });
  return { saleId: row.id, totalCents: row.total_cents, changeCents: row.change_given_cents, duplicate: true, overrides: [], adjusted: false, reopened: null, collected: [] };
}

// input: { token, method, items, received, cardReference, cardConfirmed, expectedTotalCents,
//          soldAtTime, soldAtDay, backdateReason, reopen, reopenReason, userId, isAdmin }
// -> { saleId, totalCents, changeCents, duplicate, overrides: [{copyId, from, to, reason}], adjusted, reopened }
async function completeSale(pool, input) {
  const { token, method, items, received, cardReference, cardConfirmed, expectedTotalCents, userId, isAdmin = true } = input;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ""))) throw new TillError("The sale could not be identified: reload the till page.");
  if (method !== "cash" && method !== "card") throw new TillError("Choose Cash or Card.");
  const hash = basketHash(method, Array.isArray(items) ? items : []);

  // A retry of a sale that already went through (double click, lost answer): the first
  // sale again, unless the basket is different.
  const prior = await pool.query("SELECT id, total_cents, change_given_cents, basket_hash FROM till_sales WHERE sale_token = $1", [token]);
  if (prior.rows.length) return duplicateAnswer(prior.rows[0], hash);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const when = await resolveSoldAt(client, input);
    const dayState = await ensureDayOpen(client, when.day, { reopen: input.reopen, reopenReason: input.reopenReason, isAdmin, userId });
    const ins = await client.query(
      `INSERT INTO till_sales (staff_user_id, payment_method, total_cents, sale_token, created_at, adjusted_time, basket_hash, backdate_reason)
       VALUES ($1, $2, 0, $3, COALESCE($4, now()), $5, $6, $7) ON CONFLICT (sale_token) DO NOTHING RETURNING id`,
      [userId, method, token, when.at, when.adjusted, hash, when.reason]
    );
    if (!ins.rows.length) {
      // Two identical requests at once: the other one won.
      const { rows } = await client.query("SELECT id, total_cents, change_given_cents, basket_hash FROM till_sales WHERE sale_token = $1", [token]);
      await client.query("ROLLBACK");
      return duplicateAnswer(rows[0], hash);
    }
    const saleId = ins.rows[0].id;
    await assignReceiptNumber(client, saleId); // gapless per Paris year
    const { lines } = await buildLines(client, items, { isAdmin });
    const totalCents = totalOf(lines);
    checkTotal(totalCents);
    checkExpected(lines, totalCents, expectedTotalCents);

    let receivedCents = null;
    let changeCents = null;
    let ref = null;
    if (method === "cash") {
      const r = parseCents(received, { label: "Amount received", trailingDot: true });
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
        `INSERT INTO till_sale_items (sale_id, kind, copy_id, quick_item_id, description, quantity, unit_price_cents, category, original_price_cents, override_reason, reservation_order_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [saleId, l.kind === "reserved" ? (l.copyId ? "book" : "manual") : l.kind, l.copyId || null, l.quickId || null, l.description, l.quantity, l.unitCents, l.category,
          l.originalCents ?? null, l.reason ?? null, l.kind === "reserved" ? l.orderId : null]
      );
      if (l.kind === "reserved") {
        // Books and seats are sold by the order's own collection below (no shop_sales row:
        // the Sales report counts the order once, at paid_at).
        continue;
      }
      if (l.kind === "book") {
        await client.query(
          "INSERT INTO shop_sales (copy_id, price, sold_at, sold_by, payment_method, till_sale_id) VALUES ($1, $2, COALESCE($3, now()), $4, $5, $6)",
          [l.copyId, (l.unitCents / 100).toFixed(2), when.at, userId, method, saleId]
        );
        await client.query(
          `UPDATE book_copies SET status = 'sold', sold_at = COALESCE($2, now()), sold_via = 'till', reserved_by_name = NULL, reserved_by_email = NULL,
                  reserved_by_phone = NULL, reserved_at = NULL, cart_order_id = NULL, cart_added_at = NULL, updated_at = now()
           WHERE id = $1`,
          [l.copyId, when.at]
        );
        if (l.originalCents != null) overrides.push({ copyId: l.copyId, from: l.originalCents, to: l.unitCents, reason: l.reason });
      } else if (l.kind === "quick") {
        await client.query("UPDATE till_quick_items SET stock = stock - $2 WHERE id = $1 AND stock IS NOT NULL", [l.quickId, l.quantity]);
      }
    }
    // Pay the reservations: the same function as the admin's "Mark collected and paid".
    const collected = await collectReserved(client, lines.filter((l) => l.kind === "reserved"), { method, userId }, TillError);
    await client.query("COMMIT");
    return { saleId, totalCents, changeCents, duplicate: false, overrides, collected, adjusted: when.adjusted, backdateReason: when.reason, reopened: dayState.reopened || null, day: when.day };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// The same line building and validation as completeSale, WITHOUT writing anything:
// run when the Cash or Card screen opens, so a refusal shows BEFORE the customer pays.
// -> { totalCents, lines: [{ description, quantity, unitCents }] }
async function checkSale(pool, input) {
  const { items, method, expectedTotalCents, isAdmin = true, userId } = input;
  if (method !== "cash" && method !== "card") throw new TillError("Choose Cash or Card.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN"); // rolled back below (reserved lines take row locks, so not READ ONLY)
    const when = await resolveSoldAt(client, input);
    await ensureDayOpen(client, when.day, { reopen: input.reopen, reopenReason: input.reopenReason, isAdmin, userId, dry: true });
    const { lines } = await buildLines(client, items, { isAdmin, lock: false });
    const totalCents = totalOf(lines);
    checkTotal(totalCents);
    if (expectedTotalCents !== undefined && expectedTotalCents !== null && expectedTotalCents !== "") checkExpected(lines, totalCents, expectedTotalCents);
    return { totalCents, lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, unitCents: l.unitCents })) };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

// ---------- voiding ----------

const parisDay = (ts) => `(${ts} AT TIME ZONE '${TZ}')::date`;

// refundConfirmed: for a CARD sale, staff ticked "I refunded the card" (on the reader or
// in the SumUp app). Unticked voided card sales stay in Needs attention.
async function voidSale(pool, { saleId, reason, userId, refundConfirmed = false }) {
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
    // Shared with sales, exclusive against closing the day: a void that commits while the
    // day is being closed cannot change the expected cash after it was counted.
    await lockDay(client, sale.day, "share");
    const { rows: closed } = await client.query("SELECT 1 FROM till_days WHERE day = $1 AND closed_at IS NOT NULL FOR SHARE", [sale.day]);
    if (closed.length) throw new TillError("The day is closed: sales can no longer be voided.", 409);
    const { rows: items } = await client.query("SELECT * FROM till_sale_items WHERE sale_id = $1 ORDER BY id", [saleId]);
    const reservation = items.find((i) => i.reservation_order_id);
    if (reservation) {
      throw new TillError(`This sale collected reservation #${reservation.reservation_order_id}: it cannot be voided here. Open that reservation and use "Mark refunded" after giving the money back.`, 409);
    }
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
    const refunded = sale.payment_method === "card" && refundConfirmed === true;
    await client.query(
      `UPDATE till_sales SET status = 'voided', voided_at = now(), void_reason = $2, voided_by = $3,
              refund_confirmed = $4, refund_confirmed_at = CASE WHEN $4 THEN now() END, refund_confirmed_by = CASE WHEN $4 THEN $3::int END
       WHERE id = $1`, [saleId, why, userId, refunded]
    );
    await client.query("COMMIT");
    return { totalCents: sale.total_cents, copyIds, card: sale.payment_method === "card", refundConfirmed: refunded };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Staff ticked "I refunded the card" for a voided card sale (later, after the void).
async function confirmRefund(db, { saleId, userId }) {
  const { rows } = await db.query(
    `UPDATE till_sales SET refund_confirmed = true, refund_confirmed_at = now(), refund_confirmed_by = $2
     WHERE id = $1 AND status = 'voided' AND payment_method = 'card' AND NOT refund_confirmed RETURNING total_cents`,
    [saleId, userId]
  );
  if (!rows.length) throw new TillError("That sale is not a voided card sale waiting for a refund.", 409);
  return { totalCents: rows[0].total_cents };
}

// Voided card sales whose card refund has not been ticked: [{ id, day, total_cents }].
async function unrefundedVoids(db, day = null) {
  const { rows } = await db.query(
    `SELECT id, ${parisDay("created_at")}::text AS day, total_cents FROM till_sales
     WHERE status = 'voided' AND payment_method = 'card' AND NOT refund_confirmed
       AND ($1::date IS NULL OR ${parisDay("created_at")} = $1::date)
     ORDER BY created_at, id`, [day]
  );
  return rows;
}

// ---------- end of day ----------

// Sales of one Paris day, by payment method and category, plus the drawer maths.
// One query at a time: several on one pg client is deprecated (removed in pg 9).
async function daySummary(db, day) {
  const { rows: totals } = await db.query(
    `SELECT payment_method, status, COUNT(*)::int AS n, COALESCE(SUM(total_cents), 0)::int AS total
     FROM till_sales WHERE ${parisDay("created_at")} = $1::date GROUP BY 1, 2`, [day]);
  const { rows: cats } = await db.query(
    `SELECT i.category, COALESCE(SUM(i.quantity), 0)::int AS n, COALESCE(SUM(i.quantity * i.unit_price_cents), 0)::int AS total
     FROM till_sale_items i JOIN till_sales s ON s.id = i.sale_id
     WHERE ${parisDay("s.created_at")} = $1::date AND s.status = 'completed' GROUP BY 1 ORDER BY 1`, [day]);
  const { rows: dayRows } = await db.query("SELECT * FROM till_days WHERE day = $1::date", [day]);
  // Late entries: typed in after the day was closed (entered_at, not the sale time).
  const { rows: after } = await db.query(
    `SELECT COUNT(*)::int AS n FROM till_sales s JOIN till_days d ON d.day = $1::date AND d.closed_at IS NOT NULL
     WHERE ${parisDay("s.created_at")} = $1::date AND s.status = 'completed' AND s.entered_at > d.closed_at`, [day]);
  const unrefunded = await unrefundedVoids(db, day);
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
    closed: !!(row && row.closed_at), salesAfterClose: after[0].n, unrefunded,
  };
}

async function openDay(pool, { day, floatCents, userId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockDay(client, day, "exclusive");
    const { rows } = await client.query("SELECT closed_at FROM till_days WHERE day = $1::date FOR UPDATE", [day]);
    if (rows.length && rows[0].closed_at) throw new TillError("That day is already closed.", 409);
    await client.query(
      `INSERT INTO till_days (day, opening_float_cents, opened_by) VALUES ($1::date, $2, $3)
       ON CONFLICT (day) DO UPDATE SET opening_float_cents = EXCLUDED.opening_float_cents, opened_by = EXCLUDED.opened_by
       WHERE till_days.closed_at IS NULL`,
      [day, floatCents, userId]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// confirmNoFloat: closing a day whose opening float was never entered counts it as 0
// and needs this explicit confirmation.
async function closeDay(pool, { day, countedCents, note, userId, today, confirmNoFloat = false }) {
  if (day > today) throw new TillError("A future day cannot be closed.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Exclusive: no sale or void can commit while the expected cash is computed.
    await lockDay(client, day, "exclusive");
    const { rows } = await client.query("SELECT * FROM till_days WHERE day = $1::date FOR UPDATE", [day]);
    if (rows[0] && rows[0].closed_at) throw new TillError("That day is already closed.", 409);
    if (!rows[0]) {
      if (!confirmNoFloat) {
        throw new TillError("You did not enter an opening float: it will count as €0. Tick \"Close with no opening float (counts as €0)\" to confirm, or save the opening float first.", 409, { code: "no_float" });
      }
      await client.query("INSERT INTO till_days (day, opening_float_cents, opened_by) VALUES ($1::date, 0, $2)", [day, userId]);
    }
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

// An admin reopens a closed day (reason required): counted cash is cleared and the close
// must be done again.
async function reopenDay(pool, { day, reason, userId }) {
  const why = cleanText(reason, REASON_MAX);
  if (why.length < 3) throw new TillError("Give the reason for reopening the day.", 422);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockDay(client, day, "exclusive");
    const r = await reopenInTx(client, day, why, userId);
    if (!r) throw new TillError("That day is not closed.", 409);
    await client.query("COMMIT");
    return r;
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
  TillError, assignReceiptNumber, receiptNumber, OTHER_CATEGORIES, EXPORT_CATEGORY, DESCRIPTION_MAX, MAX_QTY, MAX_TOTAL_CENTS, OVERRIDE_UP_PERCENT, eur, toCents, parseCents, cashChange, cleanText,
  parseBarcode, checkBarcodeFree, SHOP_CODE_PREFIX, lookupScan, releaseExpiredCartCopy, buildLines, completeSale, checkSale, voidSale, confirmRefund,
  unrefundedVoids, daySummary, openDay, closeDay, reopenDay, unclosedDays, basketHash,
};
