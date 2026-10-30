const express = require("express");
const config = require("../../lib/config");
const { prepareCover } = require("../../lib/coverStore");
const { reencodeForVision } = require("../../lib/uploadImage");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { normalizeIsbn, isValidIsbn, lookupByIsbn, searchByTitleAuthor } = require("../../lib/bookLookup");
const { extractBookInfoFromPhoto } = require("../../lib/coverVision");
const { applyRulesToBook } = require("../../lib/genreRules");
const { genreFilterOptions } = require("../../lib/genreAdmin");
const { generateBookDescription } = require("../../lib/bookDescription");
const { CONDITIONS, BINDINGS, STATUSES, SOURCES, normalizeSource, normalizeBinding, conditionLabel, resolveCopyPricing, normalizeGenres, normalizeLocation, uniqueLocations, locationKey, parseScan, isbnVariants } = require("../../lib/inventory");
const { expireStaleReservations } = require("../../lib/reservations");
const { matchRequestsForBook } = require("../../lib/bookRequests");
const { prepareIntakeForm, priceUi, computeSuggestion } = require("../../lib/pricing/forms");

const { setFlash, takeFlash } = require("../../lib/flash");
const { validateIdParams } = require("../../middleware/idParams");
const fastScan = require("../../lib/fastScan");
const { parseIntakeInput, prepareIntake, intakeRefusal, saveBookAndCopy, afterSaveFollowUps, intakeAnswer, processCoverPhoto, parsePublishedYear, matchBookRequests, BUSY_MESSAGE } = require("../../lib/inventoryIntake");
const { asTyped, statusLabelOf, parseCopyEdit, priceCopyEdit, copyEditOverlay, updateCopy, cancelReservation, deleteBook, deleteCopy } = require("../../lib/inventoryCopies");
const { serverTiming } = require("../../lib/timing");
const { aiAdminLimiter, AI_LIMIT_MESSAGE } = require("../../middleware/rateLimits");
const { clean } = require("../../lib/validation");
const { getAiLimits, clampText, MAX_TITLE, MAX_AUTHOR } = require("../../lib/aiLimits");
const { findCoverUrl, coverOriginOf } = require("../../lib/bookFill");
const { COVER_ERRORS, COVER_NOTICES } = require("../../lib/coverEdit");
const { isStoredImageUrl } = require("../../lib/imageStore");
const { variantUrl } = require("../../lib/imageVariants");
const { parseIntParam } = require("../../lib/parseParams");
const anthropic = require("../../lib/anthropic");
const { validateSpec, buildSpecWhere, specCopyCondition, specOrderBy, specMatchingCopies, explainSpec, specParam } = require("../../lib/inventoryQuerySpec");
const { sentenceToSpec, MAX_SENTENCE } = require("../../lib/inventoryNlSearch");
const { parseInventoryFilters, hasAnyFilter, buildSearchWhere, copyMatchCondition, matchingCopies, filterLocations, filterQueryString, NO_LOCATION, NO_BINDING, NO_GENRE } = require("../../lib/inventorySearch");

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


// Price suggestions: the routes that compute them live in priceSuggestions.js; what a save records of
// them (learningFields) is in lib/inventoryCopies.js.

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
const ISBN_NOT_VALID = "That ISBN is not valid: check the digits.";

const LIST_LIMIT = 200;
const NL_FLASH = "inventory-nl";

// ?nl=<spec JSON> (a "Describe what you are looking for" search, see lib/inventoryQuerySpec.js): validated again on
// every request, whoever built the link. -> { spec } | { error } | null (no ?nl).
function nlFromQuery(req) {
  if (typeof req.query.nl !== "string" || !req.query.nl) return null;
  const v = validateSpec(req.query.nl);
  return v.ok ? { spec: v.spec } : { error: `This sentence-search link cannot be used: ${v.error}` };
}

router.get("/admin/inventory", requireAdmin, async (req, res) => {
  await expireStaleReservations(pool);
  const nlParsed = nlFromQuery(req);
  const nlFlash = takeFlash(req, NL_FLASH) || {};
  // A sentence search replaces the text search and the filters (the form above it starts empty again).
  const nlSpec = nlParsed && nlParsed.spec ? nlParsed.spec : null;
  const filters = parseInventoryFilters(nlSpec ? {} : req.query);
  const { q } = filters;
  const { conditions, params } = nlSpec ? buildSpecWhere(nlSpec) : buildSearchWhere(filters);
  const orderBy = nlSpec ? specOrderBy(nlSpec, params) : "b.title_sort, b.title, b.id";
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows: books } = await pool.query(
    `SELECT b.*, COUNT(c.id)::int AS copy_count,
            COUNT(c.id) FILTER (WHERE c.status = 'in_stock')::int AS in_stock_count,
            array_agg(DISTINCT c.location)
              FILTER (WHERE c.status = 'in_stock' AND c.location IS NOT NULL) AS location_list,
            COUNT(*) OVER()::int AS total_matches
     FROM books b LEFT JOIN book_copies c ON c.book_id = b.id
     ${where}
     GROUP BY b.id ORDER BY ${orderBy} LIMIT ${LIST_LIMIT}`,
    params
  );
  // One entry per place, whatever its capitals ("Store" and "STORE" are one).
  for (const b of books) b.locations = b.location_list ? uniqueLocations(b.location_list).join(", ") : null;
  // With a location/condition/price/date-received filter on, show the copies that matched.
  const matched = nlSpec ? await specMatchingCopies(pool, nlSpec, books.map((b) => b.id)) : await matchingCopies(pool, filters, books.map((b) => b.id));
  for (const b of books) b.matched_copies = matched.get(b.id) || [];
  const locations = (await filterLocations(pool)).slice();
  if (filters.location && filters.location !== NO_LOCATION && !locations.some((l) => locationKey(l) === locationKey(filters.location))) locations.push(filters.location);
  // The managed genres (Admin > Genres) first, then the other genres in use under "Other"; a hand-typed genre from the URL stays selectable.
  const { managed: genres, other: otherGenres } = await genreFilterOptions(pool, filters.genre && filters.genre !== NO_GENRE ? filters.genre : "");
  res.render("admin/inventory/index", {
    active: "inventory", books, q, notice: hasOrdersNotice(req),
    filters, filterErrors: filters.errors, filterActive: hasAnyFilter(filters),
    resultsQuery: nlSpec ? new URLSearchParams({ nl: specParam(nlSpec) }).toString() : filterQueryString(filters),
    nl: {
      active: !!nlSpec,
      understood: nlSpec ? explainSpec(nlSpec) : null,
      sentence: typeof nlFlash.sentence === "string" ? nlFlash.sentence : "",
      error: (nlParsed && nlParsed.error) || (typeof nlFlash.error === "string" ? nlFlash.error : null),
      enabled: anthropic.hasApiKey(),
      maxLength: MAX_SENTENCE,
    },
    showReceived: !!(filters.receivedFrom || filters.receivedTo || filters.receivedNone),
    totalMatches: books.length ? books[0].total_matches : 0, listLimit: LIST_LIMIT,
    locations, genres, otherGenres, NO_LOCATION, NO_BINDING, NO_GENRE, CONDITIONS, BINDINGS, conditionLabel,
  });
});

// "Describe what you are looking for": the sentence goes to the AI ONCE (lib/inventoryNlSearch.js), which answers a
// query spec; the validated spec goes in the URL of the results page (Post/Redirect/Get), so a reload, a link or the
// CSV download never calls the AI again. 10 a minute per admin (like the other AI buttons) plus the shared daily cap.
// Any failure goes back to the normal page with a message: the search box and the filters keep working.
const nlSearchLimiter = aiAdminLimiter({
  handler: async (req, res) => {
    await setFlash(req, NL_FLASH, { error: AI_LIMIT_MESSAGE, sentence: clean(req.body && req.body.ask, MAX_SENTENCE) });
    res.redirect(303, "/admin/inventory");
  },
});
router.post("/admin/inventory/ask", requireAdmin, nlSearchLimiter, async (req, res) => {
  const raw = typeof (req.body && req.body.ask) === "string" ? req.body.ask : "";
  const sentence = clean(raw, MAX_SENTENCE + 1);
  const [{ managed, other }, locations] = await Promise.all([genreFilterOptions(pool, ""), filterLocations(pool)]);
  const r = await sentenceToSpec(sentence, { genres: [...managed, ...other], locations });
  const shown = sentence.slice(0, MAX_SENTENCE);
  await audit(req, { action: "inventory.ai_search", targetType: "inventory", detail: `${r.ok ? "ok" : r.reason}: ${shown.slice(0, 200)}` });
  if (!r.ok) {
    await setFlash(req, NL_FLASH, { error: r.message, sentence: shown });
    return res.redirect(303, "/admin/inventory");
  }
  await setFlash(req, NL_FLASH, { sentence: shown });
  res.redirect(303, `/admin/inventory?${new URLSearchParams({ nl: specParam(r.spec) })}`);
});

// "Download all inventory (CSV)": the same files the nightly job emails and
// stores (lib/inventoryExport.js): one row per copy, or (?books=1) one row per
// book. No buyer or reservation-holder data. Streamed; logged like other CSV downloads.
router.get("/admin/inventory/export.csv", requireAdmin, async (req, res) => {
  const { writeCopiesCsv, writeBooksCsv } = require("../../lib/inventoryExport");
  const perBook = req.query.books === "1";
  const day = require("../../lib/reports").todayParis();
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="inventory${perBook ? "_books" : ""}_${day}.csv"`,
    "Cache-Control": "no-store",
  });
  const sink = (text) => (res.write(text) ? undefined : new Promise((resolve) => res.once("drain", resolve)));
  const result = await (perBook ? writeBooksCsv : writeCopiesCsv)(pool, sink);
  await audit(req, { action: "inventory.csv", targetType: "inventory", detail: `${perBook ? "per book" : "per copy"}: ${result.rows} rows` });
  res.end();
});

// "Download these results (CSV)": the same file format, but only what the search above shows: the same text search and
// filters (lib/inventorySearch.js buildSearchWhere, the list's own code), with no 200-book cap. One row per copy (only the
// copies that matched when a location/condition/price/date-received filter is on), or ?books=1 one row per matching book.
const RESULTS_EXPORT_MAX_ROWS = 50000;
router.get("/admin/inventory/results.csv", requireAdmin, async (req, res) => {
  const { writeCopiesCsv, writeBooksCsv, countRows } = require("../../lib/inventoryExport");
  const perBook = req.query.books === "1";
  // A sentence search (?nl=, validated again here: the AI is never called for a download) or the filters.
  const nlParsed = nlFromQuery(req);
  if (nlParsed && nlParsed.error) return res.status(400).type("text/plain; charset=utf-8").send(nlParsed.error);
  const nlSpec = nlParsed ? nlParsed.spec : null;
  const filters = parseInventoryFilters(nlSpec ? {} : req.query);
  const filter = { ...(nlSpec ? buildSpecWhere(nlSpec) : buildSearchWhere(filters)) };
  if (!perBook) filter.copyCondition = nlSpec ? (p, alias) => specCopyCondition(nlSpec, p, alias) : (p, alias) => copyMatchCondition(filters, p, alias);
  const total = await countRows(pool, perBook, filter);
  if (total > RESULTS_EXPORT_MAX_ROWS) {
    return res.status(413).type("text/plain; charset=utf-8").send(
      `This search has ${total} ${perBook ? "books" : "copies"}, more than the ${RESULTS_EXPORT_MAX_ROWS} a download can hold. Narrow the search, or use "Download all inventory".`);
  }
  const day = require("../../lib/reports").todayParis();
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="umas-inventory${perBook ? "-books" : ""}-filtered-${day}.csv"`,
    "Cache-Control": "no-store",
  });
  const sink = (text) => (res.write(text) ? undefined : new Promise((resolve) => res.once("drain", resolve)));
  const result = await (perBook ? writeBooksCsv : writeCopiesCsv)(pool, sink, { filter });
  await audit(req, { action: "inventory.csv", targetType: "inventory", detail: `filtered ${perBook ? "per book" : "per copy"}: ${result.rows} rows${nlSpec ? ", sentence search " + specParam(nlSpec).slice(0, 200) : filterQueryString(filters) ? ", search " + filterQueryString(filters).slice(0, 200) : ""}` });
  res.end();
});

router.get("/admin/inventory/scan", requireAdmin, async (req, res) => {
  res.render("admin/inventory/scan", {
    active: "inventory",
    error: null,
    saved: req.query.saved === "1",
    requestsMatched: req.query.saved === "1" ? parseIntParam(req.query.requests, { max: 999 }) : 0,
    visionEnabled: !!config.get("ANTHROPIC_API_KEY"),
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
  let moved = parseIntParam(req.body.moved, { max: 1e6 });
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
  const visionEnabled = !!config.get("ANTHROPIC_API_KEY");
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

// 10 a minute per admin for the requests that call the AI (a cover photo). Typing an ISBN calls no AI: not counted.
// The page shows the message (the no-JavaScript form posts here and gets the same page back with the message).
const photoLookupLimiter = aiAdminLimiter({
  skip: (req) => !(req.files && req.files.photo && req.files.photo[0]),
  handler: async (req, res) => {
    const payload = { location: normalizeLocation(req.body && req.body.location) || "", source: normalizeSource(req.body && req.body.source) || "", error: AI_LIMIT_MESSAGE };
    if (wantsJson(req)) return res.status(429).json({ ok: false, error: AI_LIMIT_MESSAGE });
    return lookupDone(req, res, payload);
  },
});
const descriptionLimiter = aiAdminLimiter();

router.post("/admin/inventory/lookup", requireAdmin, photoLookupLimiter, async (req, res) => {
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
      // At the shared daily AI cap the photo was not read at all: say so (lib/aiLimits.js).
      const cap = !info ? await getAiLimits().status() : { reached: false };
      return lookupDone(req, res, {
        location, source,
        error: cap.reached ? `${cap.message} Enter the ISBN or the details by hand.` : "Couldn't read anything useful from that photo — try a clearer shot, or enter details manually below.",
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
      book = { isbn: info.isbn && isValidIsbn(normalizeIsbn(info.isbn)) ? normalizeIsbn(info.isbn) : null, title: info.title, author: info.author, publisher: null, publishedYear: null, description: null, coverUrl: null, genre: null };
      error = "Found some details from the photo, but no catalog match — check everything below before saving.";
    }
  } else {
    const isbn = (req.body.isbn || "").trim();
    if (!isbn) {
    if (wantsJson(req)) return res.status(422).json({ ok: false, error: "Title is required." });
      return lookupDone(req, res, { location, source, error: "Enter an ISBN or choose a photo." });
    }
    // A number with a wrong check digit is not an ISBN: no catalog is asked.
    if (!isValidIsbn(normalizeIsbn(isbn))) return lookupDone(req, res, { location, source, error: ISBN_NOT_VALID });
    book = await lookupByIsbn(isbn);
    if (!book) {
      book = { isbn: normalizeIsbn(isbn), title: null, author: null, publisher: null, publishedYear: null, description: null, coverUrl: null, genre: null };
      error = "No catalog match for that ISBN — enter the details manually below.";
    }
  }

  // The catalog gives an Open Library address: copy the cover to our own server now
  // so the preview (and the saved book) never load it from there (lib/coverStore.js).
  if (book.coverUrl) book = { ...book, coverUrl: (await prepareCover(book.coverUrl)).cover, coverOrigin: "isbn" }; // a catalog cover is only ever for the exact ISBN

  await lookupDone(req, res, { book, error, location, source });
});

router.get("/admin/inventory/new", requireAdmin, async (req, res) => {
  const suggestion = await prepareIntakeForm(res, {});
  const d = fastScan.formDefaults(req.query, await fastScan.lastUsed(pool, req.session.user.id));
  const saved = await fastScan.savedCopy(pool, req.query.saved);
  res.render("admin/inventory/new", {
    active: "inventory",
    book: { isbn: null, title: null, author: null, publisher: null, publishedYear: null, description: null, coverUrl: null, genre: null, binding: d.binding },
    error: null,
    fromScan: false,
    conditions: CONDITIONS, bindings: BINDINGS,
    statuses: STATUSES,
    defaultPricing: { price: suggestion.price, acquisitionCost: 0 },
    location: d.location,
    locationQueried: d.locationQueried,
    queried: d.queried,
    firstUse: fastScan.firstUseValues(), // what "Reset choices" goes back to
    source: d.source,
    sources: SOURCES,
    locations: await getLocations(),
    savedCopy: saved,
    savedRequests: saved ? parseIntParam(req.query.requests, { max: 999 }) : 0,
    ...(d.condition ? { selectedCondition: d.condition } : {}),
  });
});

router.post("/admin/inventory/generate-description", requireAdmin, descriptionLimiter, async (req, res) => {
  // Only a bounded amount of text goes to the paid AI (a title in a request can be up to 100 KB).
  const title = clampText(req.body.title, MAX_TITLE);
  const author = clampText(req.body.author, MAX_AUTHOR) || null;
  const publisher = clampText(req.body.publisher, MAX_AUTHOR) || null;
  const publishedYear = parsePublishedYear(req.body.publishedYear).value ?? null;

  if (!title) return res.status(400).json({ error: "Enter a title first." });

  const description = await generateBookDescription({ title, author, publisher, publishedYear });
  if (!description) {
    const cap = await getAiLimits().status();
    if (cap.reached) return res.status(429).json({ error: `${cap.message} Write the description by hand.`, aiLimit: true });
    return res.status(502).json({ error: "Couldn't generate a description — try again, or write one manually." });
  }
  // English only: books have no French description (Sharon, 2026-10-28).
  res.json({ description });
});

// Idempotent: the form carries a one-time token (lib/intakeToken.js). The same token again returns the
// first save's answer; it never creates a second copy. A request WITHOUT a token (a page cached from before
// this existed) still saves as before, and is logged so it can be seen when those pages are gone.
// The rules and the SQL are in lib/inventoryIntake.js; this reads the request and answers it.
router.post("/admin/inventory", requireAdmin, serverTiming("scan.save"), async (req, res) => {
  const json = wantsJson(req);
  // A refused save shows the add-book form again with what was typed (see GET /admin/inventory/new/again).
  const refuse = async (input, kind, message) => {
    await setFlash(req, "intake", intakeRefusal(input, kind, message));
    return res.redirect(303, "/admin/inventory/new/again");
  };
  const answer = (input, saved, requests) => {
    const out = intakeAnswer(input, { copyId: saved.copyId, bookId: saved.bookId, title: saved.title, requests }, json);
    return out.json ? res.json(out.json) : res.redirect(out.redirect);
  };

  const parsed = parseIntakeInput(req.body, req.files);
  if (!parsed.ok) {
    if (json) return res.status(422).json({ ok: false, error: parsed.message });
    return refuse(parsed.value, "title", parsed.message);
  }
  const prepared = await prepareIntake(pool, parsed.value, { time: req.timing.time });
  if (!prepared.ok) {
    if (json) return res.status(422).json({ ok: false, error: prepared.message });
    return refuse(parsed.value, "input", prepared.message);
  }
  const input = prepared.value;
  const ctx = { userId: req.session.user.id, audit: (entry) => audit(req, entry), time: req.timing.time };

  const saved = await saveBookAndCopy(pool, input, ctx);
  if (saved.state === "duplicate") return answer(input, saved, saved.requests);
  if (saved.state === "busy") {
    if (json) return res.status(409).json({ ok: false, error: BUSY_MESSAGE });
    return refuse(input, "busy", BUSY_MESSAGE);
  }
  const requests = await afterSaveFollowUps(pool, saved, input, ctx);
  return answer(input, { ...saved, title: input.title }, requests);
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
  // The Cover card works on the STORED picture (not on what was typed in a refused form): a preview only for our own copy.
  const storedCover = bookRows[0].cover_url;
  const cover = { stored: isStoredImageUrl(storedCover), url: storedCover, preview: isStoredImageUrl(storedCover) ? variantUrl(storedCover, 450) : null, external: Boolean(storedCover) && !isStoredImageUrl(storedCover) };
  res.render("admin/inventory/show", { active: "inventory", cover, book, copies, awards, conditions: CONDITIONS, bindings: BINDINGS, statuses: STATUSES, sources: SOURCES, error, notice, locations: await getLocations(), requestCount: asked[0].n });
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
  // The sentence the Cover card shows after a rotate / crop / replace / remove (routes/admin/inventoryCover.js).
  const coverCode = typeof req.query.cover === "string" ? req.query.cover : "";
  if (Object.hasOwn(COVER_NOTICES, coverCode)) res.locals.coverMessage = { text: COVER_NOTICES[coverCode], error: false };
  else if (Object.hasOwn(COVER_ERRORS, coverCode)) res.locals.coverMessage = { text: COVER_ERRORS[coverCode].message, error: true };
  return renderBook(res, id, f && f.error ? String(f.error) : null, hasOrdersNotice(req), (f && f.overlay) || {});
});

// Saving a book with an EMPTY description makes the server write one with the paid AI (English only); that is
// counted against the same per-admin 10-a-minute limit as the other AI buttons. A normal save, with a description
// typed, never calls the AI to write one and is never limited. A refusal brings the admin back to the book with
// what was typed and the same sentence as the other AI buttons.
const bookEditLimiter = aiAdminLimiter({
  skip: (req) => !clean(req.body && req.body.title, 500) || Boolean(clean(req.body && req.body.description, 5000)),
  handler: (req, res) => {
    const b = req.body || {};
    return bookBack(req, res, Number(req.params.id), { error: AI_LIMIT_MESSAGE, overlay: {
      book: { isbn: clean(b.isbn, 40) || null, title: clean(b.title, 500), authors: clean(b.author, 500) || null, publisher: clean(b.publisher, 500) || null, published_year: clean(b.publishedYear, 10), description: "", cover_url: clean(b.coverUrl, 1000) || null },
    } });
  },
});

router.post("/admin/inventory/:id", requireAdmin, bookEditLimiter, async (req, res) => {
  const id = Number(req.params.id);
  const title = (req.body.title || "").trim();
  const author = (req.body.author || "").trim() || null;
  const isbn = req.body.isbn ? normalizeIsbn(req.body.isbn) : null;
  const publisher = (req.body.publisher || "").trim() || null;
  const yearCheck = parsePublishedYear(req.body.publishedYear);
  const publishedYear = yearCheck.value ?? null;
  let genre = normalizeGenres(req.body.genre);
  ({ genre } = await applyRulesToBook(pool, genre)); // the genre rules of Admin > Genres (none saved: unchanged)
  // Books have no French genre or description (Sharon, 2026-10-28): a posted French genre / description field is ignored.
  let description = (req.body.description || "").trim() || null;
  let coverUrl = (req.body.coverUrl || "").trim() || null;

  if (yearCheck.error) {
    return bookBack(req, res, id, { error: yearCheck.error, overlay: {
      book: { isbn, title, authors: author, publisher, published_year: asTyped(req.body.publishedYear), description, cover_url: coverUrl },
    } });
  }

  if (title) {
    const coverPhoto = req.files && req.files.coverPhoto && req.files.coverPhoto[0];
    if (coverPhoto) coverUrl = await processCoverPhoto(coverPhoto);

    // A cover removed on purpose (Cover card, migration 098) is not looked up again by saving the details.
    const { rows: [current] } = await pool.query("SELECT cover_url, cover_removed_at FROM books WHERE id = $1", [id]);
    // How the cover was chosen (migration 111): a photo, an address that differs from the stored one (typed), or found by ISBN.
    let coverOrigin = coverPhoto ? "photo" : (coverUrl && !(current && coverUrl === current.cover_url) ? coverOriginOf(coverUrl) : null);
    const coverRemoved = Boolean(current && current.cover_removed_at);
    const typedCover = coverUrl;
    [description, coverUrl] = await Promise.all([
      description || generateBookDescription({ title, author, publisher, publishedYear }),
      coverUrl || (coverRemoved ? null : findCoverUrl({ isbn })), // exact ISBN only, never a title search
    ]);
    if (!typedCover && coverUrl) coverOrigin = "isbn";
    const cover = await prepareCover(coverUrl);
    try {
      await pool.query(
        `UPDATE books SET isbn=$1, title=$2, authors=$3, publisher=$4, published_year=$5,
                description=$6, cover_url=$7, categories=$8, binding=$9,
                cover_removed_at = CASE WHEN $7::text IS NULL AND $11::text IS NULL THEN cover_removed_at ELSE NULL END,
                cover_source_url = COALESCE($11, cover_source_url),
                cover_origin = COALESCE($12, cover_origin),
                cover_checked_at = CASE WHEN $12::text IS NULL THEN cover_checked_at ELSE NULL END,
                cover_fetch_failures = CASE WHEN $11::text IS NULL THEN cover_fetch_failures ELSE 0 END, updated_at=now()
         WHERE id = $10`,
        [isbn || null, title, author, publisher, publishedYear, description, cover.cover, genre, normalizeBinding(req.body.binding), id, cover.source, cover.cover || cover.source ? coverOrigin : null]
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
  const id = Number(req.params.id);
  const outcome = await deleteBook(pool, id, { audit: (entry) => audit(req, entry) });
  if (outcome.hasOrders) return res.redirect(`/admin/inventory/${id}?notice=has-orders`);
  res.redirect("/admin/inventory");
});

router.post("/admin/inventory/:id/copies/:copyId", requireAdmin, async (req, res) => {
  const bookId = Number(req.params.id);
  const copyId = Number(req.params.copyId);
  const input = parseCopyEdit(req.body);
  const priced = await priceCopyEdit(pool, bookId, input);
  // What was typed, kept in the form when something is refused.
  const refused = (error) => bookBack(req, res, bookId, { error, overlay: copyEditOverlay(copyId, input, priced.choice) });
  if (priced.error) return refused(priced.error);

  const outcome = await updateCopy(pool, bookId, copyId, input, priced);
  if (outcome.error) return refused(outcome.error);
  if (outcome.before && (outcome.before.location || null) !== input.location) {
    await audit(req, {
      action: "copy.move", targetType: "book_copy", targetId: copyId,
      detail: `from ${outcome.before.location || "none"} to ${input.location || "none"}`,
    });
  }
  res.redirect(`/admin/inventory/${bookId}${outcome.keptStatus ? "?notice=status-kept" : ""}`);
});

// The copy and its book, with what a price suggestion needs.
async function loadCopyForPricing(bookId, copyId) {
  const { rows } = await pool.query(
    `SELECT c.*, b.isbn, b.title, b.authors, b.binding, b.published_year
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
  const pricing = resolveCopyPricing(copy.condition, suggestion.price, copy.publisher_price, { publishedYear: copy.published_year });
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
  const outcome = await cancelReservation(pool, bookId, copyId);
  if (outcome.orderId) {
    return bookBack(req, res, bookId, { error: `This copy is reserved by reservation #${outcome.orderId}. Cancel or collect it from the reservation page (/admin/orders/${outcome.orderId}).` });
  }
  if (outcome.gone) {
    return bookBack(req, res, bookId, { error: `This reservation was already gone (the copy is now: ${statusLabelOf(outcome.gone)}). Nothing was changed.` });
  }
  res.redirect(`/admin/inventory/${bookId}`);
});

router.post("/admin/inventory/:id/copies/:copyId/delete", requireAdmin, async (req, res) => {
  const bookId = Number(req.params.id);
  const outcome = await deleteCopy(pool, bookId, Number(req.params.copyId), { audit: (entry) => audit(req, entry) });
  if (outcome.hasOrders) return res.redirect(`/admin/inventory/${bookId}?notice=has-orders`);
  if (outcome.bookRemoved) return res.redirect("/admin/inventory");
  res.redirect(`/admin/inventory/${bookId}`);
});

module.exports = router;
