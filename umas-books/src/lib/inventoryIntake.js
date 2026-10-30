// Adding a copy of a book (POST /admin/inventory): the rules, the SQL and the follow-ups. The route
// only reads the request and answers (see ARCHITECTURE.md, "Where SQL lives"):
//
//   parseIntakeInput(body, files)        the form, read and normalised. Pure.
//   prepareIntake(db, input, { time })   prices the copy (settings, the 2-year rule); the first refusal, if any
//   intakeRefusal(input, kind, message)  what the add-book form shows again after a refusal (flash state)
//   saveBookAndCopy(pool, input, ctx)    one-time token, cover photo, the book (new or existing), the copy
//   afterSaveFollowUps(pool, saved, input, ctx)   awards, cover/description fill, customers' requests
//   intakeAnswer(input, saved, wantsJson) how a saved copy is answered: JSON or a redirect
//
// ctx: { userId, audit(entry), time(label, fn) } (time and audit are optional).
// Behaviour is pinned by test/integration/intakeGolden.test.js.

const { withTransaction } = require("../db");
const { saveImage, isStoredImageUrl } = require("./imageStore");
const { isAllowedCoverUrl } = require("./coverStore");
const { sharpFromUpload } = require("./uploadImage");
const { normalizeIsbn, isValidIsbn } = require("./bookLookup");
const { isbn10to13 } = require("./bookSources");
const { applyRulesToBook } = require("./genreRules");
const { normalizeSource, normalizeCondition, normalizeBinding, resolveCopyPricing, normalizeStatus, normalizeGenres, normalizeLocation, isbnVariants } = require("./inventory");
const { getSettings } = require("./pricing/settings");
const { otherRepriceableCopies } = require("./pricing/clearance");
const { priceFromLevelChoice } = require("./pricing/intake");
const { parseWholeNumber, parseDay } = require("./validation");
const { checkBookAwardsInBackground } = require("./awards");
const { matchRequestsForCopy } = require("./bookRequests");
const { runAfterResponse } = require("./afterResponse");
const { fillBookGaps } = require("./bookFill");
const intakeToken = require("./intakeToken");
const fastScan = require("./fastScan");
const { learningFields, parseAcquisitionCost, asTyped } = require("./inventoryCopies");

const TITLE_REQUIRED = "Title is required.";
// Longest text the add-book form accepts (a 50,000-character title was once saved). Generous for real books.
const TEXT_LIMITS = [
  ["title", "Title", 300], ["author", "Author", 300], ["publisher", "Publisher", 200],
  ["description", "Description", 5000], ["notes", "Copy notes", 1000],
];
const INVALID_ISBN = "That ISBN is not valid (wrong length or check digit). Check the number on the back cover, or leave the ISBN empty to save the book without one.";
const BUSY_MESSAGE = "This book is already being saved. Wait a moment and check the book list before saving it again.";

// A blank is allowed (not known); anything typed must be a real value.
const parsePublishedYear = (raw) =>
  parseWholeNumber(raw, { min: 1000, max: new Date().getFullYear() + 1, allowBlank: true, label: "Published year" });

const passthroughTime = (label, fn) => fn();

// ---------- Read the form ----------

// -> { ok: true, value } | { ok: false, field: "title", message, value }.
// `value` is the form as understood, also on a refusal (the form is shown again with it). Only the
// title is refused here; the numbers (published year, acquisition cost, date acquired) are checked
// and kept in value.yearCheck / costCheck / acquiredCheck, and the price rules need the database:
// prepareIntake() gives the first refusal in the order the form always did.
function parseIntakeInput(body, files) {
  const title = (body.title || "").trim();
  const author = (body.author || "").trim() || null;
  // ISBN: blank is allowed (a book with none). Anything typed must be a real ISBN-10 or ISBN-13; an ISBN-10 is
  // stored as its ISBN-13 so the same book never exists twice (the existing-book lookup also accepts both forms).
  const typedIsbn = String(body.isbn || "").trim() ? normalizeIsbn(body.isbn) : null;
  const isbnOk = !typedIsbn || isValidIsbn(typedIsbn);
  const isbnBlankJunk = Boolean(String(body.isbn || "").trim()) && !typedIsbn; // e.g. "abc": nothing usable
  const isbn = typedIsbn && isbnOk && typedIsbn.length === 10 ? isbn10to13(typedIsbn) : typedIsbn;
  const publisher = (body.publisher || "").trim() || null;
  const yearCheck = parsePublishedYear(body.publishedYear);
  const publishedYear = yearCheck.error ? null : yearCheck.value;
  const genre = normalizeGenres(body.genre);
  // Books have no French genre or description (Sharon, 2026-10-28): a posted French genre or description field (an
  // old form or script) is ignored, never stored.
  const description = (body.description || "").trim() || null;
  const coverUrl = (body.coverUrl || "").trim() || null;
  const binding = normalizeBinding(body.binding);
  const location = normalizeLocation(body.location);
  const source = normalizeSource(body.source);
  const value = {
    title, author, isbn, publisher, yearCheck, publishedYear, genre, description, coverUrl,
    binding, location, source,
    condition: normalizeCondition(body.condition),
    status: normalizeStatus(body.status),
    notes: (body.copyNotes || "").trim() || null,
    costCheck: parseAcquisitionCost(body.acquisitionCost),
    acquiredCheck: parseDay(body.acquiredAt, { label: "Date acquired" }),
    // The posted text as typed, for showing a refused form again.
    raw: { binding: body.binding, publisherPrice: body.publisherPrice, publishedYear: body.publishedYear, priceLevel: body.priceLevel },
    // The price fields priceFromLevelChoice() and learningFields() read.
    priceForm: { priceLevel: body.priceLevel, price: body.price, suggestedPrice: body.suggestedPrice, suggestedLevel: body.suggestedLevel },
    typedPricing: {
      price: body.price ? asTyped(body.price) : 5,
      acquisitionCost: body.acquisitionCost ? asTyped(body.acquisitionCost) : 0,
    },
    repriceOthers: body.repriceOthers === "1",
    token: intakeToken.validToken(body.intakeToken) ? String(body.intakeToken) : null,
    coverPhoto: (files && files.coverPhoto && files.coverPhoto[0]) || null,
    // How the answer looks (fast scan or the book's page): see intakeAnswer().
    answerMode: { fast: body.fast, addAnother: body.addAnother, fromScan: body.fromScan },
  };
  if (!title) return { ok: false, field: "title", message: TITLE_REQUIRED, value };
  if (!isbnOk || isbnBlankJunk) return { ok: false, field: "isbn", message: INVALID_ISBN, value };
  const tooLong = TEXT_LIMITS.find(([key, , max]) => value[key] && value[key].length > max);
  if (tooLong) {
    const [key, label, max] = tooLong;
    const message = `${label} is too long (${value[key].length} characters; the most allowed is ${max}).`;
    // The form is shown again with what was typed, but never the whole oversized text (it is kept in the session).
    for (const [k, , m] of TEXT_LIMITS) if (value[k] && value[k].length > m) value[k] = value[k].slice(0, m);
    return { ok: false, field: key, message, value };
  }
  return { ok: true, value };
}

// Prices the copy. Fixed-price rule for new books (see lib/inventory.js), checked before anything is
// saved so a refused copy leaves no half-created book behind. A New book published more than 2 years ago
// is free-priced: the year typed here, else the one already recorded for this ISBN.
// -> { ok: true, value: input + { choice, pricing, settings } } | { ok: false, field, message }
async function prepareIntake(db, input, { time = passthroughTime } = {}) {
  const settings = await time("settings", () => getSettings(db));
  const choice = priceFromLevelChoice(input.condition, input.priceForm, settings);
  let pricingYear = input.yearCheck.error ? null : input.yearCheck.value;
  if (pricingYear == null && input.isbn) {
    const known = await db.query("SELECT published_year FROM books WHERE isbn = ANY($1)", [isbnVariants(input.isbn)]);
    if (known.rows[0]) pricingYear = known.rows[0].published_year;
  }
  const pricing = resolveCopyPricing(input.condition, choice.rawPrice, input.raw.publisherPrice, { publishedYear: pricingYear });
  const checks = [
    ["price", pricing.error], ["publishedYear", input.yearCheck.error], ["acquisitionCost", input.costCheck.error], ["acquiredAt", input.acquiredCheck.error],
  ];
  const refused = checks.find(([, message]) => message);
  if (refused) return { ok: false, field: refused[0], message: refused[1] };
  return { ok: true, value: { ...input, choice, pricing, settings } };
}

// ---------- A refused form, shown again ----------

// The flash state of GET /admin/inventory/new/again: what was typed, with the message.
// kind: "title" (no title), "input" (a value refused), "busy" (the same token is being saved).
function intakeRefusal(input, kind, message) {
  const { isbn, title, author, publisher, publishedYear, description, coverUrl, genre, binding, condition, raw, typedPricing } = input;
  const base = { location: input.location || "", source: input.source || "", fromScan: input.answerMode.fromScan === "1", priceLevel: raw.priceLevel };
  const book = { isbn, title, author, publisher, publishedYear, description, coverUrl, genre, binding };
  if (kind === "title") {
    return { ...base, prep: { isbn, title: null, author, binding: raw.binding, publisherPrice: raw.publisherPrice }, book: { ...book, title: null }, error: message, defaultPricing: typedPricing };
  }
  const prep = { isbn, title, author, binding: raw.binding, condition, publisherPrice: raw.publisherPrice };
  if (kind === "input") {
    return {
      ...base, prep,
      book: { ...book, publishedYear: input.yearCheck.error ? asTyped(raw.publishedYear) : publishedYear },
      error: message, selectedCondition: condition, publisherPriceValue: raw.publisherPrice || "", defaultPricing: typedPricing,
    };
  }
  return { ...base, prep, book, error: message, selectedCondition: condition, defaultPricing: typedPricing };
}

// ---------- Save ----------

// Render has no persistent disk, so an uploaded cover photo can't be saved to the filesystem: it's
// resized/compressed down to a small thumbnail, stored in the images table (lib/imageStore.js), and
// its short /img/<hash>.jpg URL goes in the same cover_url column a lookup-sourced image URL would.
async function processCoverPhoto(file) {
  const resized = await sharpFromUpload(file.buffer)
    .rotate()
    .resize(500, 700, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer();
  return saveImage(resized, "image/jpeg");
}

// One-time token claimed, then the book (an existing one for a known ISBN) and the copy created.
// `input` is the result of prepareIntake(). -> one of
//   { state: "duplicate", copyId, bookId, title, requests }   the same token was saved before: its answer again
//   { state: "busy" }                                          the same token is being saved right now
//   { state: "saved", bookId, copyId, isNewBook, fillAfterSave, coverUrl }
// A failure before the copy exists lets the token go, so the retry can save.
async function saveBookAndCopy(pool, input, ctx) {
  const time = ctx.time || passthroughTime;
  const { token } = input;
  if (token) {
    const claimed = await intakeToken.claim(pool, token);
    if (claimed.state === "done") {
      const { rows: bk } = await pool.query("SELECT title FROM books WHERE id = $1", [claimed.bookId]);
      return { state: "duplicate", copyId: claimed.copyId, bookId: claimed.bookId, title: (bk[0] && bk[0].title) || input.title, requests: claimed.requests };
    }
    if (claimed.state === "busy") return { state: "busy" };
  } else {
    console.warn("Add copy without an intake token (page cached from before tokens): saving without duplicate protection");
  }
  try {
    return await createBookAndCopy(pool, input, ctx, time);
  } catch (err) {
    if (token) await intakeToken.release(pool, token);
    throw err;
  }
}

async function createBookAndCopy(pool, input, ctx, time) {
  const { isbn, title, author, publisher, publishedYear, description, binding, condition, location, source, token, choice, pricing, settings } = input;
  let { genre } = input;
  let { coverUrl } = input;
  if (input.coverPhoto) coverUrl = await processCoverPhoto(input.coverPhoto);

  // A second physical copy of a book already in inventory (same ISBN) should add a copy to that
  // existing record, not create a duplicate book entry: otherwise scanning a title you already
  // stock splits into a separate single-copy book instead of accumulating on one.
  let bookId = null;
  let isNewBook = false;
  let fillAfterSave = false;
  if (isbn) {
    const { rows: existingRows } = await time("db", () => pool.query("SELECT * FROM books WHERE isbn = ANY($1) ORDER BY (isbn = $2) DESC, id LIMIT 1", [isbnVariants(isbn), isbn]));
    if (existingRows.length) {
      const existing = existingRows[0];
      bookId = existing.id;
      // A second copy never overwrites what is already recorded: the binding
      // is only filled in when the book has none yet.
      if (binding && !existing.binding) {
        await pool.query("UPDATE books SET binding = $1, updated_at = now() WHERE id = $2", [binding, bookId]);
      }
      // A description or a cover the book still lacks is fetched AFTER the answer (lib/bookFill.js).
      if (!existing.description || !existing.cover_url) fillAfterSave = true;
    }
  }

  if (!bookId) {
    // Only what is already known is stored now. The AI description, the search for a
    // cover and the cover download all happen after the answer (fillBookGaps): they used to hold the save back
    // for 3 to 20 seconds. A cover address that is not yet a copy on our server is kept as the source.
    const cover = coverUrl && isStoredImageUrl(coverUrl)
      ? { cover: coverUrl, source: null }
      : { cover: null, source: coverUrl && isAllowedCoverUrl(coverUrl) ? coverUrl : null };
    fillAfterSave = true;
    // The genre rules of Admin > Genres (lib/genreRules.js): a new book never brings back a name the admin cleaned up.
    // With no rule saved, nothing changes.
    ({ genre } = await applyRulesToBook(pool, genre));

    const { rows } = await time("db", () => pool.query(
      `INSERT INTO books (isbn, title, authors, publisher, published_year, description, cover_url, categories, binding, created_by, cover_source_url, cover_origin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT DO NOTHING RETURNING id`,
      [isbn || null, title, author, publisher, publishedYear, description, cover.cover, genre, binding, ctx.userId, cover.source, input.coverPhoto ? "photo" : (cover.cover || cover.source ? "form" : null)]
    ));
    if (rows.length) {
      bookId = rows[0].id;
      isNewBook = true;
    } else {
      // Another request added this ISBN between our lookup above and this
      // insert (books.isbn is unique, see migration 038) — use its record.
      const { rows: winner } = await pool.query("SELECT id FROM books WHERE isbn = ANY($1) ORDER BY (isbn = $2) DESC, id LIMIT 1", [isbnVariants(isbn), isbn]);
      bookId = winner[0].id;
    }
  }

  const { price, publisherPrice } = pricing;
  const acquisitionCost = input.costCheck.value;
  const acquiredAt = input.acquiredCheck.value;

  // What was suggested on screen, and whether it was kept (learning loop).
  const learning = learningFields(price, input.priceForm);
  const suggestedClearance = learning.suggestedLevel === "clearance" && learning.suggestedPrice != null && price === learning.suggestedPrice;
  const isClearance = condition !== "new" && (choice.isClearance != null ? choice.isClearance : suggestedClearance);

  // With clearance scope "all", the volunteer may also put the book's other
  // copies on clearance (unticked by default): same transaction, one audit row each.
  const repriceOthers = settings.clearance.scope === "all" && isClearance && input.repriceOthers
    ? await otherRepriceableCopies(pool, isbn)
    : [];
  const copyRows = await time("db", () => withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO book_copies (book_id, condition, price, publisher_price, acquisition_cost, acquired_at, status, notes, location, source, created_by,
                                suggested_price, suggested_level, price_basis, is_clearance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [bookId, condition, price, publisherPrice, acquisitionCost, acquiredAt, input.status, input.notes, location, source, ctx.userId,
        learning.suggestedPrice, learning.suggestedLevel, learning.priceBasis, isClearance]
    );
    for (const other of repriceOthers) {
      await client.query("UPDATE book_copies SET price = $1, is_clearance = true, updated_at = now() WHERE id = $2", [settings.clearance.price, other.id]);
    }
    if (token) await intakeToken.attach(client, token, rows[0].id, bookId);
    return rows;
  }));
  for (const other of repriceOthers) {
    await ctx.audit({
      action: "copy.reprice", targetType: "book_copy", targetId: other.id,
      detail: `price ${other.price != null ? Number(other.price).toFixed(2) : "none"} -> ${Number(settings.clearance.price).toFixed(2)} (clearance)`,
    });
  }
  return { state: "saved", bookId, copyId: copyRows[0].id, isNewBook, fillAfterSave, coverUrl };
}

// ---------- After the copy exists ----------

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

// Awards, cover/description fill and request matching, in that order. None of it can fail the save.
// -> the number of customer requests matched to the new copy.
async function afterSaveFollowUps(pool, saved, input, ctx) {
  const time = ctx.time || passthroughTime;
  // Look up awards / best-seller lists in the background so they usually
  // appear within seconds. Never awaited: it must not delay or fail the save.
  if (saved.isNewBook) checkBookAwardsInBackground(pool, saved.bookId);

  // Cover and description: fetched now that the copy is saved and the answer is on its way.
  if (saved.fillAfterSave) {
    const { isbn, title, author, publisher, publishedYear, description } = input;
    const hints = { isbn, title, author, publisher, publishedYear, description, coverUrl: saved.coverUrl };
    runAfterResponse(`fill book ${saved.bookId}`, () => fillBookGaps(pool, saved.bookId, hints));
  }

  // Customers who asked for this book (Requests page): matched now, the
  // banner on the book's page and the scan screen tells the admin.
  const requestsMatched = await time("requests", () => matchBookRequests(() => matchRequestsForCopy(pool, saved.bookId, saved.copyId)));
  if (input.token) await intakeToken.setRequests(pool, input.token, requestsMatched);
  return requestsMatched;
}

// ---------- The answer ----------

// What the answer looks like once a copy exists (also used for a repeated token).
// -> { json: {...} } | { redirect: "/path" } (a plain 302). `wantsJson`: the scan-in-a-row script saves with fetch.
function intakeAnswer(input, { copyId, bookId, title, requests }, wantsJson) {
  const { fast, addAnother, fromScan } = input.answerMode;
  if (fast !== "0" && (fast === "1" || addAnother === "1" || fromScan === "1")) {
    if (wantsJson) return { json: { ok: true, copyId, bookId, title, requests } };
    const { location, source, binding, condition } = input;
    return { redirect: `/admin/inventory/new?${fastScan.carryQuery({ location, source, binding, condition, copyId, requests })}` };
  }
  return { redirect: `/admin/inventory/${bookId}${requests ? `?requests=${requests}` : ""}` };
}

module.exports = {
  parseIntakeInput, prepareIntake, intakeRefusal, saveBookAndCopy, afterSaveFollowUps, intakeAnswer,
  processCoverPhoto, parsePublishedYear, matchBookRequests, TITLE_REQUIRED, BUSY_MESSAGE,
};
