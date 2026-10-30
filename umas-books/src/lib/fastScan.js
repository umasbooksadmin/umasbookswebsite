// Defaults and small helpers for the one-screen "Add a book" page that is used
// to scan many books in a row (views/admin/inventory/new.ejs,
// public/scan-intake.js). Kept apart from the routes so they can be tested alone.

const { BINDINGS, normalizeBinding, normalizeCondition, normalizeLocation, normalizeSource } = require("./inventory");

// What a fresh form starts with the very first time. After that every one of
// Location, Source, Binding and Condition is the last value used: carried by the
// query after a save, and remembered by the browser (public/scan-intake.js,
// public/inventory-location.js) for later visits.
const DEFAULT_LOCATION = "Store";
const DEFAULT_SOURCE = "donation";
// The binding of a first-ever form is the last option of the list ("Other").
const firstUseBinding = () => (BINDINGS.length ? BINDINGS[BINDINGS.length - 1].value : null);

// The values of a first-ever form: where "Reset choices" on the scan page goes back to.
const firstUseValues = () => ({ location: DEFAULT_LOCATION, source: DEFAULT_SOURCE, binding: firstUseBinding() || "", condition: "very_good" });

// A binding key from a query or from the browser's memory. The older key
// "paperback" is read as "trade" when the list has no "paperback" any more.
function rememberedBinding(raw) {
  const direct = normalizeBinding(raw);
  if (direct) return direct;
  if (raw === "paperback" && BINDINGS.some((b) => b.value === "trade")) return "trade";
  return null;
}

// What this admin entered on the last copy they saved: Location, Source,
// Condition and the book's Binding (any may be null). A fresh browser (or phone)
// has nothing remembered, so this is what its form starts with; only an admin who
// never saved a copy gets the first-ever values (Store, Donation, Other, Very Good).
async function lastUsed(pool, userId) {
  if (!userId) return {};
  const { rows } = await pool.query(
    `SELECT c.location, c.source, c.condition, b.binding
     FROM book_copies c JOIN books b ON b.id = c.book_id
     WHERE c.created_by = $1 ORDER BY c.id DESC LIMIT 1`,
    [userId]
  );
  return rows[0] || {};
}

// The defaults of a fresh form, from the query string of the page (a save
// carries what was just used) and, failing that, the last copy this admin saved
// (`last`, see lastUsed()); the first-ever values only when there is neither.
function formDefaults(query, last) {
  const q = query || {};
  const l = last || {};
  const queriedLocation = normalizeLocation(q.location);
  return {
    location: queriedLocation || normalizeLocation(l.location) || DEFAULT_LOCATION,
    locationQueried: Boolean(queriedLocation),
    source: normalizeSource(q.source) || normalizeSource(l.source) || DEFAULT_SOURCE,
    binding: rememberedBinding(q.binding) || rememberedBinding(l.binding) || firstUseBinding(),
    condition: typeof q.condition === "string" && q.condition ? normalizeCondition(q.condition) : (l.condition ? normalizeCondition(l.condition) : null),
    // Which values the address carried (the browser's memory fills in the others).
    queried: { binding: Boolean(rememberedBinding(q.binding)), source: Boolean(normalizeSource(q.source)), condition: typeof q.condition === "string" && Boolean(q.condition) },
  };
}

// The query string that carries the values to keep to the next form.
function carryQuery({ location, source, binding, condition, copyId, requests }) {
  const p = new URLSearchParams();
  p.set("saved", String(copyId));
  if (location) p.set("location", location);
  if (source) p.set("source", source);
  if (binding) p.set("binding", binding);
  if (condition) p.set("condition", condition);
  if (requests) p.set("requests", String(requests));
  return p.toString();
}

// The copy a "saved" flag points at: its id, title and label address, or null.
async function savedCopy(pool, rawId) {
  if (!/^\d{1,9}$/.test(String(rawId || ""))) return null;
  const { rows } = await pool.query(
    "SELECT c.id, b.title FROM book_copies c JOIN books b ON b.id = c.book_id WHERE c.id = $1", [Number(rawId)]
  );
  return rows[0] || null;
}

module.exports = { firstUseValues, lastUsed, DEFAULT_LOCATION, DEFAULT_SOURCE, firstUseBinding, rememberedBinding, formDefaults, carryQuery, savedCopy };
