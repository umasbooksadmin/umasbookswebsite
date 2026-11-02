// Admin > Educational items (lib/eduItems.js). English only, admins only (requireAdmin: two-step verification
// required, like every other admin page), CSRF-protected (src/app.js), every change audit-logged.
//
//   GET  /admin/edu-items                    the list (stock, held by open reservations, available) and the genres
//   GET  /admin/edu-items/new                the add form
//   POST /admin/edu-items                    add (multipart: optional picture "image", src/app.js runs multer)
//   GET  /admin/edu-items/:id/edit           the edit form
//   POST /admin/edu-items/:id                save (name, price, cost, stock, genre, sort, hidden, a new picture)
//   POST /admin/edu-items/:id/visibility     hide / show
//   POST /admin/edu-items/:id/image/remove   remove the picture
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

const express = require("express");
const { pool, withTransaction } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { validateIdParams } = require("../../middleware/idParams");
const { limit } = require("../../middleware/rateLimits");
const { audit } = require("../../lib/audit");
const { saveImage } = require("../../lib/imageStore");
const { coverFromPhoto, CoverEditError, COVER_ERRORS } = require("../../lib/coverEdit");
const { redirectWithFlash, takePageFlash } = require("../../lib/postRedirect");
const edu = require("../../lib/eduItems");
const { PALETTE_KEYS } = require("../../lib/browseGenres");

const router = express.Router();
validateIdParams(router, "id");

const writeLimiter = limit({ windowMs: 60 * 60 * 1000, max: 300 });
const FLASH = "adminEduItems";
const LIST = "/admin/edu-items";
const money = (v) => Number(v).toFixed(2);
// The cost in an audit line: "cost €1.20" / "cost not known" (bare: "€1.20" / "not known").
const costText = (c, bare = false) => `${bare ? "" : "cost "}${c == null ? "not known" : `€${money(c)}`}`;

const back = (req, res, to, message, extra = {}) => redirectWithFlash(req, res, to, FLASH, { error: message, ...extra });
const done = (req, res, to, notice) => redirectWithFlash(req, res, to, FLASH, { notice });

// The picture, when one was sent: the same processing as a book cover photo (lib/coverEdit.js: turned upright, at most
// 900 px, JPEG), stored in `images`. -> { url } | { error } | {} (no file).
async function pictureFrom(req) {
  const file = req.files && req.files.image && req.files.image[0];
  if (!file || !file.buffer || !file.buffer.length) return {};
  try {
    const data = await coverFromPhoto(file.buffer);
    return { url: await saveImage(data, "image/jpeg", pool) };
  } catch (err) {
    if (err instanceof CoverEditError) return { error: (COVER_ERRORS[err.code] || COVER_ERRORS["not-image"]).message.replace("to be a cover", "for an item") };
    throw err;
  }
}

async function genreIds() {
  const { rows } = await pool.query("SELECT id FROM edu_genres");
  return rows.map((r) => r.id);
}

router.get(LIST, requireAdmin, async (req, res) => {
  const flash = takePageFlash(req, res, FLASH) || {};
  const { rows: items } = await pool.query(
    `SELECT i.*, g.name AS genre_name, ${edu.HELD_SQL("i")}::int AS held,
            (SELECT COUNT(*) FROM order_items oi WHERE oi.edu_item_id = i.id)::int AS order_lines
     FROM edu_items i LEFT JOIN edu_genres g ON g.id = i.genre_id
     ORDER BY i.is_hidden, i.sort_order, lower(i.name), i.id`
  );
  for (const i of items) {
    i.available = Math.max(0, i.stock - i.held);
    i.margin = edu.unitMargin(i.price, i.cost);
  }
  const genres = await edu.loadGenres(pool);
  res.render("admin/edu_items", { active: "edu-items", items, genres, error: flash.error || null, notice: flash.notice || null, money });
});

async function renderForm(req, res, item) {
  const flash = takePageFlash(req, res, FLASH) || {};
  const genres = await edu.loadGenres(pool);
  let held = 0;
  if (item) held = (await pool.query(`SELECT ${edu.HELD_SQL("i")}::int AS held FROM edu_items i WHERE i.id = $1`, [item.id])).rows[0].held;
  const v = flash.values || (item ? { name: item.name, price: money(item.price), cost: item.cost == null ? "" : money(item.cost), stock: String(item.stock), genreId: item.genre_id == null ? "" : String(item.genre_id), sortOrder: String(item.sort_order), isHidden: item.is_hidden ? "on" : "" } : { name: "", price: "", cost: "", stock: "0", genreId: genres[0] ? String(genres[0].id) : "", sortOrder: "0", isHidden: "" });
  res.render("admin/edu_item_form", { active: "edu-items", item, held, values: v, genres, error: flash.error || null, notice: flash.notice || null, maxStock: edu.STOCK_MAX });
}

router.get(`${LIST}/new`, requireAdmin, (req, res) => renderForm(req, res, null));

router.get(`${LIST}/:id/edit`, requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM edu_items WHERE id = $1", [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).render("404");
  return renderForm(req, res, rows[0]);
});

// What the form sent, to put back in the form after a refusal.
const typed = (b) => ({ name: String(b.name ?? "").slice(0, 200), price: String(b.price ?? "").slice(0, 20), cost: String(b.cost ?? "").slice(0, 20), stock: String(b.stock ?? "").slice(0, 10), genreId: String(b.genreId ?? ""), sortOrder: String(b.sortOrder ?? "").slice(0, 10), isHidden: b.isHidden === "on" ? "on" : "" });

router.post(LIST, requireAdmin, writeLimiter, async (req, res) => {
  const f = edu.parseItemForm(req.body, await genreIds());
  if (f.error) return back(req, res, `${LIST}/new`, f.error, { values: typed(req.body) });
  const pic = await pictureFrom(req);
  if (pic.error) return back(req, res, `${LIST}/new`, pic.error, { values: typed(req.body) });
  const v = f.values;
  const { rows } = await pool.query(
    `INSERT INTO edu_items (name, price, cost, stock, genre_id, sort_order, is_hidden, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [v.name, v.price, v.cost, v.stock, v.genreId, v.sortOrder, v.isHidden, pic.url || null]
  );
  await audit(req, { action: "edu_item.add", targetType: "edu_item", targetId: rows[0].id, detail: `${v.name}, €${money(v.price)}, ${costText(v.cost)}, stock ${v.stock}${v.isHidden ? ", hidden" : ""}${pic.url ? ", with picture" : ""}` });
  return done(req, res, LIST, `Added "${v.name}".`);
});

router.post(`${LIST}/:id`, requireAdmin, writeLimiter, async (req, res) => {
  const id = Number(req.params.id);
  const edit = `${LIST}/${id}/edit`;
  const f = edu.parseItemForm(req.body, await genreIds());
  if (f.error) return back(req, res, edit, f.error, { values: typed(req.body) });
  const pic = await pictureFrom(req);
  if (pic.error) return back(req, res, edit, pic.error, { values: typed(req.body) });
  const v = f.values;
  const r = await withTransaction(pool, async (client) => {
    // The reservation's lock (lib/cart.js): no reservation can take a unit between the count and the save.
    const { rows } = await client.query("SELECT * FROM edu_items WHERE id = $1 FOR UPDATE", [id]);
    const old = rows[0];
    if (!old) return { outcome: "not_found" };
    const { rows: h } = await client.query(`SELECT ${edu.HELD_SQL("i")}::int AS held FROM edu_items i WHERE i.id = $1`, [id]);
    const held = h[0].held;
    if (v.stock < held) return { outcome: "below_held", held };
    await client.query(
      `UPDATE edu_items SET name = $2, price = $3, stock = $4, genre_id = $5, sort_order = $6, is_hidden = $7,
              image_url = COALESCE($8, image_url), cost = $9, updated_at = now() WHERE id = $1`,
      [id, v.name, v.price, v.stock, v.genreId, v.sortOrder, v.isHidden, pic.url || null, v.cost]
    );
    return { outcome: "saved", old };
  });
  if (r.outcome === "not_found") return res.status(404).render("404");
  if (r.outcome === "below_held") {
    return back(req, res, edit, `The stock cannot be lower than ${r.held}: open reservations hold ${r.held} of this item. Collect or cancel them first. Nothing was saved.`, { values: typed(req.body) });
  }
  const o = r.old;
  const changes = [];
  if (o.name !== v.name) changes.push(`name "${o.name}" -> "${v.name}"`);
  if (Math.round(Number(o.price) * 100) !== Math.round(v.price * 100)) changes.push(`price €${money(o.price)} -> €${money(v.price)}`);
  if ((o.cost == null ? null : Math.round(Number(o.cost) * 100)) !== (v.cost == null ? null : Math.round(v.cost * 100))) changes.push(`cost ${costText(o.cost, true)} -> ${costText(v.cost, true)}`);
  if (o.stock !== v.stock) changes.push(`stock ${o.stock} -> ${v.stock}`);
  if ((o.genre_id ?? null) !== v.genreId) changes.push("genre changed");
  if (o.sort_order !== v.sortOrder) changes.push(`sort ${o.sort_order} -> ${v.sortOrder}`);
  if (o.is_hidden !== v.isHidden) changes.push(v.isHidden ? "hidden" : "shown");
  if (pic.url) changes.push("new picture");
  await audit(req, { action: "edu_item.edit", targetType: "edu_item", targetId: id, detail: changes.join("; ") || "no change" });
  return done(req, res, LIST, `Saved "${v.name}".`);
});

router.post(`${LIST}/:id/visibility`, requireAdmin, writeLimiter, async (req, res) => {
  const id = Number(req.params.id);
  const hide = req.body.hide === "1";
  const { rows } = await pool.query("UPDATE edu_items SET is_hidden = $2, updated_at = now() WHERE id = $1 RETURNING name", [id, hide]);
  if (!rows[0]) return res.status(404).render("404");
  await audit(req, { action: hide ? "edu_item.hide" : "edu_item.show", targetType: "edu_item", targetId: id, detail: rows[0].name });
  return done(req, res, LIST, hide ? `"${rows[0].name}" is hidden: customers no longer see it. Reservations already made keep it.` : `"${rows[0].name}" is shown again.`);
});

router.post(`${LIST}/:id/image/remove`, requireAdmin, writeLimiter, async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query("UPDATE edu_items SET image_url = NULL, updated_at = now() WHERE id = $1 RETURNING name", [id]);
  if (!rows[0]) return res.status(404).render("404");
  await audit(req, { action: "edu_item.image_remove", targetType: "edu_item", targetId: id, detail: rows[0].name });
  return done(req, res, `${LIST}/${id}/edit`, "The picture was removed.");
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
