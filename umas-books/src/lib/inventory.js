// Shared vocab for book-copy condition/status, used by both the admin
// routes (to validate/default incoming values) and the views (to build
// the <select> dropdowns) so the two never drift apart.

const { normalizeIsbn } = require("./bookLookup");

const CONDITIONS = [
  { value: "new", label: "New" },
  { value: "like_new", label: "Like New" },
  { value: "good", label: "Good" },
  { value: "fair", label: "Fair" },
  { value: "poor", label: "Poor" },
];

const STATUSES = [
  { value: "in_stock", label: "In Store" },
  { value: "reserved", label: "Reserved" },
  { value: "sold", label: "Sold" },
  { value: "donated", label: "Donated" },
  { value: "damaged", label: "Damaged / withdrawn" },
];

const CONDITION_VALUES = new Set(CONDITIONS.map((c) => c.value));
const STATUS_VALUES = new Set(STATUSES.map((s) => s.value));

function normalizeCondition(value) {
  return CONDITION_VALUES.has(value) ? value : "good";
}

// French fixed book price law (loi Lang, n° 81-766): a NEW book must be sold
// at the publisher's price, with at most 5% off. Used books are free-priced.
// Returns { error } or { price, publisherPrice } (both in euros, or null for
// non-new copies). A blank price on a new copy defaults to the publisher's.
function resolveCopyPricing(condition, rawPrice, rawPublisherPrice) {
  const hasPrice = rawPrice !== undefined && rawPrice !== null && String(rawPrice).trim() !== "";
  if (condition !== "new") {
    return { price: hasPrice ? Number(rawPrice) : null, publisherPrice: null };
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

module.exports = { CONDITIONS, STATUSES, LOCATION_MAX, normalizeCondition, resolveCopyPricing, normalizeStatus, normalizeGenres, normalizeLocation, parseScan, isbnVariants };
