// Defaults and small helpers for the one-screen "Add a book" page that is used
// to scan many books in a row (views/admin/inventory/new.ejs,
// public/scan-intake.js). Kept apart from the routes so they can be tested alone.

const { BINDINGS, normalizeBinding, normalizeCondition, normalizeLocation, normalizeSource } = require("./inventory");

// What a fresh form starts with the very first time. After that every one of
// Location, Source, Binding and Condition is the last value used: carried by the
// query after a save, and remembered by the browser (public/scan-intake.js,
// public/inventory-location.js) for later visits.
const DEFAULT_LOCATION = "STORE";
const DEFAULT_SOURCE = "donation";
// The binding of a first-ever form is the last option of the list ("Other").
const firstUseBinding = () => (BINDINGS.length ? BINDINGS[BINDINGS.length - 1].value : null);

// A binding key from a query or from the browser's memory. The older key
// "paperback" is read as "trade" when the list has no "paperback" any more.
function rememberedBinding(raw) {
  const direct = normalizeBinding(raw);
  if (direct) return direct;
  if (raw === "paperback" && BINDINGS.some((b) => b.value === "trade")) return "trade";
  return null;
}

// The defaults of a fresh form, from the query string of the page.
function formDefaults(query) {
  const q = query || {};
  const queriedLocation = normalizeLocation(q.location);
  return {
    location: queriedLocation || DEFAULT_LOCATION,
    locationQueried: Boolean(queriedLocation),
    source: normalizeSource(q.source) || DEFAULT_SOURCE,
    binding: rememberedBinding(q.binding) || firstUseBinding(),
    condition: typeof q.condition === "string" && q.condition ? normalizeCondition(q.condition) : null,
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

module.exports = { DEFAULT_LOCATION, DEFAULT_SOURCE, firstUseBinding, rememberedBinding, formDefaults, carryQuery, savedCopy };
