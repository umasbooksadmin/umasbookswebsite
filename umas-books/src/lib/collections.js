// Curated collections (migrations/091_curated_collections.sql): what customers may see, and the publish rules.
//
// THE REVIEW STEP IS MANDATORY. The AI helper only ever writes rows with status 'suggested' (lib/collectionSuggestions.js).
// Customers see a collection only when published = true, and in it only the books whose status is 'approved' AND that are
// in stock at the moment the page is drawn (read live from book_copies, never copied: a sold or reserved book silently
// leaves the page). Nothing here publishes anything by itself: publishing is an admin's button (publishCollection).

const { localCover } = require("./coverStore");

// A copy that can be bought now. 'reserved' and 'sold' copies do not count.
const IN_STOCK_SQL = (bookId = "b.id") => `EXISTS (SELECT 1 FROM book_copies c WHERE c.book_id = ${bookId} AND c.status = 'in_stock')`;

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const isSlug = (s) => typeof s === "string" && s.length <= 100 && SLUG_RE.test(s);

// The approved, in-stock books of a collection, in the admin's order, shaped like the cards of the Browse page.
async function approvedInStockBooks(pool, collectionId) {
  const { rows } = await pool.query(
    `SELECT b.id, b.title, b.authors, b.cover_url,
            (SELECT MIN(price) FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock') AS min_price
     FROM curated_collection_books cb
     JOIN books b ON b.id = cb.book_id
     WHERE cb.collection_id = $1 AND cb.status = 'approved' AND ${IN_STOCK_SQL()}
     ORDER BY cb.position, b.title_sort, b.id`,
    [collectionId]
  );
  return rows.map((r) => ({ ...r, cover_url: localCover(r.cover_url), min_price: r.min_price != null ? Number(r.min_price) : null }));
}

// A published collection by its address, or null (unknown slug and unpublished look the same: a 404).
async function getPublishedCollection(pool, slug) {
  if (!isSlug(slug)) return null;
  const { rows } = await pool.query(
    "SELECT id, slug, title_en, description_en, title_fr, description_fr, icon_path FROM curated_collections WHERE slug = $1 AND published = TRUE",
    [slug]
  );
  return rows[0] || null;
}

// The collections that get a button on the Browse page: published AND with at least one approved book in stock.
async function listButtonCollections(pool) {
  const { rows } = await pool.query(
    `SELECT cc.id, cc.slug, cc.title_en, cc.title_fr, cc.icon_path
     FROM curated_collections cc
     WHERE cc.published = TRUE
       AND EXISTS (SELECT 1 FROM curated_collection_books cb JOIN books b ON b.id = cb.book_id
                   WHERE cb.collection_id = cc.id AND cb.status = 'approved' AND ${IN_STOCK_SQL()})
     ORDER BY cc.sort_order, cc.id`
  );
  return rows;
}

// Sitemap: the published collections that still have a book to show.
const listSitemapCollections = listButtonCollections;

// Title / description in the visitor's language. French falls back to English only if the French is empty
// (publishing is refused while it is, so this is a safety net, not a way of working).
function localized(collection, lang) {
  const fr = lang === "fr";
  return {
    title: (fr && collection.title_fr) || collection.title_en,
    description: (fr && collection.description_fr) || collection.description_en,
  };
}

// The publish rules. -> { ok: true } | { ok: false, error } (the error is for the admin screens, English).
//   - at least one approved book (the review step must have happened);
//   - the French title and description filled in (the whole site is French when French is chosen).
async function publishProblems(pool, collectionId) {
  const { rows } = await pool.query(
    `SELECT cc.title_en, cc.title_fr, cc.description_fr,
            (SELECT COUNT(*)::int FROM curated_collection_books cb WHERE cb.collection_id = cc.id AND cb.status = 'approved') AS approved
     FROM curated_collections cc WHERE cc.id = $1`,
    [collectionId]
  );
  const c = rows[0];
  if (!c) return { ok: false, error: "That collection does not exist.", notFound: true };
  if (c.approved < 1) return { ok: false, error: "A collection cannot be published until at least one book is approved. Generate suggestions, then tick Approve on the books you want and save." };
  if (!String(c.title_fr || "").trim() || !String(c.description_fr || "").trim()) {
    return { ok: false, error: "The French title and the French description must both be filled in before this collection can be published (the site is fully French when French is chosen)." };
  }
  return { ok: true };
}

// Publish / unpublish. Unpublishing is always allowed.
async function setPublished(pool, collectionId, published) {
  if (published) {
    const check = await publishProblems(pool, collectionId);
    if (!check.ok) return check;
  }
  const { rowCount } = await pool.query("UPDATE curated_collections SET published = $2, updated_at = now() WHERE id = $1", [collectionId, Boolean(published)]);
  return rowCount ? { ok: true } : { ok: false, error: "That collection does not exist.", notFound: true };
}

// Applies the admin's ticks. rows: [{ bookId, approve, reject }] for every book shown on the screen.
// Both ticked is refused (nothing saved); neither ticked puts the book back to 'suggested'.
// Only books that belong to this collection are touched. -> { ok, changed } | { ok: false, error }
async function saveDecisions(pool, collectionId, rows) {
  const decisions = [];
  for (const r of rows) {
    if (r.approve && r.reject) return { ok: false, error: "A book cannot be both approved and rejected: tick one box only. Nothing was saved." };
    decisions.push([r.bookId, r.approve ? "approved" : r.reject ? "rejected" : "suggested"]);
  }
  let changed = 0;
  for (const [bookId, status] of decisions) {
    const { rowCount } = await pool.query(
      "UPDATE curated_collection_books SET status = $3, updated_at = now() WHERE collection_id = $1 AND book_id = $2 AND status <> $3",
      [collectionId, bookId, status]
    );
    changed += rowCount;
  }
  // A collection that lost its last approved book cannot stay published: it would show an empty page.
  const { rows: still } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM curated_collection_books WHERE collection_id = $1 AND status = 'approved'", [collectionId]
  );
  let unpublished = false;
  if (still[0].n === 0) {
    const r = await pool.query("UPDATE curated_collections SET published = FALSE, updated_at = now() WHERE id = $1 AND published", [collectionId]);
    unpublished = r.rowCount > 0;
  }
  return { ok: true, changed, unpublished };
}

module.exports = {
  IN_STOCK_SQL, isSlug, approvedInStockBooks, getPublishedCollection, listButtonCollections, listSitemapCollections,
  localized, publishProblems, setPublished, saveDecisions,
};
