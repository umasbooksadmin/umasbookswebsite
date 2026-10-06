const express = require("express");
const { saveImage } = require("../../lib/imageStore");
const { prepareCover } = require("../../lib/coverStore");
const { sharpFromUpload, reencodeForVision } = require("../../lib/uploadImage");
const { pool, withTransaction } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { normalizeIsbn, lookupByIsbn, searchByTitleAuthor, translateGenresToFrench } = require("../../lib/bookLookup");
const { extractBookInfoFromPhoto } = require("../../lib/coverVision");
const { generateBookDescription, translateDescriptionToFrench } = require("../../lib/bookDescription");
const { CONDITIONS, BINDINGS, STATUSES, SOURCES, normalizeSource, normalizeCondition, normalizeBinding, resolveCopyPricing, normalizeStatus, normalizeGenres, normalizeLocation, parseScan, isbnVariants } = require("../../lib/inventory");
const { expireStaleReservations } = require("../../lib/reservations");
const { checkBookAwardsInBackground } = require("../../lib/awards");
const { matchRequestsForCopy, matchRequestsForBook } = require("../../lib/bookRequests");
const { getSettings } = require("../../lib/pricing/settings");
const { prepareIntakeForm, priceUi, computeSuggestion } = require("../../lib/pricing/forms");
const { otherRepriceableCopies } = require("../../lib/pricing/clearance");
const { parseSuggestedPrice, normalizeSuggestedLevel, priceBasisFor, priceFromLevelChoice } = require("../../lib/pricing/intake");

const { validateIdParams } = require("../../middleware/idParams");
const { parseMoney, parseWholeNumber } = require("../../lib/validation");

const router = express.Router();
router.use("/admin/inventory", require("../../lib/priceColors").exposeToViews); // chips in the views
// Garbage ids get the 404 page, not a Postgres 22P02 and a 500.
validateIdParams(router, "id", "copyId");

// New copies default to a $0 cost / $5 price, but a book already in
// inventory should default to whatever its existing copies are set at.
async function getDefaultCopyPricing(isbn) {
  const defaults = { price: 5, acquisitionCost: 0 };
  if (!isbn) return defaults;
  const { rows } = await pool.query(
    `SELECT c.price, c.acquisition_cost FROM book_copies c
     JOIN books b ON b.id = c.book_id
     WHERE b.isbn = $1 ORDER BY c.created_at DESC LIMIT 1`,
    [isbn]
  );
  if (!rows.length) return defaults;
  return {
    price: rows[0].price != null ? Number(rows[0].price) : defaults.price,
    acquisitionCost: rows[0].acquisition_cost != null ? Number(rows[0].acquisition_cost) : defaults.acquisitionCost,
  };
}


// ---------- Price suggestions (see lib/pricing) ----------
// A suggestion is only ever shown: the volunteer accepts it or picks their own
// price. The suggestion that was on screen travels in hidden fields
// (suggestedPrice, suggestedLevel) so the save can record whether it was kept.
// The routes that compute suggestions live in priceSuggestions.js.
function learningFields(price, body, stored = {}) {
  const posted = body.suggestedPrice !== undefined || body.suggestedLevel !== undefined;
  const suggestedPrice = posted ? parseSuggestedPrice(body.suggestedPrice) : (stored.suggested_price != null ? Number(stored.suggested_price) : null);
  const suggestedLevel = posted ? normalizeSuggestedLevel(body.suggestedLevel) : (stored.suggested_level || null);
  return { suggestedPrice, suggestedLevel, priceBasis: priceBasisFor(price, suggestedPrice, suggestedLevel) };
}

// Best-effort cover lookup for books saved without one — tries the ISBN
// first (most precise), then falls back to a title/author search.
async function findCoverUrl({ isbn, title, author }) {
  if (isbn) {
    const byIsbn = await lookupByIsbn(isbn);
    if (byIsbn && byIsbn.coverUrl) return byIsbn.coverUrl;
  }
  if (title) {
    const candidates = await searchByTitleAuthor(title, author);
    const withCover = candidates.find((c) => c.coverUrl);
    if (withCover) return withCover.coverUrl;
  }
  return null;
}

// Render has no persistent disk, so an uploaded cover photo can't be
// saved to the filesystem — it's resized/compressed down to a small
// thumbnail, stored in the images table (lib/imageStore.js), and its short
// /img/<hash>.jpg URL goes in the same cover_url column a lookup-sourced
// image URL would go in.
async function processCoverPhoto(file) {
  const resized = await sharpFromUpload(file.buffer)
    .rotate()
    .resize(500, 700, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer();
  return saveImage(resized, "image/jpeg");
}

// Matching customers' book requests must never stop a book from being saved:
// a failure is logged and counts as "nothing matched".
async function matchBookRequests(fn) {
  try {
    return await fn();
  } catch (err) {
    console.error("Book request matching failed:", err.message);
    return 0;
  }
}

// ---------- Admin number inputs (one shared check, lib/validation.js) ----------
// A blank is allowed (not known); anything typed must be a real value.
const parsePublishedYear = (raw) =>
  parseWholeNumber(raw, { min: 1000, max: new Date().getFullYear() + 1, allowBlank: true, label: "Published year" });
const parseAcquisitionCost = (raw) => parseMoney(raw, { allowBlank: true, label: "Acquisition cost" });
// What to show back in a form after a refused value: the text as typed.
const asTyped = (raw) => (typeof raw === "string" ? raw.slice(0, 40) : "");

// ---------- Inventory ----------

// order_items point at copies with no ON DELETE action, so anything that has
// ever been ordered can't be deleted (Postgres 23503) — say so instead of 500.
const HAS_ORDERS_MESSAGE = "This item has orders, so it can't be deleted (mark it sold/archived instead).";
const AWARDS_NOTICES = {
  "status-kept": "Saved, but the status was not changed: that copy is sold or in a customer's checkout.",
  "awards-checked": "Awards check finished.",
  "awards-slow": "The awards check is taking a while. It keeps running in the background: reload this page in a minute.",
  "awards-added": "Awards added.",
  "awards-removed": "Award removed.",
  "awards-updated": "Award updated.",
};
const hasOrdersNotice = (req) => {
  if (req.query.notice === "has-orders") return HAS_ORDERS_MESSAGE;
  if (req.query.notice === "duplicate-isbn") return "Another book already has that ISBN, so the change was not saved.";
  if (typeof req.query.notice === "string" && Object.hasOwn(AWARDS_NOTICES, req.query.notice)) return AWARDS_NOTICES[req.query.notice];
  return null;
};

// Locations already in use, for the combo box (<datalist>) on every screen
// that has a location field. Values are stored normalised, so DISTINCT is
// already case-insensitive.
async function getLocations() {
  const { rows } = await pool.query(
    "SELECT DISTINCT location FROM book_copies WHERE location IS NOT NULL ORDER BY 1"
  );
  return rows.map((r) => r.location);
}

router.get("/admin/inventory", requireAdmin, async (req, res) => {
  await expireStaleReservations(pool);
  const q = (req.query.q || "").trim();
  const location = normalizeLocation(req.query.location);
  const params = [];
  const conditions = [];
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(b.title ILIKE $${params.length} OR b.authors ILIKE $${params.length} OR b.isbn ILIKE $${params.length})`);
  }
  if (location) {
    params.push(location);
    conditions.push(`EXISTS (SELECT 1 FROM book_copies lc WHERE lc.book_id = b.id AND lc.location = $${params.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows: books } = await pool.query(
    `SELECT b.*, COUNT(c.id)::int AS copy_count,
            COUNT(c.id) FILTER (WHERE c.status = 'in_stock')::int AS in_stock_count,
            string_agg(DISTINCT c.location, ', ' ORDER BY c.location)
              FILTER (WHERE c.status = 'in_stock' AND c.location IS NOT NULL) AS locations
     FROM books b LEFT JOIN book_copies c ON c.book_id = b.id
     ${where}
     GROUP BY b.id ORDER BY b.title ASC LIMIT 200`,
    params
  );
  res.render("admin/inventory/index", {
    active: "inventory", books, q, location: location || "", locations: await getLocations(), notice: hasOrdersNotice(req),
  });
});

router.get("/admin/inventory/scan", requireAdmin, async (req, res) => {
  res.render("admin/inventory/scan", {
    active: "inventory",
    error: null,
    saved: req.query.saved === "1",
    requestsMatched: req.query.saved === "1" ? Math.min(parseInt(req.query.requests, 10) || 0, 999) : 0,
    visionEnabled: !!process.env.ANTHROPIC_API_KEY,
    location: normalizeLocation(req.query.location) || "",
    source: normalizeSource(req.query.source) || "",
    sources: SOURCES,
    locations: await getLocations(),
  });
});

// ---------- Move books by scanning ----------
// Pick a destination location, then scan ISBN barcodes one after another:
// each scan moves ONE copy of that book to the destination. A scanner is a
// keyboard that types the code and presses Enter, so this is a plain form
// POST that re-renders the page with a running log (carried in a hidden
// field, display only; nothing in it is trusted for anything but showing).
const MOVABLE_STATUSES = ["in_stock", "reserved", "damaged"];
const LOG_KINDS = new Set(["moved", "already", "missing", "sold", "busy", "info", "error"]);
const LOG_LIMIT = 30;

function parseMoveLog(raw) {
  try {
    const arr = JSON.parse(String(raw || "[]"));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e) => e && LOG_KINDS.has(e.k) && typeof e.t === "string")
      .map((e) => ({ k: e.k, t: e.t.slice(0, 300) }))
      .slice(0, LOG_LIMIT);
  } catch {
    return [];
  }
}

async function renderMove(res, { dest, log, moved }) {
  res.render("admin/inventory/move", {
    active: "inventory", dest: dest || "", log, moved, locations: await getLocations(),
  });
}

router.get("/admin/inventory/move", requireAdmin, async (req, res) => {
  await renderMove(res, { dest: normalizeLocation(req.query.dest), log: [], moved: 0 });
});

// Moves one copy of the book with this ISBN to `dest`. Returns a log entry.
async function moveOneCopy(req, isbn, dest) {
  const { rows: all } = await pool.query(
    `SELECT b.title, c.status, c.location FROM books b JOIN book_copies c ON c.book_id = b.id
     WHERE b.isbn = ANY($1)`,
    [isbnVariants(isbn)]
  );
  if (!all.length) return { k: "missing", t: `Not in inventory: ${isbn}` };
  const title = all[0].title;
  // One statement picks the oldest movable copy not already there and moves
  // it; SKIP LOCKED keeps two scanners from grabbing the same copy.
  const { rows } = await pool.query(
    `WITH pick AS (
       SELECT c.id, c.location AS old_location
       FROM book_copies c JOIN books b ON b.id = c.book_id
       WHERE b.isbn = ANY($1) AND c.status = ANY($3) AND c.location IS DISTINCT FROM $2
       ORDER BY c.created_at ASC, c.id ASC LIMIT 1 FOR UPDATE OF c SKIP LOCKED
     )
     UPDATE book_copies SET location = $2, updated_at = now()
     FROM pick WHERE book_copies.id = pick.id
     RETURNING book_copies.id, pick.old_location`,
    [isbnVariants(isbn), dest, MOVABLE_STATUSES]
  );
  if (rows.length) {
    const from = rows[0].old_location;
    await audit(req, {
      action: "copy.move", targetType: "book_copy", targetId: rows[0].id,
      detail: `from ${from || "none"} to ${dest}`,
    });
    return { k: "moved", t: `Moved: ${title} (was ${from || "none"}) \u2192 ${dest}` };
  }
  if (all.some((c) => MOVABLE_STATUSES.includes(c.status))) return { k: "already", t: `Already at ${dest}: ${title}` };
  if (all.some((c) => c.status === "in_cart")) return { k: "busy", t: `Skipped, in a customer's cart: ${title}` };
  return { k: "sold", t: `Only sold or donated copies: ${title}` };
}

router.post("/admin/inventory/move", requireAdmin, async (req, res) => {
  const dest = normalizeLocation(req.body.dest);
  const prevDest = normalizeLocation(req.body.prevDest);
  const log = parseMoveLog(req.body.log);
  let moved = Math.max(0, Math.min(1e6, parseInt(req.body.moved, 10) || 0));
  const entries = [];

  if (dest && dest !== prevDest) entries.push({ k: "info", t: `Moving books to ${dest}` });

  const rawScan = String(req.body.scan || "").trim();
  if (rawScan) {
    const scan = parseScan(rawScan);
    if (!dest) {
      entries.push({ k: "error", t: "Choose where the books are going first." });
    } else if (scan.type !== "isbn") {
      entries.push({ k: "error", t: `Not a book barcode: ${rawScan.slice(0, 40)}` });
    } else {
      const entry = await moveOneCopy(req, scan.isbn, dest);
      if (entry.k === "moved") moved += 1;
      entries.push(entry);
    }
  }
  await renderMove(res, { dest, log: [...entries.reverse(), ...log].slice(0, LOG_LIMIT), moved });
});

// ---------- Sell in shop ----------
// A book sold over the counter: scan (or type) the ISBN, check the price and
// how it was paid, press "Record sale". The copy is marked sold and a
// shop_sales row is written in ONE transaction, with the copy row locked, so
// two people selling the same single copy cannot both succeed. Plain form
// POSTs (a scanner types the code and presses Enter), no JavaScript needed.
const SELLABLE_STATUSES = ["in_stock", "reserved"];
const PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "other", label: "Other" },
];
const PAYMENT_VALUES = new Set(PAYMENT_METHODS.map((m) => m.value));
const SELL_LOG_LIMIT = 10;

async function recentShopSales() {
  const { rows } = await pool.query(
    `SELECT s.id, s.price, s.sold_at, s.payment_method, b.title
     FROM shop_sales s JOIN book_copies c ON c.id = s.copy_id JOIN books b ON b.id = c.book_id
     ORDER BY s.sold_at DESC, s.id DESC LIMIT $1`,
    [SELL_LOG_LIMIT]
  );
  return rows;
}

// Price to suggest for a copy: its asking price, or for a new book with no
// asking price the publisher's price.
function suggestedPrice(copy) {
  if (copy.price != null) return Number(copy.price);
  if (copy.condition === "new" && copy.publisher_price != null) return Number(copy.publisher_price);
  return null;
}

async function renderSell(res, { status = 200, error = null, notice = null, isbn = "", copies = null, price = "" } = {}) {
  const recent = await recentShopSales();
  const list = copies ? copies.map((c) => ({ ...c, suggested: suggestedPrice(c) })) : null;
  res.status(status).render("admin/inventory/sell", {
    active: "inventory", error, notice, isbn, copies: list, price,
    prefillFor: list && list.length ? list[0].id : "",
    paymentMethods: PAYMENT_METHODS, recent, conditions: CONDITIONS,
  });
}

router.get("/admin/inventory/sell", requireAdmin, async (req, res) => {
  let notice = null;
  if (/^\d{1,9}$/.test(String(req.query.sold || ""))) {
    const { rows } = await pool.query(
      `SELECT s.price, b.title FROM shop_sales s JOIN book_copies c ON c.id = s.copy_id JOIN books b ON b.id = c.book_id WHERE s.id = $1`,
      [Number(req.query.sold)]
    );
    if (rows.length) notice = `Sale recorded: ${rows[0].title} for €${Number(rows[0].price).toFixed(2)}.`;
  }
  await renderSell(res, { notice });
});

router.post("/admin/inventory/sell", requireAdmin, async (req, res) => {
  await expireStaleReservations(pool);
  const copyIdRaw = String(req.body.copyId || "");

  // Step 1: an ISBN was scanned or typed: show the copy (or copies) for sale.
  if (!copyIdRaw) {
    const rawScan = String(req.body.isbn || "").trim();
    if (!rawScan) return renderSell(res, { error: "Scan or type an ISBN first." });
    const scan = parseScan(rawScan);
    if (scan.type !== "isbn") return renderSell(res, { error: `Not a book barcode: ${rawScan.slice(0, 40)}`, isbn: rawScan.slice(0, 40) });
    const { rows: known } = await pool.query("SELECT 1 FROM books WHERE isbn = ANY($1) LIMIT 1", [isbnVariants(scan.isbn)]);
    if (!known.length) return renderSell(res, { error: `Not in inventory: ${scan.isbn}`, isbn: scan.isbn });
    const { rows: copies } = await pool.query(
      `SELECT c.id, c.condition, c.price, c.publisher_price, c.location, c.status, b.title, b.authors
       FROM book_copies c JOIN books b ON b.id = c.book_id
       WHERE b.isbn = ANY($1) AND c.status = ANY($2)
       ORDER BY c.created_at ASC, c.id ASC LIMIT 20`,
      [isbnVariants(scan.isbn), SELLABLE_STATUSES]
    );
    if (!copies.length) {
      return renderSell(res, { error: `No copy of that book is available to sell (all sold, in a cart or withdrawn): ${scan.isbn}`, isbn: scan.isbn });
    }
    const first = suggestedPrice(copies[0]);
    return renderSell(res, { isbn: scan.isbn, copies, price: first != null ? first.toFixed(2) : "" });
  }

  // Step 2: record the sale.
  if (!/^\d{1,9}$/.test(copyIdRaw)) return renderSell(res, { status: 400, error: "That copy could not be found." });
  const copyId = Number(copyIdRaw);
  const payment = PAYMENT_VALUES.has(req.body.payment) ? req.body.payment : null;
  const rawPrice = String(req.body.price == null ? "" : req.body.price).trim();

  const result = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT c.id, c.condition, c.price, c.publisher_price, c.status, c.cart_order_id, b.title
       FROM book_copies c JOIN books b ON b.id = c.book_id WHERE c.id = $1 FOR UPDATE OF c`,
      [copyId]
    );
    const copy = rows[0];
    if (!copy) return { error: "That copy could not be found.", status: 400 };
    // A copy reserved online belongs to a reservation: it is sold from that order
    // ("Mark collected and paid"), which also records the payment. Selling it here
    // would leave the reservation holding a book that is gone.
    if (copy.status === "reserved" && copy.cart_order_id) {
      return { error: `Not sold: "${copy.title}" is reserved by order #${copy.cart_order_id}. Open that order to collect it (Mark collected and paid), or cancel the reservation first.`, status: 409 };
    }
    if (!SELLABLE_STATUSES.includes(copy.status)) {
      return { error: `Not sold: this copy of "${copy.title}" is no longer for sale (it was already sold or withdrawn).`, status: 409 };
    }
    // The price box was pre-filled for the first copy of the list; if another
    // copy was picked and the price was left as suggested, use the picked
    // copy's own asking price instead.
    let priceText = rawPrice;
    const prefillPrice = String(req.body.prefillPrice || "").trim();
    if (prefillPrice !== "" && String(req.body.prefillFor || "") !== String(copyId) && rawPrice === prefillPrice) {
      const own = suggestedPrice(copy);
      priceText = own != null ? own.toFixed(2) : "";
    }
    // The price is typed at the counter (a copy with no asking price can be
    // sold this way): it must still be real money (see parseMoney).
    const typedPrice = parseMoney(priceText, { label: "Price" });
    if (typedPrice.error) {
      const ask = "Enter the price the book was sold for (a number, 0 or more).";
      return { error: priceText === "" ? ask : `${ask} ${typedPrice.error}`, status: 400 };
    }
    // New books follow the fixed-price rule (publisher's price, at most 5% off).
    const pricing = resolveCopyPricing(copy.condition, priceText, copy.publisher_price);
    if (pricing.error) return { error: pricing.error, status: 400 };
    const price = typedPrice.value;
    const { rows: sale } = await client.query(
      "INSERT INTO shop_sales (copy_id, price, sold_by, payment_method) VALUES ($1, $2, $3, $4) RETURNING id",
      [copyId, price, req.session.user.id, payment]
    );
    await client.query(
      `UPDATE book_copies SET status = 'sold', reserved_by_name = NULL, reserved_by_email = NULL,
              reserved_by_phone = NULL, reserved_at = NULL, cart_order_id = NULL, cart_added_at = NULL, updated_at = now()
       WHERE id = $1`,
      [copyId]
    );
    return { saleId: sale[0].id, price };
  });

  if (result.error) return renderSell(res, { status: result.status, error: result.error });
  await audit(req, { action: "copy.shop_sale", targetType: "book_copy", targetId: copyId, detail: `price ${result.price.toFixed(2)}` });
  res.redirect(`/admin/inventory/sell?sold=${result.saleId}`);
});

router.post("/admin/inventory/lookup", requireAdmin, async (req, res) => {
  const visionEnabled = !!process.env.ANTHROPIC_API_KEY;
  const location = normalizeLocation(req.body.location) || "";
  const source = normalizeSource(req.body.source) || "";
  let book = null;
  let error = null;

  const scanPhoto = req.files && req.files.photo && req.files.photo[0];
  if (scanPhoto) {
    let photo;
    try {
      photo = await reencodeForVision(scanPhoto.buffer);
    } catch (err) {
      console.warn("Scan photo could not be decoded:", err.message);
      return res.render("admin/inventory/scan", {
        active: "inventory", visionEnabled, location, source, sources: SOURCES, locations: await getLocations(),
        error: "That file couldn't be read as an image — try another photo, or enter details manually below.",
      });
    }
    const info = await extractBookInfoFromPhoto(photo.buffer, photo.mimeType);
    if (!info || (!info.isbn && !info.title)) {
      return res.render("admin/inventory/scan", {
        active: "inventory", visionEnabled, location, source, sources: SOURCES, locations: await getLocations(),
        error: "Couldn't read anything useful from that photo — try a clearer shot, or enter details manually below.",
      });
    }
    if (info.isbn) {
      book = await lookupByIsbn(info.isbn);
    }
    if (!book && info.title) {
      const candidates = await searchByTitleAuthor(info.title, info.author);
      book = candidates[0] || null;
    }
    if (!book) {
      book = { isbn: info.isbn ? normalizeIsbn(info.isbn) : null, title: info.title, author: info.author, publisher: null, publishedYear: null, description: null, coverUrl: null, genre: null, genreFr: null, descriptionFr: null };
      error = "Found some details from the photo, but no catalog match — check everything below before saving.";
    }
  } else {
    const isbn = (req.body.isbn || "").trim();
    if (!isbn) {
      return res.render("admin/inventory/scan", { active: "inventory", visionEnabled, location, source, sources: SOURCES, locations: await getLocations(), error: "Enter an ISBN or choose a photo." });
    }
    book = await lookupByIsbn(isbn);
    if (!book) {
      book = { isbn: normalizeIsbn(isbn), title: null, author: null, publisher: null, publishedYear: null, description: null, coverUrl: null, genre: null, genreFr: null, descriptionFr: null };
      error = "No catalog match for that ISBN — enter the details manually below.";
    }
  }

  // The catalog gives an Open Library address: copy the cover to our own server now
  // so the preview (and the saved book) never load it from there (lib/coverStore.js).
  if (book.coverUrl) book = { ...book, coverUrl: (await prepareCover(book.coverUrl)).cover };

  const defaultPricing = await getDefaultCopyPricing(book.isbn);
  // The price starts at the suggestion for the form's default condition.
  const { rows: stocked } = book.isbn ? await pool.query("SELECT b.binding FROM books b WHERE b.isbn = ANY($1) LIMIT 1", [isbnVariants(normalizeIsbn(book.isbn))]) : { rows: [] };
  const suggestion = await prepareIntakeForm(res, { isbn: book.isbn, title: book.title, author: book.author, binding: book.binding || (stocked[0] && stocked[0].binding) });
  defaultPricing.price = suggestion.price;
  res.render("admin/inventory/new", { active: "inventory", book, error, fromScan: true, conditions: CONDITIONS, bindings: BINDINGS, statuses: STATUSES, defaultPricing, location, source, sources: SOURCES, locations: await getLocations() });
});

router.get("/admin/inventory/new", requireAdmin, async (req, res) => {
  const suggestion = await prepareIntakeForm(res, {});
  res.render("admin/inventory/new", {
    active: "inventory",
    book: { isbn: null, title: null, author: null, publisher: null, publishedYear: null, description: null, coverUrl: null, genre: null, genreFr: null, descriptionFr: null },
    error: null,
    fromScan: false,
    conditions: CONDITIONS, bindings: BINDINGS,
    statuses: STATUSES,
    defaultPricing: { price: suggestion.price, acquisitionCost: 0 },
    location: normalizeLocation(req.query.location) || "",
    source: normalizeSource(req.query.source) || "",
    sources: SOURCES,
    locations: await getLocations(),
  });
});

router.post("/admin/inventory/generate-description", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const author = (req.body.author || "").trim() || null;
  const publisher = (req.body.publisher || "").trim() || null;
  const publishedYear = parsePublishedYear(req.body.publishedYear).value ?? null;

  if (!title) return res.status(400).json({ error: "Enter a title first." });

  const description = await generateBookDescription({ title, author, publisher, publishedYear });
  if (!description) return res.status(502).json({ error: "Couldn't generate a description — try again, or write one manually." });
  const descriptionFr = await translateDescriptionToFrench(description);
  res.json({ description, descriptionFr });
});

router.post("/admin/inventory", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const author = (req.body.author || "").trim() || null;
  const isbn = req.body.isbn ? normalizeIsbn(req.body.isbn) : null;
  const publisher = (req.body.publisher || "").trim() || null;
  const yearCheck = parsePublishedYear(req.body.publishedYear);
  const publishedYear = yearCheck.error ? null : yearCheck.value;
  const genre = normalizeGenres(req.body.genre);
  let genreFr = (req.body.genreFr || "").trim() || (genre ? translateGenresToFrench(genre) : null);
  let description = (req.body.description || "").trim() || null;
  let descriptionFr = (req.body.descriptionFr || "").trim() || null;
  let coverUrl = (req.body.coverUrl || "").trim() || null;

  const binding = normalizeBinding(req.body.binding);
  const location = normalizeLocation(req.body.location);
  const source = normalizeSource(req.body.source);

  if (!title) {
    await prepareIntakeForm(res, { isbn, title: null, author, binding: req.body.binding, publisherPrice: req.body.publisherPrice });
    res.locals.priceLevelSelected = req.body.priceLevel;
    return res.render("admin/inventory/new", {
      active: "inventory", location: location || "", source: source || "", sources: SOURCES, locations: await getLocations(),
      book: { isbn, title: null, author, publisher, publishedYear, description, descriptionFr, coverUrl, genre, genreFr, binding },
      error: "Title is required.",
      fromScan: req.body.fromScan === "1",
      conditions: CONDITIONS, bindings: BINDINGS,
      statuses: STATUSES,
      defaultPricing: {
        price: req.body.price ? asTyped(req.body.price) : 5,
        acquisitionCost: req.body.acquisitionCost ? asTyped(req.body.acquisitionCost) : 0,
      },
    });
  }

  // Fixed-price rule for new books (see lib/inventory.js). Checked before
  // anything is saved so a refused copy leaves no half-created book behind.
  const condition = normalizeCondition(req.body.condition);
  const settings = await getSettings(pool);
  const choice = priceFromLevelChoice(condition, req.body, settings);
  const pricing = resolveCopyPricing(condition, choice.rawPrice, req.body.publisherPrice);
  const costCheck = parseAcquisitionCost(req.body.acquisitionCost);
  const inputError = pricing.error || yearCheck.error || costCheck.error;
  if (inputError) {
    await prepareIntakeForm(res, { isbn, title, author, binding: req.body.binding, condition, publisherPrice: req.body.publisherPrice });
    res.locals.priceLevelSelected = req.body.priceLevel;
    return res.render("admin/inventory/new", {
      active: "inventory", location: location || "", source: source || "", sources: SOURCES, locations: await getLocations(),
      book: { isbn, title, author, publisher, publishedYear: yearCheck.error ? asTyped(req.body.publishedYear) : publishedYear, description, descriptionFr, coverUrl, genre, genreFr, binding },
      error: inputError,
      fromScan: req.body.fromScan === "1",
      conditions: CONDITIONS, bindings: BINDINGS,
      statuses: STATUSES,
      selectedCondition: condition,
      publisherPriceValue: req.body.publisherPrice || "",
      defaultPricing: {
        price: req.body.price ? asTyped(req.body.price) : 5,
        acquisitionCost: req.body.acquisitionCost ? asTyped(req.body.acquisitionCost) : 0,
      },
    });
  }

  const coverPhoto = req.files && req.files.coverPhoto && req.files.coverPhoto[0];
  if (coverPhoto) coverUrl = await processCoverPhoto(coverPhoto);

  // A second physical copy of a book already in inventory (same ISBN)
  // should add a copy to that existing record, not create a duplicate
  // book entry — otherwise scanning a title you already stock splits
  // into a separate single-copy book instead of accumulating on one.
  let bookId = null;
  let isNewBook = false;
  if (isbn) {
    const { rows: existingRows } = await pool.query("SELECT * FROM books WHERE isbn = $1", [isbn]);
    if (existingRows.length) {
      const existing = existingRows[0];
      bookId = existing.id;
      // A second copy never overwrites what is already recorded: the binding
      // is only filled in when the book has none yet.
      if (binding && !existing.binding) {
        await pool.query("UPDATE books SET binding = $1, updated_at = now() WHERE id = $2", [binding, bookId]);
      }
      if (!existing.description || !existing.cover_url || !existing.description_fr) {
        const [genDescription, genCoverUrl] = await Promise.all([
          existing.description ? null : (description || generateBookDescription({ title, author, publisher, publishedYear })),
          existing.cover_url ? null : (coverUrl || findCoverUrl({ isbn, title, author })),
        ]);
        const finalDescription = existing.description || genDescription;
        const genDescriptionFr = existing.description_fr
          ? null
          : (descriptionFr || (finalDescription ? await translateDescriptionToFrench(finalDescription) : null));
        const genCover = await prepareCover(genCoverUrl);
        if (genDescription || genCover.cover || genCover.source || genDescriptionFr) {
          await pool.query(
            `UPDATE books SET description = COALESCE($1, description), cover_url = COALESCE($2, cover_url),
                    cover_source_url = COALESCE($5, cover_source_url),
                    cover_fetch_failures = CASE WHEN $5::text IS NULL THEN cover_fetch_failures ELSE 0 END,
                    description_fr = COALESCE($3, description_fr), updated_at = now() WHERE id = $4`,
            [genDescription, genCover.cover, genDescriptionFr, bookId, genCover.source]
          );
        }
      }
    }
  }

  if (!bookId) {
    [description, coverUrl] = await Promise.all([
      description || generateBookDescription({ title, author, publisher, publishedYear }),
      coverUrl || findCoverUrl({ isbn, title, author }),
    ]);
    descriptionFr = descriptionFr || (description ? await translateDescriptionToFrench(description) : null);
    // Copy the cover to our server (an external address is only kept as the download source).
    const cover = await prepareCover(coverUrl);

    const { rows } = await pool.query(
      `INSERT INTO books (isbn, title, authors, publisher, published_year, description, description_fr, cover_url, categories, categories_fr, binding, created_by, cover_source_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT DO NOTHING RETURNING id`,
      [isbn || null, title, author, publisher, publishedYear, description, descriptionFr, cover.cover, genre, genreFr, binding, req.session.user.id, cover.source]
    );
    if (rows.length) {
      bookId = rows[0].id;
      isNewBook = true;
    } else {
      // Another request added this ISBN between our lookup above and this
      // insert (books.isbn is unique, see migration 038) — use its record.
      const { rows: winner } = await pool.query("SELECT id FROM books WHERE isbn = $1", [isbn]);
      bookId = winner[0].id;
    }
  }

  const status = normalizeStatus(req.body.status);
  const { price, publisherPrice } = pricing;
  const acquisitionCost = costCheck.value;
  const acquiredAt = req.body.acquiredAt || null;
  const notes = (req.body.copyNotes || "").trim() || null;

  // What was suggested on screen, and whether it was kept (learning loop).
  const learning = learningFields(price, req.body);
  const suggestedClearance = learning.suggestedLevel === "clearance" && learning.suggestedPrice != null && price === learning.suggestedPrice;
  const isClearance = condition !== "new" && (choice.isClearance != null ? choice.isClearance : suggestedClearance);

  // With clearance scope "all", the volunteer may also put the book's other
  // copies on clearance (unticked by default): same transaction, one audit row each.
  const repriceOthers = settings.clearance.scope === "all" && isClearance && req.body.repriceOthers === "1"
    ? await otherRepriceableCopies(pool, isbn)
    : [];
  const copyRows = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO book_copies (book_id, condition, price, publisher_price, acquisition_cost, acquired_at, status, notes, location, source, created_by,
                                suggested_price, suggested_level, price_basis, is_clearance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [bookId, condition, price, publisherPrice, acquisitionCost, acquiredAt, status, notes, location, source, req.session.user.id,
        learning.suggestedPrice, learning.suggestedLevel, learning.priceBasis, isClearance]
    );
    for (const other of repriceOthers) {
      await client.query("UPDATE book_copies SET price = $1, is_clearance = true, updated_at = now() WHERE id = $2", [settings.clearance.price, other.id]);
    }
    return rows;
  });
  for (const other of repriceOthers) {
    await audit(req, {
      action: "copy.reprice", targetType: "book_copy", targetId: other.id,
      detail: `price ${other.price != null ? Number(other.price).toFixed(2) : "none"} -> ${Number(settings.clearance.price).toFixed(2)} (clearance)`,
    });
  }

  // Look up awards / best-seller lists in the background so they usually
  // appear within seconds. Never awaited: it must not delay or fail the save.
  if (isNewBook) checkBookAwardsInBackground(pool, bookId);

  // Customers who asked for this book (Requests page): matched now, the
  // banner on the book's page and the scan screen tells the admin.
  const requestsMatched = await matchBookRequests(() => matchRequestsForCopy(pool, bookId, copyRows[0].id));

  // The scan flow remembers the location and the source between books.
  if (req.body.fromScan === "1") {
    const extra = `${location ? `&location=${encodeURIComponent(location)}` : ""}${source ? `&source=${source}` : ""}${requestsMatched ? `&requests=${requestsMatched}` : ""}`;
    return res.redirect(`/admin/inventory/scan?saved=1${extra}`);
  }
  res.redirect(`/admin/inventory/${bookId}${requestsMatched ? `?requests=${requestsMatched}` : ""}`);
});

// `overlay` keeps what was typed in a form that was refused: { book: {column:
// value}, copy: {id, column: value} } is laid over the stored rows for display
// only (the copy's own form is opened). Nothing in it is saved.
async function renderBook(res, id, error = null, notice = null, overlay = {}) {
  await expireStaleReservations(pool);
  const { rows: bookRows } = await pool.query("SELECT * FROM books WHERE id = $1", [id]);
  const book = bookRows[0] && { ...bookRows[0], ...(overlay.book || {}) };
  if (!book) return res.status(404).render("404");
  const { rows: storedCopies } = await pool.query(
    "SELECT * FROM book_copies WHERE book_id = $1 ORDER BY created_at DESC", [id]
  );
  const copies = overlay.copy ? storedCopies.map((c) => (c.id === overlay.copy.id ? { ...c, ...overlay.copy } : c)) : storedCopies;
  if (overlay.copy) res.locals.openCopyId = overlay.copy.id;
  // Customers waiting for this book (matched to one of its copies, not yet notified).
  const { rows: asked } = await pool.query(
    `SELECT count(*)::int AS n FROM book_requests r JOIN book_copies c ON c.id = r.matched_copy_id
     WHERE c.book_id = $1 AND r.status = 'matched'`,
    [id]
  );
  const { rows: awards } = await pool.query(
    `SELECT a.*, u.display_name AS decided_by_name FROM book_awards a LEFT JOIN users u ON u.id = a.decided_by
     WHERE a.book_id = $1 ORDER BY (a.status = 'pending') DESC, a.year DESC NULLS LAST, lower(a.label)`, [id]
  );
  res.locals.priceUi = await priceUi(pool); // the price-level choices in each copy's form
  res.render("admin/inventory/show", { active: "inventory", book, copies, awards, conditions: CONDITIONS, bindings: BINDINGS, statuses: STATUSES, sources: SOURCES, error, notice, locations: await getLocations(), requestCount: asked[0].n });
}

router.get("/admin/inventory/:id", requireAdmin, (req, res) => renderBook(res, Number(req.params.id), null, hasOrdersNotice(req)));

router.post("/admin/inventory/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const title = (req.body.title || "").trim();
  const author = (req.body.author || "").trim() || null;
  const isbn = req.body.isbn ? normalizeIsbn(req.body.isbn) : null;
  const publisher = (req.body.publisher || "").trim() || null;
  const yearCheck = parsePublishedYear(req.body.publishedYear);
  const publishedYear = yearCheck.value ?? null;
  const genre = normalizeGenres(req.body.genre);
  let genreFr = (req.body.genreFr || "").trim() || (genre ? translateGenresToFrench(genre) : null);
  let description = (req.body.description || "").trim() || null;
  let descriptionFr = (req.body.descriptionFr || "").trim() || null;
  let coverUrl = (req.body.coverUrl || "").trim() || null;

  if (yearCheck.error) {
    return renderBook(res, id, yearCheck.error, null, {
      book: { isbn, title, authors: author, publisher, published_year: asTyped(req.body.publishedYear), description, description_fr: descriptionFr, cover_url: coverUrl },
    });
  }

  if (title) {
    const coverPhoto = req.files && req.files.coverPhoto && req.files.coverPhoto[0];
    if (coverPhoto) coverUrl = await processCoverPhoto(coverPhoto);

    [description, coverUrl] = await Promise.all([
      description || generateBookDescription({ title, author, publisher, publishedYear }),
      coverUrl || findCoverUrl({ isbn, title, author }),
    ]);
    descriptionFr = descriptionFr || (description ? await translateDescriptionToFrench(description) : null);
    const cover = await prepareCover(coverUrl);
    try {
      await pool.query(
        `UPDATE books SET isbn=$1, title=$2, authors=$3, publisher=$4, published_year=$5,
                description=$6, description_fr=$7, cover_url=$8, categories=$9, categories_fr=$10, binding=$11,
                cover_source_url = COALESCE($13, cover_source_url),
                cover_fetch_failures = CASE WHEN $13::text IS NULL THEN cover_fetch_failures ELSE 0 END, updated_at=now()
         WHERE id = $12`,
        [isbn || null, title, author, publisher, publishedYear, description, descriptionFr, cover.cover, genre, genreFr, normalizeBinding(req.body.binding), id, cover.source]
      );
    } catch (err) {
      if (err.code !== "23505") throw err;
      return res.redirect(`/admin/inventory/${id}?notice=duplicate-isbn`);
    }
    // A corrected title or ISBN may now fit a customer's request.
    await matchBookRequests(() => matchRequestsForBook(pool, id));
  }
  res.redirect(`/admin/inventory/${id}`);
});

router.post("/admin/inventory/:id/delete", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM books WHERE id = $1", [Number(req.params.id)]);
  } catch (err) {
    if (err.code !== "23503") throw err;
    return res.redirect(`/admin/inventory/${Number(req.params.id)}?notice=has-orders`);
  }
  await audit(req, { action: "book.delete", targetType: "book", targetId: Number(req.params.id) });
  res.redirect("/admin/inventory");
});

// A copy's status can change under an open edit form (sold in the shop, put in
// a cart at checkout, reserved by a customer). The form posts the status it was
// rendered with (renderedStatus); the status is only changed when the person
// picked a different one AND the copy still has the rendered status. A sold
// copy or one in somebody's checkout is never changed from this form. The other
// fields are saved either way.
// (in_cart is a status of its own, set by checkout, that the form does not offer.)
const statusLabelOf = (value) => (value === "in_cart" ? "In a cart" : (STATUSES.find((x) => x.value === value) || {}).label || value);
const isStatusValue = (value) => typeof value === "string" && STATUSES.some((x) => x.value === value);

router.post("/admin/inventory/:id/copies/:copyId", requireAdmin, async (req, res) => {
  const bookId = Number(req.params.id);
  const copyId = Number(req.params.copyId);
  const condition = normalizeCondition(req.body.condition);
  const settings = await getSettings(pool);
  const choice = priceFromLevelChoice(condition, req.body, settings);
  const pricing = resolveCopyPricing(condition, choice.rawPrice, req.body.publisherPrice);
  const costCheck = parseAcquisitionCost(req.body.acquisitionCost);
  const acquiredAt = req.body.acquiredAt || null;
  const notes = (req.body.notes || "").trim() || null;
  const location = normalizeLocation(req.body.location);
  const source = normalizeSource(req.body.source);
  // What was typed, kept in the form when something below is refused.
  const refused = (error, status = 200) => {
    // 200 like the other refused inventory forms; 409 for a copy that changed.
    res.status(status);
    return renderBook(res, bookId, error, null, {
      copy: {
        id: copyId, condition, notes, location, source,
        price: asTyped(choice.rawPrice), publisher_price: asTyped(req.body.publisherPrice), acquisition_cost: asTyped(req.body.acquisitionCost),
        ...(isStatusValue(req.body.status) ? { status: req.body.status } : {}),
        ...(isStatusValue(req.body.renderedStatus) ? { rendered_status: req.body.renderedStatus } : {}),
      },
    });
  };
  if (pricing.error) return refused(pricing.error);
  if (costCheck.error) return refused(costCheck.error);
  const { price, publisherPrice } = pricing;
  const acquisitionCost = costCheck.value;

  const outcome = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      "SELECT status, cart_order_id, location, price, suggested_price, suggested_level, is_clearance FROM book_copies WHERE id = $1 AND book_id = $2 FOR UPDATE",
      [copyId, bookId]
    );
    const stored = rows[0];
    if (!stored) return { missing: true };
    const wanted = isStatusValue(req.body.status) ? req.body.status : stored.status;
    const rendered = isStatusValue(req.body.renderedStatus) ? req.body.renderedStatus : stored.status;
    let newStatus = stored.status;
    let keptStatus = false;
    if (wanted !== rendered) {
      if (stored.status !== rendered) {
        return { error: `This copy changed since you opened the form (now: ${statusLabelOf(stored.status)}). Reload.`, status: 409 };
      }
      // A sold copy or one in somebody's checkout keeps its status; the other
      // fields are still saved (and the page says so).
      // A copy reserved online by a customer also keeps its status: it is released
      // from its order page (Cancel reservation), never from here.
      if (stored.status === "sold" || stored.status === "in_cart" || (stored.status === "reserved" && stored.cart_order_id)) keptStatus = true;
      else newStatus = wanted;
    }
    const startsReservation = newStatus === "reserved" && stored.status !== "reserved";
    const endsReservation = stored.status === "reserved" && newStatus !== "reserved";
    // The suggestion shown with the form (if any) is kept; otherwise what was
    // stored stays. A price chosen as "Clearance" marks the copy as clearance;
    // any other price change clears the mark.
    const learning = learningFields(price, req.body, stored);
    const unchangedPrice = stored.price != null && price != null && Math.round(Number(stored.price) * 100) === Math.round(price * 100);
    const isClearance = condition !== "new" && (choice.isClearance != null ? choice.isClearance : Boolean(stored.is_clearance) && unchangedPrice);
    // A reservation made from this form gets reserved_at like any other, so it
    // expires after the usual two weeks (lib/reservations.js); leaving
    // "reserved" clears who it was held for.
    await client.query(
      `UPDATE book_copies SET condition=$1, status=$2, price=$3, publisher_price=$4, acquisition_cost=$5, acquired_at=$6, notes=$7, location=$10, source=$11,
              suggested_price=$12, suggested_level=$13, price_basis=$14, is_clearance=$15,
              reserved_by_name = CASE WHEN $16::boolean THEN NULL ELSE reserved_by_name END,
              reserved_by_email = CASE WHEN $16::boolean THEN NULL ELSE reserved_by_email END,
              reserved_by_phone = CASE WHEN $16::boolean THEN NULL ELSE reserved_by_phone END,
              reminder_sent_at = CASE WHEN $16::boolean OR $17::boolean THEN NULL ELSE reminder_sent_at END,
              reserved_at = CASE WHEN $16::boolean THEN NULL WHEN $17::boolean THEN now() ELSE reserved_at END,
              updated_at=now()
       WHERE id = $8 AND book_id = $9`,
      [condition, newStatus, price, publisherPrice, acquisitionCost, acquiredAt, notes, copyId, bookId, location, source,
        learning.suggestedPrice, learning.suggestedLevel, learning.priceBasis, isClearance, endsReservation, startsReservation]
    );
    return { before: stored, keptStatus };
  });
  if (outcome.error) return refused(outcome.error, outcome.status);
  if (outcome.before && (outcome.before.location || null) !== location) {
    await audit(req, {
      action: "copy.move", targetType: "book_copy", targetId: copyId,
      detail: `from ${outcome.before.location || "none"} to ${location || "none"}`,
    });
  }
  res.redirect(`/admin/inventory/${bookId}${outcome.keptStatus ? "?notice=status-kept" : ""}`);
});

// The copy and its book, with what a price suggestion needs.
async function loadCopyForPricing(bookId, copyId) {
  const { rows } = await pool.query(
    `SELECT c.*, b.isbn, b.title, b.authors, b.binding
     FROM book_copies c JOIN books b ON b.id = c.book_id WHERE c.id = $1 AND c.book_id = $2`,
    [copyId, bookId]
  );
  return rows[0] || null;
}

// "Suggest price" on a copy's edit form (no JavaScript): shows the suggestion
// next to the form. The stored price is NOT touched, whatever the suggestion is.
router.post("/admin/inventory/:id/copies/:copyId/suggest", requireAdmin, async (req, res) => {
  const bookId = Number(req.params.id);
  const copyId = Number(req.params.copyId);
  const copy = await loadCopyForPricing(bookId, copyId);
  if (!copy) return res.redirect(`/admin/inventory/${bookId}`);
  const suggestion = await computeSuggestion({
    isbn: copy.isbn, title: copy.title, author: copy.authors, binding: copy.binding,
    condition: req.body.condition || copy.condition,
    publisherPrice: req.body.publisherPrice != null ? req.body.publisherPrice : copy.publisher_price,
  }, { copyId });
  res.locals.suggestFor = { copyId, suggestion };
  return renderBook(res, bookId);
});

// "Use this price": the one button that stores a suggestion. The suggestion is
// worked out again here (nothing posted by the page is trusted for the price).
router.post("/admin/inventory/:id/copies/:copyId/use-price", requireAdmin, async (req, res) => {
  const bookId = Number(req.params.id);
  const copyId = Number(req.params.copyId);
  const copy = await loadCopyForPricing(bookId, copyId);
  if (!copy) return res.redirect(`/admin/inventory/${bookId}`);
  const suggestion = await computeSuggestion({
    isbn: copy.isbn, title: copy.title, author: copy.authors, binding: copy.binding, condition: copy.condition, publisherPrice: copy.publisher_price,
  }, { copyId });
  if (suggestion.price == null) return renderBook(res, bookId, suggestion.needsReview ? `${suggestion.reviewMessage}: set this price by hand.` : "No price could be suggested: set it by hand.");
  const pricing = resolveCopyPricing(copy.condition, suggestion.price, copy.publisher_price);
  if (pricing.error) return renderBook(res, bookId, pricing.error);
  await pool.query(
    `UPDATE book_copies SET price=$1, suggested_price=$1, suggested_level=$2, price_basis='suggested', is_clearance=$3, updated_at=now()
     WHERE id = $4 AND book_id = $5`,
    [pricing.price, suggestion.levelText, copy.condition !== "new" && suggestion.clearance, copyId, bookId]
  );
  await audit(req, {
    action: "copy.reprice", targetType: "book_copy", targetId: copyId,
    detail: `price ${copy.price != null ? Number(copy.price).toFixed(2) : "none"} -> ${pricing.price.toFixed(2)}`,
  });
  res.redirect(`/admin/inventory/${bookId}`);
});

router.post("/admin/inventory/:id/copies/:copyId/cancel-reservation", requireAdmin, async (req, res) => {
  const bookId = Number(req.params.id);
  const copyId = Number(req.params.copyId);
  // Only a copy that is still reserved goes back to stock: one that was sold
  // since the page was opened must not be put back on sale. A copy reserved
  // online (it has an order) is released from that order's page instead.
  const { rows: held } = await pool.query("SELECT cart_order_id FROM book_copies WHERE id = $1 AND book_id = $2 AND status = 'reserved'", [copyId, bookId]);
  if (held[0] && held[0].cart_order_id) {
    res.status(409);
    return renderBook(res, bookId, `This copy is reserved by order #${held[0].cart_order_id}. Cancel or collect it from the order page (/admin/orders/${held[0].cart_order_id}).`);
  }
  const { rowCount } = await pool.query(
    `UPDATE book_copies SET status='in_stock', reserved_by_name=NULL, reserved_by_email=NULL,
            reserved_by_phone=NULL, reserved_at=NULL, reminder_sent_at=NULL, updated_at=now()
     WHERE id = $1 AND book_id = $2 AND status = 'reserved' AND cart_order_id IS NULL`,
    [copyId, bookId]
  );
  if (!rowCount) {
    const { rows } = await pool.query("SELECT status FROM book_copies WHERE id = $1 AND book_id = $2", [copyId, bookId]);
    if (rows.length) {
      res.status(409);
      return renderBook(res, bookId, `This reservation was already gone (the copy is now: ${statusLabelOf(rows[0].status)}). Nothing was changed.`);
    }
  }
  res.redirect(`/admin/inventory/${bookId}`);
});

router.post("/admin/inventory/:id/copies/:copyId/delete", requireAdmin, async (req, res) => {
  const bookId = Number(req.params.id);
  try {
    await pool.query("DELETE FROM book_copies WHERE id = $1 AND book_id = $2", [Number(req.params.copyId), bookId]);
  } catch (err) {
    if (err.code !== "23503") throw err;
    return res.redirect(`/admin/inventory/${bookId}?notice=has-orders`);
  }
  await audit(req, { action: "book_copy.delete", targetType: "book_copy", targetId: Number(req.params.copyId) });
  const { rows } = await pool.query("SELECT 1 FROM book_copies WHERE book_id = $1", [bookId]);
  if (!rows.length) {
    await pool.query("DELETE FROM books WHERE id = $1", [bookId]);
    await audit(req, { action: "book.delete", targetType: "book", targetId: bookId, detail: "last copy removed" });
    return res.redirect("/admin/inventory");
  }
  res.redirect(`/admin/inventory/${bookId}`);
});

module.exports = router;
