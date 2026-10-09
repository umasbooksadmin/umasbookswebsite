const express = require("express");
const { saveImage } = require("../../lib/imageStore");
const { prepareCover, isAllowedCoverUrl } = require("../../lib/coverStore");
const { isStoredImageUrl } = require("../../lib/imageStore");
const { sharpFromUpload, reencodeForVision } = require("../../lib/uploadImage");
const { pool, withTransaction } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { normalizeIsbn, lookupByIsbn, searchByTitleAuthor, translateGenresToFrench } = require("../../lib/bookLookup");
const { extractBookInfoFromPhoto } = require("../../lib/coverVision");
const { generateBookDescription, translateDescriptionToFrench } = require("../../lib/bookDescription");
const { CONDITIONS, BINDINGS, STATUSES, SOURCES, normalizeSource, normalizeCondition, normalizeBinding, resolveCopyPricing, normalizeStatus, normalizeGenres, normalizeLocation, uniqueLocations, locationKey, parseScan, isbnVariants } = require("../../lib/inventory");
const { expireStaleReservations } = require("../../lib/reservations");
const { checkBookAwardsInBackground } = require("../../lib/awards");
const { matchRequestsForCopy, matchRequestsForBook } = require("../../lib/bookRequests");
const { getSettings } = require("../../lib/pricing/settings");
const { prepareIntakeForm, priceUi, computeSuggestion } = require("../../lib/pricing/forms");
const { otherRepriceableCopies } = require("../../lib/pricing/clearance");
const { parseSuggestedPrice, normalizeSuggestedLevel, priceBasisFor, priceFromLevelChoice } = require("../../lib/pricing/intake");

const { setFlash, takeFlash } = require("../../lib/flash");
const { validateIdParams } = require("../../middleware/idParams");
const fastScan = require("../../lib/fastScan");
const { serverTiming } = require("../../lib/timing");
const { runAfterResponse } = require("../../lib/afterResponse");
const { fillBookGaps, findCoverUrl } = require("../../lib/bookFill");
const { parseMoney, parseWholeNumber } = require("../../lib/validation");

const router = express.Router();
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
const HAS_ORDERS_MESSAGE = "This item has reservations, so it can't be deleted (mark it sold/archived instead).";
const AWARDS_NOTICES = {
  "status-kept": "Saved, but the status was not changed: that copy is sold or in a customer's cart.",
  "awards-checked": "Awards check finished.",
  "awards-slow": "The awards check is taking a while. It keeps running in the background: reload this page in a minute.",
  "awards-added": "Awards added.",
  "awards-removed": "Award removed.",
};
const hasOrdersNotice = (req) => {
  if (req.query.notice === "has-orders") return HAS_ORDERS_MESSAGE;
  if (req.query.notice === "duplicate-isbn") return "Another book already has that ISBN, so the change was not saved.";
  if (typeof req.query.notice === "string" && Object.hasOwn(AWARDS_NOTICES, req.query.notice)) return AWARDS_NOTICES[req.query.notice];
  return null;
};

// Locations already in use, for the combo box (<datalist>) on every screen
// that has a location field. Values are kept as typed, so "Store" and "STORE"
// are different strings in the table but one place here: one entry per
// case-insensitive name, shown in its most common (then most recent) spelling.
async function getLocations() {
  const { rows } = await pool.query(
    "SELECT location, COUNT(*)::int AS count, MAX(updated_at) AS last FROM book_copies WHERE location IS NOT NULL GROUP BY location"
  );
  // The shop floor is always offered, even before a copy has been put there.
  const taken = new Set(rows.map((r) => locationKey(r.location)));
  const entries = taken.has(locationKey(fastScan.DEFAULT_LOCATION)) ? rows : [...rows, fastScan.DEFAULT_LOCATION];
  return uniqueLocations(entries);
}

// The add-book page is also used by the scan-in-a-row script, which saves with
// fetch and wants JSON back (a plain form post gets the redirect / page).
const wantsJson = (req) => req.accepts(["html", "json"]) === "json";

router.get("/admin/inventory", requireAdmin, async (req, res) => {
  await expireStaleReservations(pool);
  const q = (req.query.q || "").trim();
  const params = [];
  const conditions = [];
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(b.title ILIKE $${params.length} OR b.authors ILIKE $${params.length} OR b.isbn ILIKE $${params.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows: books } = await pool.query(
    `SELECT b.*, COUNT(c.id)::int AS copy_count,
            COUNT(c.id) FILTER (WHERE c.status = 'in_stock')::int AS in_stock_count,
            array_agg(DISTINCT c.location)
              FILTER (WHERE c.status = 'in_stock' AND c.location IS NOT NULL) AS location_list
     FROM books b LEFT JOIN book_copies c ON c.book_id = b.id
     ${where}
     GROUP BY b.id ORDER BY b.title ASC LIMIT 200`,
    params
  );
  // One entry per place, whatever its capitals ("Store" and "STORE" are one).
  for (const b of books) b.locations = b.location_list ? uniqueLocations(b.location_list).join(", ") : null;
  res.render("admin/inventory/index", {
    active: "inventory", books, q, notice: hasOrdersNotice(req),
  });
});

router.get("/admin/inventory/scan", requireAdmin, async (req, res) => {
  res.render("admin/inventory/scan", {
    active: "inventory",
    error: null,
    saved: req.query.saved === "1",
    requestsMatched: req.query.saved === "1" ? Math.min(parseInt(req.query.requests, 10) || 0, 999) : 0,
    visionEnabled: !!process.env.ANTHROPIC_API_KEY,
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
  // After a scan the POST redirects here with the running log (Post/Redirect/Get).
  const f = takeFlash(req, "move");
  if (f) return renderMove(res, { dest: normalizeLocation(f.dest), log: parseMoveLog(JSON.stringify(f.log)), moved: Math.max(0, Math.min(1e6, parseInt(f.moved, 10) || 0)) });
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
  await setFlash(req, "move", { dest, log: [...entries.reverse(), ...log].slice(0, LOG_LIMIT), moved });
  res.redirect(303, "/admin/inventory/move");
});

// ---------- Sell in shop (retired) ----------
// Sales are made at the Till (/admin/till). The old page is gone; its bookmarks and
// anything posting to it land on the Till with a note. The shop_sales table and its old
// rows stay: the reports and the accounting export still read them, and the till writes
// one shop_sales row per book it sells.
const sellRetired = (req, res) => res.redirect(302, "/admin/till?notice=sell-retired");
router.get("/admin/inventory/sell", requireAdmin, sellRetired);
router.post("/admin/inventory/sell", requireAdmin, sellRetired);

// The lookup answers with a redirect to GET /admin/inventory/lookup (Post/Redirect/Get):
// the result is carried once in the session, so Back never offers to resubmit it.
async function lookupDone(req, res, payload) {
  await setFlash(req, "lookup", payload);
  res.redirect(303, "/admin/inventory/lookup");
}

router.get("/admin/inventory/lookup", requireAdmin, async (req, res) => {
  const f = takeFlash(req, "lookup");
  if (!f) return res.redirect("/admin/inventory/scan");
  const visionEnabled = !!process.env.ANTHROPIC_API_KEY;
  const location = normalizeLocation(f.location) || fastScan.DEFAULT_LOCATION;
  const source = normalizeSource(f.source) || fastScan.DEFAULT_SOURCE;
  if (!f.book) {
    return res.render("admin/inventory/scan", { active: "inventory", visionEnabled, location, source, sources: SOURCES, locations: await getLocations(), error: f.error || null });
  }
  const book = f.book;
  const defaultPricing = await getDefaultCopyPricing(book.isbn);
  // The price starts at the suggestion for the form's default condition.
  const { rows: stocked } = book.isbn ? await pool.query("SELECT b.binding FROM books b WHERE b.isbn = ANY($1) LIMIT 1", [isbnVariants(normalizeIsbn(book.isbn))]) : { rows: [] };
  const suggestion = await prepareIntakeForm(res, { isbn: book.isbn, title: book.title, author: book.author, binding: book.binding || (stocked[0] && stocked[0].binding) });
  defaultPricing.price = suggestion.price;
  res.render("admin/inventory/new", { active: "inventory", book, error: f.error || null, fromScan: true, conditions: CONDITIONS, bindings: BINDINGS, statuses: STATUSES, defaultPricing, location, source, sources: SOURCES, locations: await getLocations() });
});

router.post("/admin/inventory/lookup", requireAdmin, async (req, res) => {
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
      return lookupDone(req, res, {
        location, source,
        error: "That file couldn't be read as an image — try another photo, or enter details manually below.",
      });
    }
    const info = await extractBookInfoFromPhoto(photo.buffer, photo.mimeType);
    if (!info || (!info.isbn && !info.title)) {
      return lookupDone(req, res, {
        location, source,
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
    if (wantsJson(req)) return res.status(422).json({ ok: false, error: "Title is required." });
      return lookupDone(req, res, { location, source, error: "Enter an ISBN or choose a photo." });
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

  await lookupDone(req, res, { book, error, location, source });
});

router.get("/admin/inventory/new", requireAdmin, async (req, res) => {
  const suggestion = await prepareIntakeForm(res, {});
  const d = fastScan.formDefaults(req.query, await fastScan.lastUsed(pool, req.session.user.id));
  const saved = await fastScan.savedCopy(pool, req.query.saved);
  res.render("admin/inventory/new", {
    active: "inventory",
    book: { isbn: null, title: null, author: null, publisher: null, publishedYear: null, description: null, coverUrl: null, genre: null, genreFr: null, descriptionFr: null, binding: d.binding },
    error: null,
    fromScan: false,
    conditions: CONDITIONS, bindings: BINDINGS,
    statuses: STATUSES,
    defaultPricing: { price: suggestion.price, acquisitionCost: 0 },
    location: d.location,
    locationQueried: d.locationQueried,
    queried: d.queried,
    source: d.source,
    sources: SOURCES,
    locations: await getLocations(),
    savedCopy: saved,
    savedRequests: saved ? Math.min(parseInt(req.query.requests, 10) || 0, 999) : 0,
    ...(d.condition ? { selectedCondition: d.condition } : {}),
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

router.post("/admin/inventory", requireAdmin, serverTiming("scan.save"), async (req, res) => {
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

  // A refused save shows the add-book form again with what was typed (see GET /admin/inventory/new/again).
  const intakeAgain = async (state) => {
    await setFlash(req, "intake", { location: location || "", source: source || "", fromScan: req.body.fromScan === "1", priceLevel: req.body.priceLevel, ...state });
    return res.redirect(303, "/admin/inventory/new/again");
  };
  const typedPricing = {
    price: req.body.price ? asTyped(req.body.price) : 5,
    acquisitionCost: req.body.acquisitionCost ? asTyped(req.body.acquisitionCost) : 0,
  };

  if (!title) {
    if (wantsJson(req)) return res.status(422).json({ ok: false, error: "Title is required." });
    return intakeAgain({
      prep: { isbn, title: null, author, binding: req.body.binding, publisherPrice: req.body.publisherPrice },
      book: { isbn, title: null, author, publisher, publishedYear, description, descriptionFr, coverUrl, genre, genreFr, binding },
      error: "Title is required.",
      defaultPricing: typedPricing,
    });
  }

  // Fixed-price rule for new books (see lib/inventory.js). Checked before
  // anything is saved so a refused copy leaves no half-created book behind.
  const condition = normalizeCondition(req.body.condition);
  const settings = await req.timing.time("settings", () => getSettings(pool));
  const choice = priceFromLevelChoice(condition, req.body, settings);
  const pricing = resolveCopyPricing(condition, choice.rawPrice, req.body.publisherPrice);
  const costCheck = parseAcquisitionCost(req.body.acquisitionCost);
  const inputError = pricing.error || yearCheck.error || costCheck.error;
  if (inputError) {
    if (wantsJson(req)) return res.status(422).json({ ok: false, error: inputError });
    return intakeAgain({
      prep: { isbn, title, author, binding: req.body.binding, condition, publisherPrice: req.body.publisherPrice },
      book: { isbn, title, author, publisher, publishedYear: yearCheck.error ? asTyped(req.body.publishedYear) : publishedYear, description, descriptionFr, coverUrl, genre, genreFr, binding },
      error: inputError,
      selectedCondition: condition,
      publisherPriceValue: req.body.publisherPrice || "",
      defaultPricing: typedPricing,
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
  let fillAfterSave = false;
  if (isbn) {
    const { rows: existingRows } = await req.timing.time("db", () => pool.query("SELECT * FROM books WHERE isbn = $1", [isbn]));
    if (existingRows.length) {
      const existing = existingRows[0];
      bookId = existing.id;
      // A second copy never overwrites what is already recorded: the binding
      // is only filled in when the book has none yet.
      if (binding && !existing.binding) {
        await pool.query("UPDATE books SET binding = $1, updated_at = now() WHERE id = $2", [binding, bookId]);
      }
      // A description, a French text or a cover the book still lacks is fetched AFTER the answer (lib/bookFill.js).
      if (!existing.description || !existing.cover_url || !existing.description_fr) fillAfterSave = true;
    }
  }

  if (!bookId) {
    // Only what is already known is stored now. The AI description, its French translation, the search for a
    // cover and the cover download all happen after the answer (fillBookGaps, below): they used to hold the
    // save back for 3 to 20 seconds. A cover address that is not yet a copy on our server is kept as the source.
    const cover = coverUrl && isStoredImageUrl(coverUrl)
      ? { cover: coverUrl, source: null }
      : { cover: null, source: coverUrl && isAllowedCoverUrl(coverUrl) ? coverUrl : null };
    fillAfterSave = true;

    const { rows } = await req.timing.time("db", () => pool.query(
      `INSERT INTO books (isbn, title, authors, publisher, published_year, description, description_fr, cover_url, categories, categories_fr, binding, created_by, cover_source_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT DO NOTHING RETURNING id`,
      [isbn || null, title, author, publisher, publishedYear, description, descriptionFr, cover.cover, genre, genreFr, binding, req.session.user.id, cover.source]

    ));
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
  const copyRows = await req.timing.time("db", () => withTransaction(pool, async (client) => {
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
  }));
  for (const other of repriceOthers) {
    await audit(req, {
      action: "copy.reprice", targetType: "book_copy", targetId: other.id,
      detail: `price ${other.price != null ? Number(other.price).toFixed(2) : "none"} -> ${Number(settings.clearance.price).toFixed(2)} (clearance)`,
    });
  }

  // Look up awards / best-seller lists in the background so they usually
  // appear within seconds. Never awaited: it must not delay or fail the save.
  if (isNewBook) checkBookAwardsInBackground(pool, bookId);

  // Cover, description and translation: fetched now that the copy is saved and the answer is on its way.
  if (fillAfterSave) {
    const hints = { isbn, title, author, publisher, publishedYear, description, descriptionFr, coverUrl };
    runAfterResponse(`fill book ${bookId}`, () => fillBookGaps(pool, bookId, hints));
  }

  // Customers who asked for this book (Requests page): matched now, the
  // banner on the book's page and the scan screen tells the admin.
  const requestsMatched = await req.timing.time("requests", () => matchBookRequests(() => matchRequestsForCopy(pool, bookId, copyRows[0].id)));

  // The one-screen add page (fast=1): back to a fresh form (a JSON answer for the fetch from the page itself).
  if (req.body.fast !== "0" && (req.body.fast === "1" || req.body.addAnother === "1" || req.body.fromScan === "1")) {
    const copyId = copyRows[0].id;
    if (wantsJson(req)) {
      return res.json({ ok: true, copyId, bookId, title, requests: requestsMatched });
    }
    return res.redirect(`/admin/inventory/new?${fastScan.carryQuery({ location, source, binding, condition, copyId, requests: requestsMatched })}`);
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

// A refused book or copy form answers with a redirect to the book's page
// (Post/Redirect/Get); the message, what was typed and a requested price
// suggestion are carried once in the session and picked up by the GET below.
async function bookBack(req, res, bookId, state) {
  await setFlash(req, `book-${bookId}`, state);
  res.redirect(303, `/admin/inventory/${bookId}`);
}

router.get("/admin/inventory/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const f = takeFlash(req, `book-${id}`);
  if (f && f.suggest) {
    const copy = await loadCopyForPricing(id, Number(f.suggest.copyId));
    if (copy) {
      const suggestion = await computeSuggestion({
        isbn: copy.isbn, title: copy.title, author: copy.authors, binding: copy.binding,
        condition: f.suggest.condition || copy.condition,
        publisherPrice: f.suggest.publisherPrice != null ? f.suggest.publisherPrice : copy.publisher_price,
      }, { copyId: copy.id });
      res.locals.suggestFor = { copyId: copy.id, suggestion };
    }
  }
  return renderBook(res, id, f && f.error ? String(f.error) : null, hasOrdersNotice(req), (f && f.overlay) || {});
});

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
    return bookBack(req, res, id, { error: yearCheck.error, overlay: {
      book: { isbn, title, authors: author, publisher, published_year: asTyped(req.body.publishedYear), description, description_fr: descriptionFr, cover_url: coverUrl },
    } });
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
  const refused = (error) => {
    return bookBack(req, res, bookId, { error, overlay: {
      copy: {
        id: copyId, condition, notes, location, source,
        price: asTyped(choice.rawPrice), publisher_price: asTyped(req.body.publisherPrice), acquisition_cost: asTyped(req.body.acquisitionCost),
        ...(isStatusValue(req.body.status) ? { status: req.body.status } : {}),
        ...(isStatusValue(req.body.renderedStatus) ? { rendered_status: req.body.renderedStatus } : {}),
      },
    } });
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
  if (outcome.error) return refused(outcome.error);
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
  return bookBack(req, res, bookId, { suggest: { copyId, condition: req.body.condition, publisherPrice: req.body.publisherPrice } });
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
  if (suggestion.price == null) return bookBack(req, res, bookId, { error: suggestion.needsReview ? `${suggestion.reviewMessage}: set this price by hand.` : "No price could be suggested: set it by hand." });
  const pricing = resolveCopyPricing(copy.condition, suggestion.price, copy.publisher_price);
  if (pricing.error) return bookBack(req, res, bookId, { error: pricing.error });
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
    return bookBack(req, res, bookId, { error: `This copy is reserved by reservation #${held[0].cart_order_id}. Cancel or collect it from the reservation page (/admin/orders/${held[0].cart_order_id}).` });
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
      return bookBack(req, res, bookId, { error: `This reservation was already gone (the copy is now: ${statusLabelOf(rows[0].status)}). Nothing was changed.` });
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
