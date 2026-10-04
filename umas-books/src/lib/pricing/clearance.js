// Clearance: when the shop already holds 2 or more copies (in stock +
// reserved) of the same book, the next copy goes to the clearance bin at
// EUR 1 (numbers are settings). These are the database helpers; the decision
// itself is made in rules.js.

const { isbnVariants } = require("../inventory");
const { normalizeIsbn } = require("../bookLookup");
const { toIsbn13 } = require("./isbn");
const { suggestFromRules } = require("./rules");

const HELD = ["in_stock", "reserved"];
const CANDIDATE_LIMIT = 500;

// How many copies of this book the shop already holds. The book is found by
// ISBN (either form, ISBN-10 or ISBN-13) or, when editing a copy, by the copy
// itself; in the latter case only OLDER copies count, so the 3rd copy is
// copy no. 3 however many were added after it.
async function countHeldCopies(pool, { isbn, copyId } = {}) {
  if (copyId) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM book_copies o
       JOIN book_copies me ON me.id = $1 AND me.book_id = o.book_id
       WHERE o.status = ANY($2) AND o.id <> me.id AND (o.created_at, o.id) < (me.created_at, me.id)`,
      [copyId, HELD]
    );
    return rows[0].n;
  }
  if (!normalizeIsbn(isbn)) return 0;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM book_copies c JOIN books b ON b.id = c.book_id
     WHERE b.isbn = ANY($1) AND c.status = ANY($2)`,
    [isbnVariants(normalizeIsbn(String(isbn))), HELD]
  );
  return rows[0].n;
}

// The other copies of this book that scope 'all' would also put on clearance
// (in stock, not new, not already clearance). Reserved copies keep their price.
async function otherRepriceableCopies(pool, isbn) {
  if (!normalizeIsbn(isbn)) return [];
  const { rows } = await pool.query(
    `SELECT c.id, c.book_id, c.price, c.condition FROM book_copies c JOIN books b ON b.id = c.book_id
     WHERE b.isbn = ANY($1) AND c.status = 'in_stock' AND c.condition <> 'new' AND NOT c.is_clearance
     ORDER BY c.created_at, c.id`,
    [isbnVariants(normalizeIsbn(String(isbn)))]
  );
  return rows;
}

// Cached market data for ISBNs (database only: never an AI call).
async function cachedComparables(pool, isbns) {
  const keys = [...new Set(isbns.map(toIsbn13).filter(Boolean))];
  if (!keys.length) return new Map();
  const { rows } = await pool.query("SELECT isbn, data FROM price_lookups WHERE isbn = ANY($1) AND state = 'ok'", [keys]);
  return new Map(rows.map((r) => [r.isbn, r.data || {}]));
}

// Rules-only suggestion for an existing copy of a book, using whatever market
// data is already cached. No AI call, no clearance.
function rulesSuggestionFor(copy, cache, settings) {
  const data = cache.get(toIsbn13(copy.isbn)) || {};
  return suggestFromRules({
    condition: copy.condition, binding: copy.binding, isbn: copy.isbn,
    comparables: (data.comparables || []).map((c) => c.price), originalPrice: data.originalPrice,
    publisherPrice: copy.publisher_price, settings,
  });
}

// Books with more copies than clearance_after_copies whose extra copies are
// not yet marked clearance, for the preview on the price-check page.
// scope 'extra': only copies beyond the first N; scope 'all': every copy.
// Never new copies, reserved copies, or books whose rules say manual review
// (or, when the rule covers Rule A only, books that are neither Rule A nor mass market).
async function clearanceCandidates(pool, settings) {
  const after = settings.clearance.afterCopies;
  const { rows } = await pool.query(
    `SELECT c.id, c.book_id, c.status, c.condition, c.price, c.is_clearance, c.publisher_price,
            b.title, b.isbn, to_jsonb(b) ->> 'binding' AS binding,
            ROW_NUMBER() OVER (PARTITION BY c.book_id ORDER BY c.created_at, c.id)::int AS pos,
            COUNT(*) OVER (PARTITION BY c.book_id)::int AS total
     FROM book_copies c JOIN books b ON b.id = c.book_id
     WHERE c.status = ANY($1)`,
    [HELD]
  );
  const cache = await cachedComparables(pool, rows.filter((r) => r.total > after).map((r) => r.isbn));
  const ruleSetOf = new Map();
  const out = [];
  for (const r of rows) {
    if (r.total <= after || r.status !== "in_stock" || r.condition === "new" || r.is_clearance) continue;
    if (settings.clearance.scope === "extra" && r.pos <= after) continue;
    if (!ruleSetOf.has(r.book_id)) {
      const s = rulesSuggestionFor({ ...r, condition: "very_good" }, cache, settings);
      ruleSetOf.set(r.book_id, s ? s.ruleSet : "review");
    }
    const rs = ruleSetOf.get(r.book_id);
    if (rs === "review" || (settings.clearance.appliesTo === "set_a" && rs !== "A" && rs !== "mass_market")) continue;
    out.push({ id: r.id, bookId: r.book_id, title: r.title, price: r.price != null ? Number(r.price) : null, condition: r.condition, position: r.pos, total: r.total, ruleSet: rs });
    if (out.length >= CANDIDATE_LIMIT) break;
  }
  return out;
}

module.exports = { HELD, CANDIDATE_LIMIT, countHeldCopies, otherRepriceableCopies, cachedComparables, rulesSuggestionFor, clearanceCandidates };
