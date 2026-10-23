// Filters for the admin Inventory book search (/admin/inventory): location,
// condition, price (copy-level) and binding (book-level), AND-ed with the text
// search and with each other. State lives in the query string, so a link or a
// reload keeps it:  ?q=..&location=..&condition=..&binding=..&priceMin=..&priceMax=..
//
// Copy-level filters (location, condition, price) are ONE EXISTS over
// book_copies: a book matches when a single in-stock copy satisfies all of
// them together. Binding is stored on books (books.binding), so it is a plain
// predicate on the book. Every user value goes in as a bound parameter.

const { CONDITIONS, BINDINGS, normalizeBinding, normalizeLocation, uniqueLocations } = require("./inventory");
const { parseMoney, clean } = require("./validation");
const { COMMON_GENRES } = require("./bookLookup");
const { likeContains } = require("./parseParams");

// Sentinels for the two special <select> choices (a location is free text of
// up to 40 characters, so these are chosen to be implausible as a real name).
const NO_LOCATION = "__none__";
const NO_BINDING = "__none__";
const NO_GENRE = "__none__";

const CONDITION_VALUES = new Set(CONDITIONS.map((c) => c.value));
const FILTER_KEYS = ["location", "condition", "binding", "genre", "priceMin", "priceMax"];

// query -> { q, location, condition, binding, priceMin, priceMax, priceMinText,
//            priceMaxText, errors: [..] }. Never throws. A bad value is ignored
// (that filter is off) and explained in `errors`.
function parseInventoryFilters(query) {
  const src = query && typeof query === "object" ? query : {};
  const errors = [];
  const out = { q: clean(src.q, 100), errors };

  const loc = clean(src.location, 80);
  out.location = loc === NO_LOCATION ? NO_LOCATION : normalizeLocation(loc);

  const cond = clean(src.condition, 40);
  out.condition = CONDITION_VALUES.has(cond) ? cond : null;
  if (cond && !out.condition) errors.push("That condition is not one of the choices, so it was ignored.");

  const bind = clean(src.binding, 40);
  out.binding = bind === NO_BINDING ? NO_BINDING : normalizeBinding(bind);
  if (bind && !out.binding) errors.push("That binding is not one of the choices, so it was ignored.");

  const genre = clean(src.genre, 60).replace(/\s+/g, " ");
  out.genre = genre === NO_GENRE ? NO_GENRE : genre || null;

  for (const [key, label] of [["priceMin", "Min price"], ["priceMax", "Max price"]]) {
    const text = clean(src[key], 20);
    out[`${key}Text`] = text;
    const r = parseMoney(text, { allowBlank: true, label });
    if (r.error) { errors.push(`${r.error} It was ignored.`); out[key] = null; } else out[key] = r.value;
  }
  if (out.priceMin != null && out.priceMax != null && out.priceMin > out.priceMax) {
    errors.push("Min price is higher than Max price, so no copy can match.");
  }
  return out;
}

const hasCopyFilter = (f) => !!(f.location || f.condition || f.priceMin != null || f.priceMax != null);
const hasAnyFilter = (f) => hasCopyFilter(f) || !!f.binding || !!f.genre;

// The copy-level predicates, as SQL over alias `alias`, pushing values into
// `params`. Always restricted to in-stock copies when any copy filter is on.
function copyPredicates(f, params, alias) {
  const preds = [`${alias}.status = 'in_stock'`];
  if (f.location === NO_LOCATION) preds.push(`${alias}.location IS NULL`);
  else if (f.location) { params.push(f.location); preds.push(`lower(${alias}.location) = lower($${params.length})`); }
  if (f.condition) { params.push(f.condition); preds.push(`${alias}.condition = $${params.length}`); }
  if (f.priceMin != null) { params.push(f.priceMin); preds.push(`${alias}.price >= $${params.length}`); }
  if (f.priceMax != null) { params.push(f.priceMax); preds.push(`${alias}.price <= $${params.length}`); }
  return preds;
}

// Appends this search's WHERE conditions to `conditions` / `params` (book alias b).
function addFilterConditions(f, conditions, params) {
  if (f.binding === NO_BINDING) conditions.push("b.binding IS NULL");
  else if (f.binding) { params.push(f.binding); conditions.push(`b.binding = $${params.length}`); }
  // Genres are a comma-separated string (books.categories): match one whole,
  // trimmed, case-insensitive entry, never a substring ("Fiction" is not "Non-fiction").
  if (f.genre === NO_GENRE) {
    conditions.push("NOT EXISTS (SELECT 1 FROM unnest(string_to_array(b.categories, ',')) AS g WHERE btrim(g) <> '')");
  } else if (f.genre) {
    params.push(f.genre);
    conditions.push(`EXISTS (SELECT 1 FROM unnest(string_to_array(b.categories, ',')) AS g WHERE lower(btrim(g)) = lower($${params.length}))`);
  }
  if (hasCopyFilter(f)) {
    const preds = copyPredicates(f, params, "fc");
    conditions.push(`EXISTS (SELECT 1 FROM book_copies fc WHERE fc.book_id = b.id AND ${preds.join(" AND ")})`);
  }
}

// The whole search (text + filters) as { conditions, params } over the book alias b: the ONE place the on-screen
// list and the CSV download of its results get their WHERE from.
function buildSearchWhere(f) {
  const params = [];
  const conditions = [];
  if (f.q) {
    params.push(likeContains(f.q));
    conditions.push(`(b.title ILIKE $${params.length} OR b.authors ILIKE $${params.length} OR b.isbn ILIKE $${params.length})`);
  }
  addFilterConditions(f, conditions, params);
  return { conditions, params };
}

// SQL (over copy alias `alias`) for the copies that matched the copy-level filters, or "" when none is on (then every
// copy of a matching book counts). Pushes its values into `params`.
function copyMatchCondition(f, params, alias) {
  return hasCopyFilter(f) ? copyPredicates(f, params, alias).join(" AND ") : "";
}

// The copies that made each book match (same predicates), for the result rows.
async function matchingCopies(pool, f, bookIds) {
  if (!hasCopyFilter(f) || !bookIds.length) return new Map();
  const params = [bookIds];
  const preds = copyPredicates(f, params, "c");
  const { rows } = await pool.query(
    `SELECT c.id, c.book_id, c.location, c.condition, c.price FROM book_copies c
     WHERE c.book_id = ANY($1::int[]) AND ${preds.join(" AND ")} ORDER BY c.book_id, c.id`,
    params
  );
  const byBook = new Map();
  for (const r of rows) {
    if (!byBook.has(r.book_id)) byBook.set(r.book_id, []);
    byBook.get(r.book_id).push({ id: r.id, location: r.location, condition: r.condition, price: r.price == null ? null : Number(r.price) });
  }
  return byBook;
}

// Locations of in-stock copies for the dropdown: one entry per
// case-insensitive name, in its most common spelling.
async function filterLocations(pool) {
  const { rows } = await pool.query(
    "SELECT location, COUNT(*)::int AS count, MAX(updated_at) AS last FROM book_copies WHERE status = 'in_stock' AND location IS NOT NULL GROUP BY location"
  );
  return uniqueLocations(rows);
}

// The query string that reproduces the active filters ("" when none).
function filterQueryString(f) {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.location) p.set("location", f.location);
  if (f.condition) p.set("condition", f.condition);
  if (f.binding) p.set("binding", f.binding);
  if (f.genre) p.set("genre", f.genre);
  if (f.priceMinText) p.set("priceMin", f.priceMinText);
  if (f.priceMaxText) p.set("priceMax", f.priceMaxText);
  return p.toString();
}

module.exports = {
  NO_LOCATION, NO_BINDING, NO_GENRE, FILTER_KEYS, BINDINGS, CONDITIONS, COMMON_GENRES,
  parseInventoryFilters, hasCopyFilter, hasAnyFilter, addFilterConditions, buildSearchWhere, copyMatchCondition, matchingCopies, filterLocations, filterQueryString,
};
