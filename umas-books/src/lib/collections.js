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
    "SELECT id, slug, title_en, description_en, title_fr, description_fr, icon_path, banner_path, header_alt_en, header_alt_fr FROM curated_collections WHERE slug = $1 AND published = TRUE",
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

// Is a genre, a search, a topic or "See All New In" showing on Browse Books? The collection row is for the plain view only
// (the same rule as the New In shelf). `query` is req.query of /books.html.
function browseFilterActive(query = {}) {
  const one = (v) => String(Array.isArray(v) ? v[0] : v == null ? "" : v).trim();
  return Boolean(one(query.q) || one(query.genre) || one(query.topic) || one(query.new) === "1");
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
    bannerAlt: (fr ? collection.header_alt_fr : collection.header_alt_en) || "",
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

// ---------- managing collections (admin) ----------

// "Paris, toujours !" -> "paris-toujours": lower case, accents removed, anything else a single hyphen, at most 60 characters.
function slugify(text) {
  const base = String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "");
  return base || "collection";
}

async function slugTaken(pool, slug, exceptId = null) {
  const { rows } = await pool.query("SELECT 1 FROM curated_collections WHERE slug = $1 AND ($2::int IS NULL OR id <> $2)", [slug, exceptId]);
  return rows.length > 0;
}

// The first free slug starting from `base`: base, base-2, base-3 ...
async function freeSlug(pool, base) {
  let slug = base;
  for (let n = 2; await slugTaken(pool, slug); n++) slug = `${base.slice(0, 55)}-${n}`;
  return slug;
}

// -> { ok: true, id, slug } | { ok: false, error }. Starts unpublished, last in the order.
async function createCollection(pool, v) {
  const slug = v.slug ? String(v.slug).trim() : await freeSlug(pool, slugify(v.title_en));
  if (!isSlug(slug)) return { ok: false, error: "The address (slug) may only contain lower-case letters, numbers and single hyphens." };
  if (await slugTaken(pool, slug)) return { ok: false, error: `The address "${slug}" is already used by another collection. Choose a different one.` };
  const { rows: max } = await pool.query("SELECT COALESCE(MAX(sort_order), 0) AS m FROM curated_collections");
  try {
    const { rows } = await pool.query(
      `INSERT INTO curated_collections (slug, title_en, description_en, title_fr, description_fr, curation_prompt, sort_order, published)
       VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE) RETURNING id, slug`,
      [slug, v.title_en, v.description_en, v.title_fr, v.description_fr, v.curation_prompt, v.sort_order == null ? Number(max[0].m) + 10 : v.sort_order]
    );
    return { ok: true, id: rows[0].id, slug: rows[0].slug };
  } catch (err) {
    if (err.code === "23505") return { ok: false, error: `The address "${slug}" is already used by another collection. Choose a different one.` };
    throw err;
  }
}

// Deleting removes the collection and its book links (ON DELETE CASCADE) and never touches a book.
async function deleteCollection(pool, id) {
  const { rowCount } = await pool.query("DELETE FROM curated_collections WHERE id = $1", [id]);
  return rowCount > 0;
}

// Moves a collection one place up or down in the order the Browse buttons use. Every collection is renumbered 10, 20, 30 ...
async function moveCollection(pool, id, dir) {
  const { rows } = await pool.query("SELECT id FROM curated_collections ORDER BY sort_order, id");
  const ids = rows.map((r) => r.id);
  const i = ids.indexOf(id);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i === -1 || j < 0 || j >= ids.length) return false;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await pool.query("UPDATE curated_collections c SET sort_order = n.pos * 10, updated_at = now() FROM (SELECT x.id, ord AS pos FROM unnest($1::int[]) WITH ORDINALITY AS x(id, ord)) n WHERE c.id = n.id", [ids]);
  return true;
}

// A book added by hand counts as approved at once. It must exist and be in stock now.
async function addBookByHand(pool, collectionId, bookId) {
  const { rows } = await pool.query(`SELECT b.id FROM books b WHERE b.id = $1 AND ${IN_STOCK_SQL()}`, [bookId]);
  if (!rows.length) return { ok: false, error: "That book is not in stock, so it cannot be added." };
  const { rows: pos } = await pool.query("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM curated_collection_books WHERE collection_id = $1", [collectionId]);
  await pool.query(
    `INSERT INTO curated_collection_books (collection_id, book_id, status, reason, position) VALUES ($1, $2, 'approved', 'Added by hand', $3)
     ON CONFLICT (collection_id, book_id) DO UPDATE SET status = 'approved', updated_at = now()`,
    [collectionId, bookId, pos[0].p]
  );
  return { ok: true };
}

// Removes the link (the book itself is untouched). A collection left with no approved book is unpublished.
async function removeBook(pool, collectionId, bookId) {
  const { rowCount } = await pool.query("DELETE FROM curated_collection_books WHERE collection_id = $1 AND book_id = $2", [collectionId, bookId]);
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM curated_collection_books WHERE collection_id = $1 AND status = 'approved'", [collectionId]);
  let unpublished = false;
  if (rows[0].n === 0) unpublished = (await pool.query("UPDATE curated_collections SET published = FALSE, updated_at = now() WHERE id = $1 AND published", [collectionId])).rowCount > 0;
  return { removed: rowCount > 0, unpublished };
}

// In-stock books by title, author or ISBN (at least 2 characters), for the admin's "add a book" search.
async function searchInStock(pool, q, limit = 20) {
  const text = String(q || "").trim().slice(0, 100);
  if (text.length < 2) return [];
  const digits = text.replace(/[^0-9Xx]/g, "");
  const { rows } = await pool.query(
    `SELECT b.id, b.title, b.authors, b.isbn FROM books b
     WHERE ${IN_STOCK_SQL()}
       AND (b.title ILIKE $1 OR b.authors ILIKE $1 OR ($2 <> '' AND length($2) >= 8 AND regexp_replace(COALESCE(b.isbn, ''), '[^0-9Xx]', '', 'g') = $2))
     ORDER BY b.title_sort, b.id LIMIT $3`,
    [`%${text.replace(/[%_\\]/g, (m) => "\\" + m)}%`, digits, limit]
  );
  return rows;
}

module.exports = {
  slugify, slugTaken, freeSlug, createCollection, deleteCollection, moveCollection, addBookByHand, removeBook, searchInStock,
  IN_STOCK_SQL, isSlug, browseFilterActive, approvedInStockBooks, getPublishedCollection, listButtonCollections, listSitemapCollections,
  localized, publishProblems, setPublished, saveDecisions,
};
