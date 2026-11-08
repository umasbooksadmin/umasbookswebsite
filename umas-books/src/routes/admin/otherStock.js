// Admin > Other stock (not books): the till's quick items (table till_quick_items; tote bags, bookmarks, anything sold that
// is not a book). Managed like Admin > Educational items (routes/admin/eduItems.js) but WITHOUT the book-catalogue part, and
// with NO customer page: these items are seen by admins and by the Till only. English only, admins only (requireAdmin),
// CSRF-protected (src/app.js), every change audit-logged.
//
//   GET  /admin/till/items                    the list: picture, name, price, stock, shown (On the till); Search by name,
//                                             Find by barcode; alphabetical by name
//   GET  /admin/till/items/new                the add form (?barcode=... pre-fills the barcode after a find found nothing)
//   GET  /admin/till/items/lookup?barcode=... JSON: the name the product catalogues (Open Products Facts, UPCitemdb) suggest for a
//                                             non-book barcode. Saves nothing. Never for an ISBN or a shop code.
//   GET  /admin/till/items/find?barcode=...   to the item's edit page, or the list with "No item with that barcode"
//   POST /admin/till/items                    add (multipart: optional picture "image", src/app.js runs multer)
//   GET  /admin/till/items/:id/edit           the edit form (with the Picture card)
//   POST /admin/till/items/:id                save (name, price, category, stock, barcode, On the till, a new picture)
//   POST /admin/till/items/:id/generate-code  the shop's own code ITEM-<id> for an item without a barcode
//   POST /admin/till/items/:id/image/{replace,rotate,crop,remove}   the Picture card (same image work as an educational item)
//
// The barcode rules are the ones the Till has always had (lib/till.js parseBarcode / checkBarcodeFree): optional, a
// manufacturer code of 8 to 14 digits or the shop's own code (TOTE-GREEN), stored upper-case, unique among ACTIVE items, never
// UB-... / ORDER-... and never the ISBN of a book in the shop. The look-up only SUGGESTS a name; the picture is never taken from a
// product database. There is no delete (items are switched off with "On the till"): the sales keep their own copy of the name.
// The pictures are stored in `images` and cleaned up by lib/imageCleanup.js once nothing refers to them.

const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { validateIdParams } = require("../../middleware/idParams");
const { limit, coverEditLimiter } = require("../../middleware/rateLimits");
const { audit } = require("../../lib/audit");
const { saveImage, isStoredImageUrl } = require("../../lib/imageStore");
const { variantUrl } = require("../../lib/imageVariants");
const { coverFromPhoto, CoverEditError, PICTURE_ERRORS, PICTURE_NOTICES, rotateCover, parseCrop, cropCover, loadStoredCover } = require("../../lib/coverEdit");
const { redirectWithFlash, takePageFlash } = require("../../lib/postRedirect");
const { setFlash } = require("../../lib/flash");
const till = require("../../lib/till");
const { isIsbnBarcode } = require("../../lib/barcode");

const router = express.Router();
validateIdParams(router, "id");

const writeLimiter = limit({ windowMs: 60 * 60 * 1000, max: 200 });
// The look-up calls outside services (UPCitemdb allows about 100 a day): 30 a minute per admin is far above a run of scans.
const lookupLimiter = limit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => `other-stock-lookup-${req.session && req.session.user ? req.session.user.id : "anon"}`,
  handler: (req, res) => res.status(429).json({ ok: false, state: "unavailable", message: "Too many lookups in a minute: wait a moment, or type the details in." }),
  validate: { keyGeneratorIpFallback: false },
});
const UNAVAILABLE = "Lookup unavailable right now: type the details in.";
// What the page says when a barcode database could not answer (the real reason in plain words; no address, key or body).
const FAILURE_MESSAGES = {
  limit: "The free barcode database is limiting requests from this site (it allows about 100 a day). Try again later, or type the details in.",
  refused: "The barcode database refused the request (it may be blocking this site's address). Type the details in; the reason is on Admin > Diagnostics > Lookup sources.",
  timeout: "The barcode database did not answer in time. Try again, or type the details in.",
  network: "The barcode database could not be reached from this site just now. Try again, or type the details in.",
  server: "The barcode database has a problem on its side. Try again later, or type the details in.",
  unreadable: "The barcode database sent an answer the site could not read. Type the details in.",
};
const failureMessage = (failure) => FAILURE_MESSAGES[failure] || UNAVAILABLE;

const FLASH = "adminOtherStock";
const LIST = "/admin/till/items";
const SEARCH_MAX = 100;
const money = (cents) => (cents == null ? "" : (cents / 100).toFixed(2));

const back = (req, res, to, message, extra = {}) => redirectWithFlash(req, res, to, FLASH, { error: message, ...extra });
// A saved form answers 302 (as it always has); the notice travels in the session.
const done = async (req, res, to, notice) => {
  await setFlash(req, FLASH, { notice });
  res.redirect(to);
};

const ITEM_ERR = {
  name: "Name is required (at most 80 characters).",
  price: "Price must be above 0.",
};

// The form -> { values } | { error }. Nothing is saved on an error.
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
  const bc = till.parseBarcode(body.barcode);
  if (bc.error) return { error: bc.error };
  return { values: { name, priceCents: p.cents, category, stock, barcode: bc.code } };
}

// What the form sent, to put back in the form after a refusal.
const typed = (b) => ({
  name: String(b.name ?? "").slice(0, 200), price: String(b.price ?? "").slice(0, 20), category: String(b.category ?? "").slice(0, 30),
  stock: String(b.stock ?? "").slice(0, 10), barcode: String(b.barcode ?? "").slice(0, 40), active: b.active === "1" ? "1" : "", generate: b.generate === "1" ? "1" : "",
});

const TAKEN = "That barcode is already used by another active quick item.";
// A barcode check for a parsed form: other active items and books' ISBNs. Skipped when the item is switched off.
async function barcodeChecks(values, excludeId, active = true) {
  if (!values.barcode || !active) return {};
  return till.checkBarcodeFree(pool, values.barcode, excludeId);
}

// The picture sent with the add / save form: the same processing as a book cover photo. -> { url } | { error } | {}.
async function pictureFrom(req) {
  const file = req.files && req.files.image && req.files.image[0];
  if (!file || !file.buffer || !file.buffer.length) return {};
  try {
    return { url: await saveImage(await coverFromPhoto(file.buffer), "image/jpeg", pool) };
  } catch (err) {
    if (err instanceof CoverEditError) return { error: (PICTURE_ERRORS[err.code] || PICTURE_ERRORS["not-image"]).message };
    throw err;
  }
}

// "ITEM-<id>": the shop's own code for an item without a manufacturer barcode.
async function generateShopCode(id) {
  const code = `${till.SHOP_CODE_PREFIX}${id}`;
  await pool.query("UPDATE till_quick_items SET barcode = $2 WHERE id = $1 AND barcode IS NULL", [id, code]);
  return code;
}

// ---------- the list ----------

router.get(LIST, requireAdmin, async (req, res) => {
  const flash = takePageFlash(req, res, FLASH) || {};
  // "Search by name": every word in the name, any case, switched-off items included.
  const q = String(req.query.q ?? "").trim().slice(0, SEARCH_MAX);
  const params = [];
  const where = q.split(/\s+/).filter(Boolean).slice(0, 8).map((w) => {
    params.push(`%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    return `name ILIKE $${params.length}`;
  });
  const { rows } = await pool.query(
    `SELECT * FROM till_quick_items ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY active DESC, lower(name), id`, params
  );
  res.render("admin/till/items", {
    active: "till-items", title: "Other stock (not books)", items: rows, categories: till.OTHER_CATEGORIES, money, q,
    categoryLabel: (v) => (till.OTHER_CATEGORIES.find((c) => c.value === v) || {}).label || v,
    thumb: (url) => variantUrl(url, 300),
    error: flash.error || (typeof req.query.error === "string" ? req.query.error.slice(0, 200) : null),
    notice: flash.notice || null, notFound: flash.notFound || null, findValue: flash.findValue || "",
  });
});

async function renderForm(req, res, item, { barcode = "" } = {}) {
  const flash = takePageFlash(req, res, FLASH) || {};
  const v = flash.values || (item
    ? { name: item.name, price: money(item.price_cents), category: item.category, stock: item.stock === null ? "" : String(item.stock), barcode: item.barcode || "", active: item.active ? "1" : "", generate: "" }
    : { name: "", price: "", category: till.OTHER_CATEGORIES[0].value, stock: "", barcode, active: "1", generate: "" });
  // The Picture card (views/partials/picture_card.ejs, public/cover-edit.js): the same one a book's Cover card is.
  const stored = Boolean(item) && isStoredImageUrl(item.image_url);
  const pic = { stored, url: item ? item.image_url : null, preview: stored ? variantUrl(item.image_url, 450) : null, external: Boolean(item && item.image_url) && !stored };
  const code = typeof req.query.picture === "string" ? req.query.picture : "";
  let pictureMessage = null;
  if (Object.hasOwn(PICTURE_NOTICES, code)) pictureMessage = { text: PICTURE_NOTICES[code], error: false };
  else if (Object.hasOwn(PICTURE_ERRORS, code)) pictureMessage = { text: PICTURE_ERRORS[code].message, error: true };
  res.render("admin/till/item_form", {
    active: "till-items", item, pic, pictureMessage, values: v, categories: till.OTHER_CATEGORIES, shopCode: till.SHOP_CODE_PREFIX,
    error: flash.error || null, notice: flash.notice || null,
    // Arriving from "Add a new item with this barcode": the page looks the barcode up at once.
    autoLookup: !item && !flash.values && Boolean(barcode),
  });
}

router.get(`${LIST}/new`, requireAdmin, (req, res) => {
  const b = till.parseBarcode(String(req.query.barcode ?? "").slice(0, 40));
  return renderForm(req, res, null, { barcode: b.code || "" });
});

// ---------- barcodes: look-up and find ----------

// JSON for the form's "Scan or type barcode" box (public/edu-item-form.js, shared with Educational items). Saves nothing. Never an
// error page: every failure is a sentence the page shows. Non-book barcodes only: an ISBN or a shop code is not looked up.
//   { ok, barcode, kind: "product" | "isbn" | "shop", state: "found" | "missing" | "unavailable", source, name, details: null,
//     picture: null, bookInShop: sentence | null, usedBy: { id, name, href } | null, message }
router.get(`${LIST}/lookup`, requireAdmin, lookupLimiter, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const b = till.parseBarcode(String(req.query.barcode ?? "").slice(0, 40));
  if (b.error) return res.status(400).json({ ok: false, state: "invalid", message: b.error });
  if (!b.code) return res.status(400).json({ ok: false, state: "invalid", message: "Scan or type a barcode first." });
  const code = b.code;
  const exceptId = Number.isSafeInteger(Number(req.query.itemId)) ? Number(req.query.itemId) : 0;
  const numeric = /^\d{8,14}$/.test(code);
  const out = {
    ok: true, barcode: code, kind: isIsbnBarcode(code) ? "isbn" : numeric ? "product" : "shop",
    state: "unavailable", source: null, name: null, details: null, picture: null, bookInShop: null, usedBy: null, message: UNAVAILABLE,
  };
  let ownRecordsFailed = false;
  try {
    const { rows } = await pool.query("SELECT id, name FROM till_quick_items WHERE active AND barcode = $1 AND id <> $2 ORDER BY id LIMIT 1", [code, exceptId]);
    if (rows[0]) out.usedBy = { id: rows[0].id, name: rows[0].name, href: `${LIST}/${rows[0].id}/edit` };
    else {
      // A code equal to a book's ISBN cannot be saved (at the till it would hide the book): said now, not only on Save.
      const chk = await till.checkBarcodeFree(pool, code, exceptId || null);
      if (chk.error) out.bookInShop = chk.error;
    }
  } catch (err) { // the shop's own database: say so (a bare server error would look like "lookup unavailable")
    ownRecordsFailed = true;
    console.warn("Other stock lookup: could not check the shop's own records:", err.message);
    out.message = "The shop's own records could not be checked just now. Try again in a moment, or type the details in.";
  }
  if (out.kind === "shop") {
    out.state = "missing";
    out.message = "This is a shop code, not a manufacturer barcode: there is nothing to look up. Type the details in.";
    return res.json(out);
  }
  if (out.kind === "isbn") {
    out.state = "missing";
    out.message = "This looks like a book ISBN (978 / 979): books are added under Inventory, and lookups here are for other products. Type the details in.";
    return res.json(out);
  }
  try {
    const { lookupProductName } = require("../../lib/productLookup");
    const r = await lookupProductName(code);
    if (r.state === "found") Object.assign(out, { state: "found", source: r.source, name: String(r.name).slice(0, 80) });
    else if (r.state === "missing") out.state = "missing";
    else {
      out.failure = r.failure || "other";
      if (!ownRecordsFailed) out.message = failureMessage(out.failure);
      console.warn(`Barcode lookup unavailable (${r.reason})`);
    }
  } catch (err) {
    console.warn("Barcode lookup failed:", err.message);
    out.state = "unavailable";
  }
  if (out.state === "found") out.message = `Found at ${out.source}. Check the suggestion before saving.`;
  else if (out.state === "missing") out.message = "Nothing found for this barcode: type the details in.";
  return res.json(out);
});

// The list's "Find by barcode" box (a plain GET form: a scanner types the digits and Enter). An active item wins over a switched-off one.
router.get(`${LIST}/find`, requireAdmin, async (req, res) => {
  const raw = String(req.query.barcode ?? "").slice(0, 40);
  const b = till.parseBarcode(raw);
  if (b.error) return back(req, res, LIST, b.error, { findValue: raw });
  if (!b.code) return back(req, res, LIST, "Scan or type a barcode to find an item.", { findValue: "" });
  const { rows } = await pool.query("SELECT id FROM till_quick_items WHERE barcode = $1 ORDER BY active DESC, id LIMIT 1", [b.code]);
  if (rows[0]) return res.redirect(303, `${LIST}/${rows[0].id}/edit`);
  return redirectWithFlash(req, res, LIST, FLASH, { notFound: b.code, findValue: b.code });
});

router.get(`${LIST}/:id/edit`, requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM till_quick_items WHERE id = $1", [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).render("404");
  return renderForm(req, res, rows[0]);
});

// ---------- add / save ----------

router.post(LIST, requireAdmin, writeLimiter, async (req, res) => {
  const NEW = `${LIST}/new`;
  const f = parseItemForm(req.body);
  if (f.error) return back(req, res, NEW, f.error, { values: typed(req.body) });
  const v = f.values;
  const chk = await barcodeChecks(v, null);
  if (chk.error) return back(req, res, NEW, chk.error, { values: typed(req.body) });
  const pic = await pictureFrom(req);
  if (pic.error) return back(req, res, NEW, pic.error, { values: typed(req.body) });
  let rows;
  try {
    ({ rows } = await pool.query(
      "INSERT INTO till_quick_items (name, price_cents, category, stock, barcode, image_url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [v.name, v.priceCents, v.category, v.stock, v.barcode, pic.url || null]
    ));
  } catch (err) {
    if (err.code === "23505") return back(req, res, NEW, TAKEN, { values: typed(req.body) });
    throw err;
  }
  let code = v.barcode;
  if (!code && req.body.generate === "1") code = await generateShopCode(rows[0].id);
  await audit(req, { action: "till.item_add", targetType: "till_quick_item", targetId: rows[0].id, detail: `${v.name} ${money(v.priceCents)}${code ? ` code ${code}` : ""}${pic.url ? ", with picture" : ""}` });
  return done(req, res, LIST, `Added "${v.name}".`);
});

router.post(`${LIST}/:id/generate-code`, requireAdmin, writeLimiter, async (req, res) => {
  const id = Number(req.params.id);
  const edit = `${LIST}/${id}/edit`;
  const { rows } = await pool.query("SELECT id, barcode FROM till_quick_items WHERE id = $1", [id]);
  if (!rows.length) return res.status(404).render("404");
  if (rows[0].barcode) return back(req, res, edit, "That item already has a barcode.");
  let code;
  try {
    code = await generateShopCode(id);
  } catch (err) {
    if (err.code === "23505") return back(req, res, edit, TAKEN);
    throw err;
  }
  await audit(req, { action: "till.item_code", targetType: "till_quick_item", targetId: id, detail: `generated ${code}` });
  return done(req, res, edit, `The shop code ${code} was saved: print its label.`);
});

router.post(`${LIST}/:id`, requireAdmin, writeLimiter, async (req, res) => {
  const id = Number(req.params.id);
  const edit = `${LIST}/${id}/edit`;
  const f = parseItemForm(req.body);
  if (f.error) return back(req, res, edit, f.error, { values: typed(req.body) });
  const v = f.values;
  const active = req.body.active === "1";
  const chk = await barcodeChecks(v, id, active);
  if (chk.error) return back(req, res, edit, chk.error, { values: typed(req.body) });
  const pic = await pictureFrom(req);
  if (pic.error) return back(req, res, edit, pic.error, { values: typed(req.body) });
  let rowCount;
  try {
    ({ rowCount } = await pool.query(
      `UPDATE till_quick_items SET name = $2, price_cents = $3, category = $4, stock = $5, active = $6, barcode = $7,
              image_url = COALESCE($8, image_url), updated_at = now() WHERE id = $1`,
      [id, v.name, v.priceCents, v.category, v.stock, active, v.barcode, pic.url || null]
    ));
  } catch (err) {
    if (err.code === "23505") return back(req, res, edit, TAKEN, { values: typed(req.body) });
    throw err;
  }
  if (!rowCount) return res.status(404).render("404");
  await audit(req, { action: "till.item_edit", targetType: "till_quick_item", targetId: id, detail: `${v.name} ${money(v.priceCents)}${active ? "" : " (disabled)"}${pic.url ? ", new picture" : ""}` });
  return done(req, res, LIST, `Saved "${v.name}".`);
});

// ---------- the Picture card: replace, rotate, crop, remove (the same image work as an educational item) ----------
// Plain form posts that work without JavaScript: the answer is a redirect back to the item (#picture) with the result in the card; a
// script sending `Accept: application/json` gets JSON and the real status. Every edit makes a NEW stored image; the old one stays in
// `images` until lib/imageCleanup.js finds that nothing refers to it.

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
    const m = /^\/admin\/till\/items\/(\d+)\/image\//.exec(req.originalUrl || "");
    if (m && !wantsJson(req)) return res.redirect(303, `${LIST}/${m[1]}/edit?picture=busy#picture`);
    return res.status(429).json({ ok: false, code: "busy", message: PICTURE_ERRORS.busy.message });
  },
});

async function loadItem(req, res) {
  const { rows } = await pool.query("SELECT id, name, image_url FROM till_quick_items WHERE id = $1", [Number(req.params.id)]);
  if (!rows[0]) { res.status(404).render("404"); return null; }
  return rows[0];
}

// Points the item at the new picture, but only while it still shows the picture that was edited.
async function setPicture(item, url) {
  const { rowCount } = await pool.query("UPDATE till_quick_items SET image_url = $1, updated_at = now() WHERE id = $2 AND image_url IS NOT DISTINCT FROM $3", [url, item.id, item.image_url]);
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
    await audit(req, { action: `till_item.image_${kind}`, targetType: "till_quick_item", targetId: item.id, detail: `${item.name}: ${detail(result)}` });
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
    const url = await saveImage(await coverFromPhoto(file && file.buffer), "image/jpeg", pool);
    await pool.query("UPDATE till_quick_items SET image_url = $1, updated_at = now() WHERE id = $2", [url, item.id]);
    await audit(req, { action: "till_item.image_replace", targetType: "till_quick_item", targetId: item.id, detail: `${item.name}: ${item.image_url ? "picture replaced" : "picture added"}` });
    return answerPicture(req, res, item.id, "replaced", { imageUrl: url });
  } catch (err) {
    if (!(err instanceof CoverEditError)) throw err;
    return answerPicture(req, res, item.id, err.code);
  }
});

// The picture itself stays in `images` for the unused-image cleanup.
router.post(`${LIST}/:id/image/remove`, requireAdmin, pictureLimiter, writeLimiter, async (req, res) => {
  const item = await loadItem(req, res);
  if (!item) return;
  if (item.image_url) {
    await pool.query("UPDATE till_quick_items SET image_url = NULL, updated_at = now() WHERE id = $1", [item.id]);
    await audit(req, { action: "till_item.image_remove", targetType: "till_quick_item", targetId: item.id, detail: item.name });
  }
  return answerPicture(req, res, item.id, "removed", { imageUrl: null });
});

module.exports = router;
