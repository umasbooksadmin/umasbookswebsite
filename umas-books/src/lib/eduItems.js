// Educational items (worksheets, flash cards...): the second thing the shop sells online, next to books
// (migration 113). Owner-approved 2026-11-02:
//   - each item has a picture, a NAME, a PRICE and a STOCK quantity. Names and genres are English only (on the French
//     site too, like book titles and genres); every other text of the page is EN / FR.
//   - all of them are NEW goods (never second-hand): the page and the order lines say so.
//   - STOCK (owner decision 2026-11-02, replacing "no stock"): edu_items.stock is the number of units in the shop, held
//     ones included. A reserved unit is HELD while its reservation is open: the held units of an item are its order
//     lines on orders with status 'reserved' (HELD_SQL). So a cancelled or expired reservation, or a partial pickup's
//     remainder, needs no release step: its order leaves 'reserved' (or the lines move to the new reserved order) and
//     the count follows. Available = stock - held. Collecting (the admin button or the till, lib/orderActions.js) turns
//     the hold into a sale: the collected units come off stock in the same transaction. A refund puts them back on
//     stock, like a refunded book goes back on the shelf. Oversell is impossible: the reservation locks the item rows
//     FOR UPDATE and counts the held units AFTER the lock (two statements, as for drop-in seats), and the admin's stock
//     edit takes the same lock and refuses a stock below what is held.
//   - reserved online through the SAME cart and reservation as books (routes/cart.js, lib/cart.js) and paid at the shop
//     when collected (the admin "Mark collected and paid" button or the till), at the price shown. A cart line has a
//     quantity (1..MAX_EDU_QTY); the reservation writes ONE order line per unit (order_items.edu_item_id), exactly like
//     drop-in seats, so every per-line rule (partial pickup, the till, the reports) works unchanged.
//   - COST (migration 115, admin-only): edu_items.cost is what the shop paid for one unit (NULL = not known). Each
//     reserved unit's order line keeps a SNAPSHOT of it (order_items.unit_cost, like item_title and price), so the Sales
//     report's margin and the accounting memo of the cost of items sold never change when the cost is edited later.
//     Never selected by a public read (loadPublicItems / loadCartEduItems name their columns).
//   - accounting: their own category, "Educational items" (lib/accounting.js, credit 707 by default: sale of goods).
//   - a pickup discount ("Amount received" below the list price, with a note) may fall on them like on a seat: no legal
//     floor (the fixed book price law is for books only). There is no membership discount anywhere in the app.
//
// This file: the constants, the public reads (the Browse page, the cart), and the admin's validation.

const { slugify, PALETTE, PALETTE_KEYS, ICONS, DEFAULT_ICON, nextColour } = require("./browseGenres");
const { parseMoney } = require("./validation");

// The most of ONE item a cart line can hold (the select in the cart offers 1..MAX_EDU_QTY).
const MAX_EDU_QTY = 10;
const NAME_MAX = 120;
const GENRE_NAME_MAX = 60;
const PRICE_MAX = 10000;
const SEARCH_MAX = 100;
const STOCK_MAX = 100000;

// The units of item `alias`.id held by open reservations (an SQL expression).
const HELD_SQL = (alias = "i") => `(SELECT COUNT(*) FROM order_items hoi JOIN orders ho ON ho.id = hoi.order_id
  WHERE hoi.edu_item_id = ${alias}.id AND ho.status = 'reserved')`;

// "3" -> 3; anything else (blank, 0, 11, "2.5", "1e1") -> null.
function parseQty(raw) {
  const s = String(raw ?? "").trim();
  if (!/^\d{1,2}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= MAX_EDU_QTY ? n : null;
}

// A genre row -> what the Browse tile needs (the same colours and icons as Browse Books).
function genreTile(g) {
  const palette = PALETTE[g.colour] || PALETTE[PALETTE_KEYS[(g.id || 0) % PALETTE_KEYS.length]];
  const icon = ICONS[g.icon] || ICONS[DEFAULT_ICON];
  return { id: g.id, name: g.name, slug: g.slug, bg: palette.bg, fg: palette.fg, svg: icon.svg, count: g.count == null ? null : Number(g.count) };
}

// Every genre, in order, with the number of SHOWN items in it (count).
async function loadGenres(db) {
  const { rows } = await db.query(
    `SELECT g.*, (SELECT COUNT(*) FROM edu_items i WHERE i.genre_id = g.id AND NOT i.is_hidden)::int AS count,
            (SELECT COUNT(*) FROM edu_items i WHERE i.genre_id = g.id)::int AS all_count
     FROM edu_genres g ORDER BY g.sort_order, lower(g.name), g.id`
  );
  return rows;
}

// The shown items for the Browse page: a genre slug ('' = all) and a search (matched against the name and the genre,
// case- and accent-insensitive enough for English names: ILIKE on the words). -> rows with genre_name / genre_slug.
async function loadPublicItems(db, { genre = "", q = "" } = {}) {
  const params = [];
  const where = ["NOT i.is_hidden"];
  if (genre) {
    params.push(genre);
    where.push(`g.slug = $${params.length}`);
  }
  const words = String(q || "").trim().slice(0, SEARCH_MAX).split(/\s+/).filter(Boolean).slice(0, 8);
  for (const w of words) {
    params.push(`%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`(i.name ILIKE $${params.length} OR g.name ILIKE $${params.length})`);
  }
  const { rows } = await db.query(
    `SELECT i.id, i.name, i.price, i.image_url, g.name AS genre_name, g.slug AS genre_slug,
            GREATEST(i.stock - ${HELD_SQL("i")}, 0)::int AS available
     FROM edu_items i LEFT JOIN edu_genres g ON g.id = i.genre_id
     WHERE ${where.join(" AND ")}
     ORDER BY lower(i.name), i.id`,
    params
  );
  return rows;
}

// The cart's view of its educational lines: only items still shown with a real price, with what can still be reserved
// (available = stock - held). -> Map(id -> row).
async function loadCartEduItems(db, ids) {
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT i.id, i.name, i.price, i.image_url, GREATEST(i.stock - ${HELD_SQL("i")}, 0)::int AS available
     FROM edu_items i WHERE i.id = ANY($1::int[]) AND NOT i.is_hidden AND i.price > 0`,
    [ids]
  );
  return new Map(rows.map((r) => [r.id, r]));
}

// ---------- admin validation (Admin > Educational items) ----------

// The item form -> { values } or { error } (one sentence, nothing saved). genreIds: the existing genre ids.
function parseItemForm(body, genreIds) {
  const name = String(body.name ?? "").replace(/\s+/g, " ").trim();
  if (!name) return { error: "Give the item a name. Nothing was saved." };
  if (name.length > NAME_MAX) return { error: `The name is limited to ${NAME_MAX} characters. Nothing was saved.` };
  const price = parseMoney(body.price, { allowBlank: false, max: PRICE_MAX });
  if (price.error || price.value == null) return { error: "Enter a price in euros, like 4.50 or 4,50. Nothing was saved." };
  if (!(price.value > 0)) return { error: "The price must be above 0. Nothing was saved." };
  if (price.value > PRICE_MAX) return { error: `The price can be at most €${PRICE_MAX}. Nothing was saved.` };
  const rawGenre = String(body.genreId ?? "").trim();
  let genreId = null;
  if (rawGenre !== "") {
    genreId = Number(rawGenre);
    if (!Number.isSafeInteger(genreId) || !genreIds.includes(genreId)) return { error: "Choose one of the genres. Nothing was saved." };
  }
  const rawStock = String(body.stock ?? "").trim();
  if (!/^\d{1,6}$/.test(rawStock) || Number(rawStock) > STOCK_MAX) return { error: `Enter the number in stock as a whole number from 0 to ${STOCK_MAX}. Nothing was saved.` };
  const cost = parseCost(body.cost);
  if (cost.error) return { error: cost.error };
  return { values: { name, price: price.value, cost: cost.value, stock: Number(rawStock), genreId, sortOrder: 0, isHidden: body.isHidden === "on" } };
}

// "Cost per unit (what we paid)": optional, admin-only (migration 115). Blank = not known (null); otherwise euros with
// a comma or a point, 0 allowed (a free sample), at most 2 decimals and PRICE_MAX. -> { value } | { error }.
function parseCost(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return { value: null };
  const c = parseMoney(String(raw), { allowBlank: true, max: PRICE_MAX });
  if (c.error) {
    if (/negative/.test(c.error)) return { error: "The cost cannot be negative. Leave it empty if you do not know it. Nothing was saved." };
    if (/decimals/.test(c.error)) return { error: "The cost can have at most 2 decimals (cents), like 1.85 or 1,85. Nothing was saved." };
    return { error: `Enter the cost per unit in euros, like 1.85 or 1,85 (from 0 to €${PRICE_MAX}), or leave it empty if you do not know it. Nothing was saved.` };
  }
  return { value: c.value };
}

// Margin per unit (price minus cost), in euros, or null when the cost is not known.
const unitMargin = (price, cost) => (cost == null ? null : Math.round(Number(price) * 100 - Number(cost) * 100) / 100);

// A new genre's name -> { name, slug } or { error }.
function parseGenreName(raw, existingSlugs) {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!name) return { error: "Type the genre's name. Nothing was saved." };
  if (name.length > GENRE_NAME_MAX) return { error: `A genre name is limited to ${GENRE_NAME_MAX} characters. Nothing was saved.` };
  let slug = slugify(name);
  for (let n = 2; existingSlugs.includes(slug); n++) slug = `${slugify(name).slice(0, 36)}-${n}`;
  return { name, slug };
}

module.exports = {
  MAX_EDU_QTY, NAME_MAX, GENRE_NAME_MAX, PRICE_MAX, SEARCH_MAX, STOCK_MAX, HELD_SQL,
  parseQty, genreTile, loadGenres, loadPublicItems, loadCartEduItems, parseItemForm, parseCost, unitMargin, parseGenreName, nextColour,
};
