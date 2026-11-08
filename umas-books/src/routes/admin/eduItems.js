// Admin > Educational items (lib/eduItems.js). English only, admins only (requireAdmin: two-step verification
// required, like every other admin page), CSRF-protected (src/app.js), every change audit-logged.
//
//   GET  /admin/edu-items                    the list (stock, held by open reservations, available) and the genres
//   GET  /admin/edu-items/new                the add form (?barcode=... pre-fills the barcode: "Add a new item" after a
//                                            find-by-barcode found nothing)
//   GET  /admin/edu-items/lookup?barcode=... JSON: the name (and, for an ISBN, the exact-ISBN picture) the outside
//                                            catalogues suggest for a barcode. Saves nothing. See "Barcodes" below.
//   GET  /admin/edu-items/find?barcode=...   find by barcode: to the item's edit page, or the list with "No item with
//                                            that barcode" and a button to add one
//   POST /admin/edu-items                    add (multipart: optional picture "image", src/app.js runs multer)
//   GET  /admin/edu-items/:id/edit           the edit form
//   POST /admin/edu-items/:id                save (name, price, cost, stock, genre (combo box: an existing genre or a new one, created with the item), sort, hidden, barcode, a new picture)
//   POST /admin/edu-items/:id/visibility     hide / show
//   POST /admin/edu-items/:id/image/replace  the Picture card: add or replace the picture (multipart, field "image"; 8 MB)
//   POST /admin/edu-items/:id/image/rotate   direction=left|right
//   POST /admin/edu-items/:id/image/crop     x, y, w, h (fractions 0..1 of the current picture)
//   POST /admin/edu-items/:id/image/remove   remove the picture (the card then shows "No picture")
//   POST /admin/edu-items/:id/delete         delete: only an item that is on NO order (else it must be hidden; the
//                                            order lines keep their own copy of the name and price either way)
//   POST /admin/edu-genres                   add a genre
//   POST /admin/edu-genres/:id               rename / re-sort a genre
//   POST /admin/edu-genres/:id/delete        delete a genre that has no items
//
// Stock: the number of units in the shop, held ones included. A save locks the item row FOR UPDATE (the lock the
// reservation takes, lib/cart.js) and refuses a stock below what open reservations hold, so a reservation can never be
// left without its unit. Each stock change is audited with the old and new numbers.
//
// Cost (migration 115): "Cost per unit (what we paid)", optional (blank = not known), admin-only. The list shows it with
// the margin per unit (price minus cost). A change is audited like a price change ("cost €1.20 -> €1.35", "cost not
// known -> €1.35"). Reservations copy the cost onto their order lines (lib/cart.js), so editing it never changes a
// past sale's margin.
//
// Barcodes (edu_items.barcode, migration 116, lib/barcode.js; owner-approved 2026-11-02). ADMIN ONLY: customers never see
// it (no public page, JSON or email reads the column). Optional, unique among items (a clear refusal names the other
// item), check digit verified, an ISBN-10 saved as its ISBN-13. The lookup only ever SUGGESTS: the page fills the Name
// when it is empty and offers the rest (lib/productLookup.js for a UPC / EAN, lib/bookLookup.js for an ISBN). The picture
// is never taken from a product database: for an ISBN, the exact-ISBN Open Library cover may be offered, and is used only
// when the admin presses "Use this picture" (the hidden field useIsbnCover); the server then fetches it again for the
// SAVED barcode (the page never sends an address). An ISBN that is also a book in the shop gets a warning, not a refusal:
// workbooks with an ISBN stay educational items (owner's rule) and must not also be counted as books.

const express = require("express");
const { pool, withTransaction } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { validateIdParams } = require("../../middleware/idParams");
const { limit, coverEditLimiter } = require("../../middleware/rateLimits");
const { audit } = require("../../lib/audit");
const { saveImage, isStoredImageUrl } = require("../../lib/imageStore");
const { variantUrl } = require("../../lib/imageVariants");
const { coverFromPhoto, CoverEditError, PICTURE_ERRORS, PICTURE_NOTICES, rotateCover, parseCrop, cropCover, loadStoredCover } = require("../../lib/coverEdit");
const { redirectWithFlash, takePageFlash } = require("../../lib/postRedirect");
const edu = require("../../lib/eduItems");
const { PALETTE_KEYS } = require("../../lib/browseGenres");
const { parseBarcode, gtinKey, isIsbnBarcode } = require("../../lib/barcode");
const { isbnVariants } = require("../../lib/inventory");

const router = express.Router();
validateIdParams(router, "id");

const writeLimiter = limit({ windowMs: 60 * 60 * 1000, max: 300 });
// The barcode lookup calls outside services (UPCitemdb allows about 100 a day): 30 a minute per admin account is far
// above a run of scans by hand, and stops a stuck scanner or a script.
const LOOKUP_PER_MINUTE = 30;
const lookupLimiter = limit({
  windowMs: 60 * 1000,
  max: LOOKUP_PER_MINUTE,
  keyGenerator: (req) => `edu-lookup-${req.session && req.session.user ? req.session.user.id : "anon"}`,
  handler: (req, res) => res.status(429).json({ ok: false, state: "unavailable", message: "Too many lookups in a minute: wait a moment, or type the details in." }),
  validate: { keyGeneratorIpFallback: false },
});
const UNAVAILABLE = "Lookup unavailable right now: type the details in.";
// What the page says when a barcode database could not answer: the real reason in plain words (no address, no key, no
// body). The details for the owner are on Admin > Diagnostics > Lookup sources. Saving is never affected.
const FAILURE_MESSAGES = {
  limit: "The free barcode database is limiting requests from this site (it allows about 100 a day). Try again later, or type the details in.",
  refused: "The barcode database refused the request (it may be blocking this site's address). Type the details in; the reason is on Admin > Diagnostics > Lookup sources.",
  timeout: "The barcode database did not answer in time. Try again, or type the details in.",
  network: "The barcode database could not be reached from this site just now. Try again, or type the details in.",
  server: "The barcode database has a problem on its side. Try again later, or type the details in.",
  unreadable: "The barcode database sent an answer the site could not read. Type the details in.",
};
const failureMessage = (failure) => FAILURE_MESSAGES[failure] || UNAVAILABLE;
const FLASH = "adminEduItems";
const LIST = "/admin/edu-items";
const money = (v) => Number(v).toFixed(2);
// The cost in an audit line: "cost €1.20" / "cost not known" (bare: "€1.20" / "not known").
const costText = (c, bare = false) => `${bare ? "" : "cost "}${c == null ? "not known" : `€${money(c)}`}`;

const back = (req, res, to, message, extra = {}) => redirectWithFlash(req, res, to, FLASH, { error: message, ...extra });
const done = (req, res, to, notice) => redirectWithFlash(req, res, to, FLASH, { notice });

// The picture, when one was sent with the add / save form: the same processing as a book cover photo (lib/coverEdit.js:
// turned upright, at most 900 px, JPEG), stored in `images`. -> { url } | { error } | {} (no file).
async function pictureFrom(req) {
  const file = req.files && req.files.image && req.files.image[0];
  if (!file || !file.buffer || !file.buffer.length) return {};
  try {
    const data = await coverFromPhoto(file.buffer);
    return { url: await saveImage(data, "image/jpeg", pool) };
  } catch (err) {
    if (err instanceof CoverEditError) return { error: (PICTURE_ERRORS[err.code] || PICTURE_ERRORS["not-image"]).message };
    throw err;
  }
}

// The other item that already has this barcode (compared padded to 14 digits, like the unique index), or null.
async function itemWithBarcode(db, code, exceptId = 0) {
  if (!code) return null;
  const { rows } = await db.query("SELECT id, name FROM edu_items WHERE barcode IS NOT NULL AND lpad(barcode, 14, '0') = $1 AND id <> $2 ORDER BY id LIMIT 1", [gtinKey(code), exceptId]);
  return rows[0] || null;
}

// A BOOK of the shop with this ISBN (either form), or null: the duplicate-with-book warning.
async function bookWithIsbn(code) {
  if (!isIsbnBarcode(code)) return null;
  const { rows } = await pool.query("SELECT id, title FROM books WHERE isbn = ANY($1) ORDER BY id LIMIT 1", [isbnVariants(code)]);
  return rows[0] || null;
}
const bookWarning = (b) => `This ISBN is already a book in the shop ("${b.title}"). You can still save it here: a workbook with an ISBN stays an educational item, so make sure the same copies are not also counted as books.`;
const usedBy = (o) => `The barcode is already on the item "${o.name}". Each barcode can be on one item only: open that item instead, or check the number. Nothing was saved.`;

// "Use this picture" for an ISBN: Open Library's cover for this EXACT ISBN (lib/bookLookup.js exactIsbnCover), stored on
// our server (lib/coverStore.js prepareCover) -> "/img/<hash>.jpg" or null. Never throws.
async function isbnPicture(code, { waitMs } = {}) {
  if (!isIsbnBarcode(code)) return null;
  try {
    const { exactIsbnCover } = require("../../lib/bookLookup");
    const { prepareCover } = require("../../lib/coverStore");
    const exact = await exactIsbnCover(code);
    if (!exact.url) return null;
    const task = prepareCover(exact.url).then((c) => c.cover || null, () => null);
    if (!waitMs) return await task;
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); });
    return await Promise.race([task, late]).finally(() => clearTimeout(timer));
  } catch {
    return null;
  }
}

// The item form (lib/eduItems.js parseItemForm) plus its barcode (lib/barcode.js) -> { values } | { error }.
async function parseForm(body) {
  const f = edu.parseItemForm(body);
  if (f.error) return f;
  const b = parseBarcode(body.barcode);
  if (b.error) return { error: `${b.error} Nothing was saved.` };
  return { values: { ...f.values, barcode: b.value } };
}

router.get(LIST, requireAdmin, async (req, res) => {
  const flash = takePageFlash(req, res, FLASH) || {};
  // "Search by name": same matching as the customer page (every word in the name or genre, any case), hidden items included.
  const q = String(req.query.q ?? "").trim().slice(0, edu.SEARCH_MAX);
  const params = [];
  const where = q.split(/\s+/).filter(Boolean).slice(0, 8).map((w) => {
    params.push(`%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    return `(i.name ILIKE $${params.length} OR g.name ILIKE $${params.length})`;
  });
  const { rows: items } = await pool.query(
    `SELECT i.*, g.name AS genre_name, ${edu.HELD_SQL("i")}::int AS held,
            (SELECT COUNT(*) FROM order_items oi WHERE oi.edu_item_id = i.id)::int AS order_lines
     FROM edu_items i LEFT JOIN edu_genres g ON g.id = i.genre_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY i.is_hidden, lower(i.name), i.id`,
    params
  );
  for (const i of items) {
    i.available = Math.max(0, i.stock - i.held);
    i.margin = edu.unitMargin(i.price, i.cost);
  }
  const genres = await edu.loadGenres(pool);
  res.render("admin/edu_items", { active: "edu-items", items, genres, error: flash.error || null, notice: flash.notice || null, money, notFound: flash.notFound || null, findValue: flash.findValue || "", q });
});

async function renderForm(req, res, item, { barcode = "" } = {}) {
  const flash = takePageFlash(req, res, FLASH) || {};
  const genres = await edu.loadGenres(pool);
  if (item) item.genre_name = (genres.find((g) => g.id === item.genre_id) || {}).name || "";
  let held = 0;
  if (item) held = (await pool.query(`SELECT ${edu.HELD_SQL("i")}::int AS held FROM edu_items i WHERE i.id = $1`, [item.id])).rows[0].held;
  const v = flash.values || (item ? { name: item.name, price: money(item.price), cost: item.cost == null ? "" : money(item.cost), stock: String(item.stock), genre: item.genre_name || "", isHidden: item.is_hidden ? "on" : "", barcode: item.barcode || "" } : { name: "", price: "", cost: "", stock: "0", genre: "", isHidden: "", barcode });
  if (v.barcode === undefined) v.barcode = "";
  // The saved barcode is also a book of the shop: the same gentle warning as the lookup gives.
  const book = item && item.barcode ? await bookWithIsbn(item.barcode) : null;
  // The Picture card (views/partials/picture_card.ejs, public/cover-edit.js): the same one a book's Cover card is.
  const stored = Boolean(item) && isStoredImageUrl(item.image_url);
  const pic = { stored, url: item ? item.image_url : null, preview: stored ? variantUrl(item.image_url, 450) : null, external: Boolean(item && item.image_url) && !stored };
  const code = typeof req.query.picture === "string" ? req.query.picture : "";
  let pictureMessage = null;
  if (Object.hasOwn(PICTURE_NOTICES, code)) pictureMessage = { text: PICTURE_NOTICES[code], error: false };
  else if (Object.hasOwn(PICTURE_ERRORS, code)) pictureMessage = { text: PICTURE_ERRORS[code].message, error: true };
  res.render("admin/edu_item_form", {
    active: "edu-items", item, held, pic, pictureMessage, values: v, genres, error: flash.error || null, notice: flash.notice || null, maxStock: edu.STOCK_MAX,
    bookWarning: book ? bookWarning(book) : null,
    // Arriving from "Add a new item with this barcode": the page looks the barcode up at once.
    autoLookup: !item && !flash.values && Boolean(barcode),
  });
}

router.get(`${LIST}/new`, requireAdmin, (req, res) => {
  const b = parseBarcode(String(req.query.barcode ?? "").slice(0, 30));
  return renderForm(req, res, null, { barcode: b.value || "" });
});

// ---------- barcodes: lookup and find ----------

// JSON for the form's "Scan or type barcode" box (public/edu-item-form.js). Saves nothing. Never an error page: every
// failure is a sentence the page shows, and the admin types the details in.
//   { ok, barcode, kind: "isbn" | "product", state: "found" | "missing" | "unavailable", source, name, details,
//     picture: "/img/..." | null (ISBN only: Open Library's cover for this exact ISBN, offered with "Use this picture"),
//     bookInShop: sentence | null, usedBy: { id, name } | null, message }
router.get(`${LIST}/lookup`, requireAdmin, lookupLimiter, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const b = parseBarcode(String(req.query.barcode ?? "").slice(0, 30));
  if (b.error) return res.status(400).json({ ok: false, state: "invalid", message: b.error });
  if (!b.value) return res.status(400).json({ ok: false, state: "invalid", message: "Scan or type a barcode first." });
  const code = b.value;
  const exceptId = Number.isSafeInteger(Number(req.query.itemId)) ? Number(req.query.itemId) : 0;
  let other = null;
  let book = null;
  let ownRecordsFailed = false;
  try {
    [other, book] = await Promise.all([itemWithBarcode(pool, code, exceptId), bookWithIsbn(code)]);
  } catch (err) { // the shop's own database: say so (a bare server error would look like "lookup unavailable")
    ownRecordsFailed = true;
    console.warn("Barcode lookup: could not check the shop's own records:", err.message);
  }
  const out = {
    ok: true, barcode: code, convertedFrom: b.fromIsbn10 || null, kind: isIsbnBarcode(code) ? "isbn" : "product",
    state: "unavailable", source: null, name: null, details: null, picture: null,
    bookInShop: book ? bookWarning(book) : null,
    usedBy: other ? { id: other.id, name: other.name, href: `${LIST}/${other.id}/edit` } : null,
    message: ownRecordsFailed ? "The shop's own records could not be checked just now. Try again in a moment, or type the details in." : UNAVAILABLE,
  };
  try {
    if (out.kind === "isbn") {
      const { lookupByIsbnDetailed } = require("../../lib/bookLookup");
      const [r, picture] = await Promise.all([lookupByIsbnDetailed(code), isbnPicture(code, { waitMs: 3000 })]);
      out.picture = picture;
      if (r.state === "found" && r.book && r.book.title) {
        const names = { openlibrary: "Open Library", "openlibrary-data": "Open Library", bnf: "BnF", google: "Google Books", isbndb: "ISBNdb" };
        const bk = r.book;
        out.state = "found";
        out.source = names[(r.via || [])[0]] || "Open Library";
        out.name = [bk.title, bk.subtitle].filter(Boolean).join(": ").slice(0, edu.NAME_MAX);
        out.details = [bk.author && `by ${bk.author}`, bk.publisher, bk.publishedYear].filter(Boolean).join(", ") || null;
      } else if (r.state === "missing" || r.state === "invalid") out.state = "missing";
    } else {
      const { lookupProductName } = require("../../lib/productLookup");
      const r = await lookupProductName(code);
      if (r.state === "found") Object.assign(out, { state: "found", source: r.source, name: r.name });
      else if (r.state === "missing") out.state = "missing";
      else {
        out.failure = r.failure || "other";
        if (!ownRecordsFailed) out.message = failureMessage(out.failure);
        console.warn(`Barcode lookup unavailable (${r.reason})`);
      }
    }
  } catch (err) {
    console.warn("Barcode lookup failed:", err.message);
    out.state = "unavailable";
  }
  if (out.state === "found") out.message = `Found at ${out.source}. Check the suggestion before saving.`;
  else if (out.state === "missing") out.message = "Nothing found for this barcode: type the details in.";
  // An ISBN the catalogues do not know may still have an exact-ISBN picture: it is offered either way.
  return res.json(out);
});

// The list's "Find by barcode" box (a plain GET form: a scanner types the digits and Enter).
router.get(`${LIST}/find`, requireAdmin, async (req, res) => {
  const raw = String(req.query.barcode ?? "").slice(0, 30);
  const b = parseBarcode(raw);
  if (b.error) return redirectWithFlash(req, res, LIST, FLASH, { error: b.error, findValue: raw });
  if (!b.value) return redirectWithFlash(req, res, LIST, FLASH, { error: "Scan or type a barcode to find an item.", findValue: "" });
  const hit = await itemWithBarcode(pool, b.value);
  if (hit) return res.redirect(303, `${LIST}/${hit.id}/edit`);
  return redirectWithFlash(req, res, LIST, FLASH, { notFound: b.value, findValue: b.value });
});

router.get(`${LIST}/:id/edit`, requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM edu_items WHERE id = $1", [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).render("404");
  return renderForm(req, res, rows[0]);
});

// What the form sent, to put back in the form after a refusal.
const typed = (b) => ({ name: String(b.name ?? "").slice(0, 200), price: String(b.price ?? "").slice(0, 20), cost: String(b.cost ?? "").slice(0, 20), stock: String(b.stock ?? "").slice(0, 10), genre: String(b.genre ?? "").slice(0, 200), isHidden: b.isHidden === "on" ? "on" : "", barcode: String(b.barcode ?? "").slice(0, 30) });

// The picture to save: the admin's own photo wins; else, when she pressed "Use this picture", Open Library's cover for
// the saved ISBN. -> { url } | { error } | { note } (the Open Library picture could not be fetched: saved without it).
async function chosenPicture(req, barcode) {
  const pic = await pictureFrom(req);
  if (pic.url || pic.error) return pic;
  if (req.body.useIsbnCover !== "1") return {};
  const url = isIsbnBarcode(barcode) ? await isbnPicture(barcode) : null;
  return url ? { url, fromIsbn: true } : { note: " The Open Library picture could not be fetched: add your own photo." };
}

// A unique-index refusal (two saves of the same barcode at the same moment): the same sentence as the check before.
const isBarcodeClash = (err) => err && err.code === "23505" && /edu_items_barcode_key/.test(err.constraint || err.message || "");

router.post(LIST, requireAdmin, writeLimiter, async (req, res) => {
  const f = await parseForm(req.body);
  if (f.error) return back(req, res, `${LIST}/new`, f.error, { values: typed(req.body) });
  const v = f.values;
  const other = await itemWithBarcode(pool, v.barcode);
  if (other) return back(req, res, `${LIST}/new`, usedBy(other), { values: typed(req.body) });
  const pic = await chosenPicture(req, v.barcode);
  if (pic.error) return back(req, res, `${LIST}/new`, pic.error, { values: typed(req.body) });
  let r;
  try {
    // The genre (found or created) and the item are saved together: all or nothing.
    r = await withTransaction(pool, async (client) => {
      const genre = await edu.resolveGenre(client, v.genreName);
      if (genre.error) return { genreError: genre.error };
      const { rows } = await client.query(
        `INSERT INTO edu_items (name, price, cost, stock, genre_id, sort_order, is_hidden, image_url, barcode) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [v.name, v.price, v.cost, v.stock, genre.id, v.sortOrder, v.isHidden, pic.url || null, v.barcode]
      );
      return { genre, itemId: rows[0].id };
    });
  } catch (err) {
    if (isBarcodeClash(err)) return back(req, res, `${LIST}/new`, usedBy((await itemWithBarcode(pool, v.barcode)) || { name: "another item" }), { values: typed(req.body) });
    throw err;
  }
  if (r.genreError) return back(req, res, `${LIST}/new`, r.genreError, { values: typed(req.body) });
  // Audit right after the commit, like every other save here (audit() never throws): the genre first, then the item.
  if (r.genre.created) await audit(req, { action: "edu_genre.add", targetType: "edu_genre", targetId: r.genre.id, detail: `${r.genre.name} (from the item form)` });
  const picNote = pic.url ? (pic.fromIsbn ? ", with the Open Library picture" : ", with picture") : "";
  await audit(req, { action: "edu_item.add", targetType: "edu_item", targetId: r.itemId, detail: `${v.name}, €${money(v.price)}, ${costText(v.cost)}, stock ${v.stock}${r.genre.name ? `, genre ${r.genre.name}` : ""}${v.isHidden ? ", hidden" : ""}${v.barcode ? `, barcode ${v.barcode}` : ""}${picNote}` });
  const book = await bookWithIsbn(v.barcode);
  return done(req, res, LIST, `Added "${v.name}".${r.genre.created ? ` The new genre "${r.genre.name}" was added too.` : ""}${pic.note || ""}${book ? ` ${bookWarning(book)}` : ""}`);
});

router.post(`${LIST}/:id`, requireAdmin, writeLimiter, async (req, res) => {
  const id = Number(req.params.id);
  const edit = `${LIST}/${id}/edit`;
  const f = await parseForm(req.body);
  if (f.error) return back(req, res, edit, f.error, { values: typed(req.body) });
  const v = f.values;
  const other = await itemWithBarcode(pool, v.barcode, id);
  if (other) return back(req, res, edit, usedBy(other), { values: typed(req.body) });
  const pic = await chosenPicture(req, v.barcode);
  if (pic.error) return back(req, res, edit, pic.error, { values: typed(req.body) });
  const r = await withTransaction(pool, async (client) => {
    // The reservation's lock (lib/cart.js): no reservation can take a unit between the count and the save.
    const { rows } = await client.query("SELECT * FROM edu_items WHERE id = $1 FOR UPDATE", [id]);
    const old = rows[0];
    if (!old) return { outcome: "not_found" };
    const { rows: h } = await client.query(`SELECT ${edu.HELD_SQL("i")}::int AS held FROM edu_items i WHERE i.id = $1`, [id]);
    const held = h[0].held;
    if (v.stock < held) return { outcome: "below_held", held };
    const genre = await edu.resolveGenre(client, v.genreName);
    if (genre.error) return { outcome: "genre_error", error: genre.error };
    await client.query(
      `UPDATE edu_items SET name = $2, price = $3, stock = $4, genre_id = $5, sort_order = $6, is_hidden = $7,
              image_url = COALESCE($8, image_url), cost = $9, barcode = $10, updated_at = now() WHERE id = $1`,
      [id, v.name, v.price, v.stock, genre.id, v.sortOrder, v.isHidden, pic.url || null, v.cost, v.barcode]
    );
    return { outcome: "saved", old, genre };
  }).catch(async (err) => {
    if (isBarcodeClash(err)) return { outcome: "barcode_used", other: (await itemWithBarcode(pool, v.barcode, id)) || { name: "another item" } };
    throw err;
  });
  if (r.outcome === "not_found") return res.status(404).render("404");
  if (r.outcome === "barcode_used") return back(req, res, edit, usedBy(r.other), { values: typed(req.body) });
  if (r.outcome === "genre_error") return back(req, res, edit, r.error, { values: typed(req.body) });
  if (r.outcome === "below_held") {
    return back(req, res, edit, `The stock cannot be lower than ${r.held}: open reservations hold ${r.held} of this item. Collect or cancel them first. Nothing was saved.`, { values: typed(req.body) });
  }
  if (r.genre.created) await audit(req, { action: "edu_genre.add", targetType: "edu_genre", targetId: r.genre.id, detail: `${r.genre.name} (from the item form)` });
  const o = r.old;
  const changes = [];
  if (o.name !== v.name) changes.push(`name "${o.name}" -> "${v.name}"`);
  if (Math.round(Number(o.price) * 100) !== Math.round(v.price * 100)) changes.push(`price €${money(o.price)} -> €${money(v.price)}`);
  if ((o.cost == null ? null : Math.round(Number(o.cost) * 100)) !== (v.cost == null ? null : Math.round(v.cost * 100))) changes.push(`cost ${costText(o.cost, true)} -> ${costText(v.cost, true)}`);
  if (o.stock !== v.stock) changes.push(`stock ${o.stock} -> ${v.stock}`);
  if ((o.genre_id ?? null) !== r.genre.id) changes.push(r.genre.name ? `genre -> ${r.genre.name}` : "genre removed");
  if (o.is_hidden !== v.isHidden) changes.push(v.isHidden ? "hidden" : "shown");
  if ((o.barcode || null) !== v.barcode) changes.push(`barcode ${o.barcode || "none"} -> ${v.barcode || "none"}`);
  if (pic.url) changes.push(pic.fromIsbn ? "new picture (Open Library, exact ISBN)" : "new picture");
  await audit(req, { action: "edu_item.edit", targetType: "edu_item", targetId: id, detail: changes.join("; ") || "no change" });
  const book = v.barcode && (o.barcode || null) !== v.barcode ? await bookWithIsbn(v.barcode) : null;
  return done(req, res, LIST, `Saved "${v.name}".${r.genre.created ? ` The new genre "${r.genre.name}" was added too.` : ""}${pic.note || ""}${book ? ` ${bookWarning(book)}` : ""}`);
});

router.post(`${LIST}/:id/visibility`, requireAdmin, writeLimiter, async (req, res) => {
  const id = Number(req.params.id);
  const hide = req.body.hide === "1";
  const { rows } = await pool.query("UPDATE edu_items SET is_hidden = $2, updated_at = now() WHERE id = $1 RETURNING name", [id, hide]);
  if (!rows[0]) return res.status(404).render("404");
  await audit(req, { action: hide ? "edu_item.hide" : "edu_item.show", targetType: "edu_item", targetId: id, detail: rows[0].name });
  return done(req, res, LIST, hide ? `"${rows[0].name}" is hidden: customers no longer see it. Reservations already made keep it.` : `"${rows[0].name}" is shown again.`);
});

// ---------- the Picture card: replace, rotate, crop, remove (the same image work as a book's Cover card, lib/coverEdit.js) ----------
// Plain form posts that work without JavaScript: the answer is a redirect back to the item (#picture) with the result in the
// card; a script sending `Accept: application/json` gets JSON and the real status. Every edit makes a NEW stored image; the old
// one stays in `images` until lib/imageCleanup.js finds that no edu_items.image_url (or any other column) refers to it.

const wantsJson = (req) => req.accepts(["html", "json"]) === "json";

function answerPicture(req, res, id, code, extra = {}) {
  const failed = Object.hasOwn(PICTURE_ERRORS, code);
  if (wantsJson(req)) {
    const status = failed ? PICTURE_ERRORS[code].status : 200;
    return res.status(status).json({ ok: !failed, code, message: failed ? PICTURE_ERRORS[code].message : PICTURE_NOTICES[code], ...extra });
  }
  return res.redirect(303, `${LIST}/${id}/edit?picture=${encodeURIComponent(code)}#picture`);
}

const pictureLimiter = coverEditLimiter({
  handler: (req, res) => {
    const m = /^\/admin\/edu-items\/(\d+)\/image\//.exec(req.originalUrl || "");
    if (m && !wantsJson(req)) return res.redirect(303, `${LIST}/${m[1]}/edit?picture=busy#picture`);
    return res.status(429).json({ ok: false, code: "busy", message: PICTURE_ERRORS.busy.message });
  },
});

async function loadItem(req, res) {
  const { rows } = await pool.query("SELECT id, name, image_url FROM edu_items WHERE id = $1", [Number(req.params.id)]);
  if (!rows[0]) { res.status(404).render("404"); return null; }
  return rows[0];
}

// Points the item at the new picture, but only while it still shows the picture that was edited (two people pressing at once
// cannot silently undo each other).
async function setPicture(item, url) {
  const { rowCount } = await pool.query("UPDATE edu_items SET image_url = $1, updated_at = now() WHERE id = $2 AND image_url IS NOT DISTINCT FROM $3", [url, item.id, item.image_url]);
  return rowCount > 0;
}

async function editStoredPicture(req, res, kind, change, detail) {
  const item = await loadItem(req, res);
  if (!item) return;
  try {
    const bytes = await loadStoredCover(item.image_url, pool);
    const result = await change(bytes);
    if (result.unchanged) return answerPicture(req, res, item.id, "no-change");
    const url = await saveImage(result.data, "image/jpeg", pool);
    if (!(await setPicture(item, url))) return answerPicture(req, res, item.id, "changed");
    await audit(req, { action: `edu_item.image_${kind}`, targetType: "edu_item", targetId: item.id, detail: `${item.name}: ${detail(result)}` });
    return answerPicture(req, res, item.id, kind === "rotate" ? "rotated" : "cropped", { imageUrl: url });
  } catch (err) {
    if (!(err instanceof CoverEditError)) throw err;
    return answerPicture(req, res, item.id, err.code);
  }
}

router.post(`${LIST}/:id/image/rotate`, requireAdmin, pictureLimiter, writeLimiter, (req, res) => {
  const direction = req.body && typeof req.body.direction === "string" ? req.body.direction : "";
  return editStoredPicture(req, res, "rotate", async (bytes) => ({ data: await rotateCover(bytes, direction) }), () => direction);
});

router.post(`${LIST}/:id/image/crop`, requireAdmin, pictureLimiter, writeLimiter, async (req, res) => {
  let crop;
  try {
    crop = parseCrop(req.body);
  } catch (err) {
    if (!(err instanceof CoverEditError)) throw err;
    const item = await loadItem(req, res);
    return item ? answerPicture(req, res, item.id, err.code) : undefined;
  }
  const r4 = (n) => Math.round(n * 10000) / 10000;
  return editStoredPicture(req, res, "crop", async (bytes) => {
    const out = await cropCover(bytes, crop);
    return out.changed ? { data: out.data } : { unchanged: true };
  }, () => `x=${r4(crop.x)} y=${r4(crop.y)} w=${r4(crop.w)} h=${r4(crop.h)}`);
});

router.post(`${LIST}/:id/image/replace`, requireAdmin, pictureLimiter, writeLimiter, async (req, res) => {
  const item = await loadItem(req, res);
  if (!item) return;
  const file = req.files && req.files.image && req.files.image[0];
  try {
    const data = await coverFromPhoto(file && file.buffer);
    const url = await saveImage(data, "image/jpeg", pool);
    await pool.query("UPDATE edu_items SET image_url = $1, updated_at = now() WHERE id = $2", [url, item.id]);
    await audit(req, { action: "edu_item.image_replace", targetType: "edu_item", targetId: item.id, detail: `${item.name}: ${item.image_url ? "picture replaced" : "picture added"}` });
    return answerPicture(req, res, item.id, "replaced", { imageUrl: url });
  } catch (err) {
    if (!(err instanceof CoverEditError)) throw err;
    return answerPicture(req, res, item.id, err.code);
  }
});

// The picture itself stays in `images` for the unused-image cleanup (deleted there once nothing refers to it and it is older
// than the grace period).
router.post(`${LIST}/:id/image/remove`, requireAdmin, pictureLimiter, writeLimiter, async (req, res) => {
  const item = await loadItem(req, res);
  if (!item) return;
  if (item.image_url) {
    await pool.query("UPDATE edu_items SET image_url = NULL, updated_at = now() WHERE id = $1", [item.id]);
    await audit(req, { action: "edu_item.image_remove", targetType: "edu_item", targetId: item.id, detail: item.name });
  }
  return answerPicture(req, res, item.id, "removed", { imageUrl: null });
});

router.post(`${LIST}/:id/delete`, requireAdmin, writeLimiter, async (req, res) => {
  const id = Number(req.params.id);
  const r = await withTransaction(pool, async (client) => {
    const { rows } = await client.query("SELECT id, name FROM edu_items WHERE id = $1 FOR UPDATE", [id]);
    if (!rows[0]) return { outcome: "not_found" };
    const { rows: used } = await client.query("SELECT COUNT(*)::int AS n FROM order_items WHERE edu_item_id = $1", [id]);
    if (used[0].n > 0) return { outcome: "on_orders", name: rows[0].name, n: used[0].n };
    await client.query("DELETE FROM edu_items WHERE id = $1", [id]);
    return { outcome: "deleted", name: rows[0].name };
  });
  if (r.outcome === "not_found") return res.status(404).render("404");
  if (r.outcome === "on_orders") {
    return back(req, res, LIST, `"${r.name}" is on ${r.n} reservation line(s), so it cannot be deleted (the reservations and the accounts need it). Hide it instead: customers will no longer see it.`);
  }
  await audit(req, { action: "edu_item.delete", targetType: "edu_item", targetId: id, detail: r.name });
  return done(req, res, LIST, `Deleted "${r.name}".`);
});

// ---------- genres ----------

router.post("/admin/edu-genres", requireAdmin, writeLimiter, async (req, res) => {
  const { rows: existing } = await pool.query("SELECT slug, colour, lower(btrim(name)) AS lname, sort_order FROM edu_genres ORDER BY sort_order DESC, id DESC");
  const g = edu.parseGenreName(req.body.name, existing.map((r) => r.slug));
  if (g.error) return back(req, res, LIST, g.error);
  if (existing.some((r) => r.lname === g.name.toLowerCase())) return back(req, res, LIST, `There is already a genre called "${g.name}". Nothing was saved.`);
  const colour = edu.nextColour(existing[0] ? existing[0].colour : PALETTE_KEYS[PALETTE_KEYS.length - 1]);
  const sort = existing[0] ? existing[0].sort_order + 1 : 1;
  const { rows } = await pool.query("INSERT INTO edu_genres (name, slug, sort_order, colour, icon) VALUES ($1, $2, $3, $4, 'book') RETURNING id", [g.name, g.slug, sort, colour]);
  await audit(req, { action: "edu_genre.add", targetType: "edu_genre", targetId: rows[0].id, detail: g.name });
  return done(req, res, LIST, `Added the genre "${g.name}".`);
});

router.post("/admin/edu-genres/:id", requireAdmin, writeLimiter, async (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body.name ?? "").replace(/\s+/g, " ").trim();
  if (!name || name.length > edu.GENRE_NAME_MAX) return back(req, res, LIST, `A genre name needs 1 to ${edu.GENRE_NAME_MAX} characters. Nothing was saved.`);
  const sort = Number(String(req.body.sortOrder ?? "0").trim() || "0");
  if (!Number.isSafeInteger(sort) || Math.abs(sort) > 9999) return back(req, res, LIST, "The genre's order must be a whole number between -9999 and 9999. Nothing was saved.");
  let rows;
  try {
    ({ rows } = await pool.query("UPDATE edu_genres SET name = $2, sort_order = $3 WHERE id = $1 RETURNING id", [id, name, sort]));
  } catch (err) {
    if (err.code === "23505") return back(req, res, LIST, `There is already a genre called "${name}". Nothing was saved.`);
    throw err;
  }
  if (!rows[0]) return res.status(404).render("404");
  // The slug (the ?genre= address) stays the same, so links to the genre keep working after a rename.
  await audit(req, { action: "edu_genre.edit", targetType: "edu_genre", targetId: id, detail: `${name}, order ${sort}` });
  return done(req, res, LIST, `Saved the genre "${name}".`);
});

router.post("/admin/edu-genres/:id/delete", requireAdmin, writeLimiter, async (req, res) => {
  const id = Number(req.params.id);
  const { rows: g } = await pool.query("SELECT name, (SELECT COUNT(*) FROM edu_items WHERE genre_id = $1)::int AS n FROM edu_genres WHERE id = $1", [id]);
  if (!g[0]) return res.status(404).render("404");
  if (g[0].n > 0) return back(req, res, LIST, `"${g[0].name}" still has ${g[0].n} item(s). Move them to another genre first. Nothing was deleted.`);
  await pool.query("DELETE FROM edu_genres WHERE id = $1", [id]);
  await audit(req, { action: "edu_genre.delete", targetType: "edu_genre", targetId: id, detail: g[0].name });
  return done(req, res, LIST, `Deleted the genre "${g[0].name}".`);
});

module.exports = router;
