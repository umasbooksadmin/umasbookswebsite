// Shared vocab for book-copy condition/status, used by both the admin
// routes (to validate/default incoming values) and the views (to build
// the <select> dropdowns) so the two never drift apart.

const { normalizeIsbn } = require("./bookLookup");
const { parseMoney } = require("./validation");

// The four condition grades: the single source of truth for the admin forms,
// the public pages, the cart and the emails. A copy that cannot be sold at all
// is not a condition: it gets the status "damaged / withdrawn" instead.
const CONDITIONS = [
  {
    value: "new", label: "New", label_fr: "Neuf",
    description: "Unread, as published (sold at the publisher's price).",
    description_fr: "Jamais lu, tel que publié (vendu au prix éditeur).",
  },
  {
    value: "like_new", label: "Like New", label_fr: "Comme neuf",
    description: "Looks unread: no marks, no wear.",
    description_fr: "Comme jamais lu : ni marques ni usure.",
  },
  {
    value: "very_good", label: "Very Good", label_fr: "Très bon état",
    description: "Light wear only: clean pages, no writing or highlighting.",
    description_fr: "Légère usure seulement : pages propres, sans annotations ni surlignage.",
  },
  {
    value: "acceptable", label: "Acceptable", label_fr: "État acceptable",
    description: "Clearly used but complete and readable: wear, creases or some markings.",
    description_fr: "Visiblement utilisé mais complet et lisible : usure, plis ou quelques annotations.",
  },
];

const DEFAULT_CONDITION = "very_good";

// How the book is bound. A property of the edition (books.binding), not of a
// copy; optional (NULL when nobody has said).
const BINDINGS = [
  { value: "hardcover", label: "Hardcover", label_fr: "Relié" },
  { value: "trade", label: "Trade", label_fr: "Broché (grand format)" },
  { value: "mass_market", label: "Mass Market", label_fr: "Poche" },
  { value: "other", label: "Other", label_fr: "Autre" },
];

// Old requests, imports and bookmarks may still say "paperback": it is now
// called "trade" (migration 077 renamed the stored values).
const BINDING_ALIASES = { paperback: "trade" };

const STATUSES = [
  { value: "in_stock", label: "In Store" },
  { value: "reserved", label: "Reserved" },
  { value: "sold", label: "Sold" },
  { value: "donated", label: "Donated" },
  { value: "damaged", label: "Damaged / withdrawn" },
];

// Where a copy came from (book_copies.source). NULL in the database means
// "unknown": every copy added before this existed.
const SOURCES = [
  { value: "donation", label: "Donation" },
  { value: "purchase", label: "Purchase" },
  { value: "lot", label: "Job lot" },
  { value: "other", label: "Other" },
];
const SOURCE_VALUES = new Set(SOURCES.map((s) => s.value));

// A source value from a form: one of the known ones, otherwise null (unknown).
function normalizeSource(value) {
  return SOURCE_VALUES.has(value) ? value : null;
}

const CONDITION_VALUES = new Set(CONDITIONS.map((c) => c.value));
const STATUS_VALUES = new Set(STATUSES.map((s) => s.value));

function normalizeCondition(value) {
  return CONDITION_VALUES.has(value) ? value : DEFAULT_CONDITION;
}

const BINDING_VALUES = new Set(BINDINGS.map((b) => b.value));

// A known binding value (the legacy "paperback" counts as "trade"), or null
// (blank, unknown, anything else).
function normalizeBinding(value) {
  const v = BINDING_ALIASES[value] || value;
  return BINDING_VALUES.has(v) ? v : null;
}

// Label of a grade/binding in the given language ("fr" or English); an
// unknown value is returned as is.
function conditionLabel(value, lang) {
  const c = CONDITIONS.find((x) => x.value === value);
  return c ? (lang === "fr" ? c.label_fr : c.label) : value;
}

function bindingLabel(value, lang) {
  const b = BINDINGS.find((x) => x.value === normalizeBinding(value));
  return b ? (lang === "fr" ? b.label_fr : b.label) : null;
}

// French fixed book price law (loi Lang, n° 81-766): a NEW book must be sold
// at the publisher's price, with at most 5% off. Used books are free-priced.
// Returns { error } or { price, publisherPrice } (both in euros, or null for
// non-new copies). A blank price on a new copy defaults to the publisher's.
function resolveCopyPricing(condition, rawPrice, rawPublisherPrice) {
  const hasPrice = rawPrice !== undefined && rawPrice !== null && String(rawPrice).trim() !== "";
  // Whatever the condition, a price that was typed must be real money: a
  // number of euros with at most 2 decimals, 0 to 10000 (see parseMoney).
  const typed = parseMoney(hasPrice ? rawPrice : "", { allowBlank: true });
  if (typed.error) return { error: typed.error };
  if (condition !== "new") {
    // Blank stays null (e.g. the pricing "manual review" case): such a copy is
    // listed but cannot be bought online (see isPurchasablePrice).
    return { price: typed.value, publisherPrice: null };
  }
  const pubCents = Math.round(Number(rawPublisherPrice) * 100);
  if (!Number.isFinite(pubCents) || pubCents <= 0 || String(rawPublisherPrice || "").trim() === "") {
    return { error: "New books need the publisher's price (prix éditeur): French law requires them to be sold at that price." };
  }
  const priceCents = hasPrice ? Math.round(Number(rawPrice) * 100) : pubCents;
  const euros = (c) => (c / 100).toFixed(2);
  if (!Number.isFinite(priceCents) || priceCents * 100 < 95 * pubCents || priceCents > pubCents) {
    const minCents = Math.ceil((95 * pubCents) / 100);
    return { error: `A new book must be sold at the publisher's price (€${euros(pubCents)}), with at most 5% off: the price must be between €${euros(minCents)} and €${euros(pubCents)}.` };
  }
  return { price: priceCents / 100, publisherPrice: pubCents / 100 };
}

// A copy can only be bought online (cart, checkout) when it has a real price:
// NULL (not priced yet), 0, negative or NaN never qualify. The SQL twin of this
// rule is `price IS NOT NULL AND price > 0` (src/routes/cart.js).
function isPurchasablePrice(price) {
  if (price === null || price === undefined || price === "") return false;
  const n = Number(price);
  return Number.isFinite(n) && n > 0;
}

function normalizeStatus(value) {
  return STATUS_VALUES.has(value) ? value : "in_stock";
}

// Books can belong to more than one genre — stored as a single
// comma-separated string in books.categories rather than a separate
// table, since it's still just free text staff type in (or an ISBN
// lookup fills in). This trims/dedupes/re-joins it into a consistent
// "Fantasy, Fiction" form so the same genre typed with different
// spacing or casing doesn't show up twice in the genre filters.
function normalizeGenres(value) {
  const seen = new Set();
  const genres = [];
  for (const raw of String(value || "").split(",")) {
    const genre = raw.trim();
    if (!genre || seen.has(genre.toLowerCase())) continue;
    seen.add(genre.toLowerCase());
    genres.push(genre);
  }
  return genres.length ? genres.join(", ") : null;
}

// Shelf/box location of a copy: free text such as "fiction a1". Stored
// trimmed, with runs of whitespace collapsed, upper-cased and at most 40
// characters, so "Fiction  a1" and "FICTION A1" are one location in the
// dropdown. Returns null when nothing is left.
const LOCATION_MAX = 40;
function normalizeLocation(value) {
  const s = String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, " ") // eslint-disable-line no-control-regex
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .slice(0, LOCATION_MAX)
    .trim();
  return s || null;
}

// Decides what a scanner (a keyboard that types a code then Enter) typed:
// an ISBN-10 or ISBN-13 (hyphens/spaces ignored, X check digit allowed) or
// something we don't recognise. The check digit is not verified, matching
// how ISBNs are stored elsewhere.
function parseScan(value) {
  const compact = String(value == null ? "" : value).replace(/[\s-]/g, "");
  if (/^\d{13}$/.test(compact) || /^\d{9}[\dXx]$/.test(compact)) {
    return { type: "isbn", isbn: normalizeIsbn(compact) };
  }
  return { type: "unknown" };
}

// A book can be stored under its ISBN-10 or ISBN-13 form while the barcode
// on the cover is always the 13-digit one: match either.
function isbnVariants(isbn) {
  const out = new Set([isbn]);
  if (/^978\d{10}$/.test(isbn)) {
    const body = isbn.slice(3, 12);
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += (10 - i) * Number(body[i]);
    const check = (11 - (sum % 11)) % 11;
    out.add(body + (check === 10 ? "X" : String(check)));
  } else if (/^\d{9}[\dX]$/.test(isbn)) {
    const body = "978" + isbn.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 ? 3 : 1);
    out.add(body + String((10 - (sum % 10)) % 10));
  }
  return [...out];
}

module.exports = { CONDITIONS, BINDINGS, DEFAULT_CONDITION, STATUSES, SOURCES, normalizeSource, LOCATION_MAX, normalizeCondition, normalizeBinding, conditionLabel, bindingLabel, resolveCopyPricing, isPurchasablePrice, normalizeStatus, normalizeGenres, normalizeLocation, parseScan, isbnVariants };
