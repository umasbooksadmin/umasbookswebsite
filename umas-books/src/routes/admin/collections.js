// Curated collections: the admin side (English only). See lib/collections.js for the rules that matter:
//   - the AI only SUGGESTS (status 'suggested'); an admin approves or rejects each book and saves;
//   - nothing is shown to customers until an admin presses Publish, and a collection with no approved book
//     (or no French title / description) cannot be published;
//   - Generate again keeps every earlier decision and only adds new suggestions.
const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { aiAdminLimiter, AI_LIMIT_MESSAGE } = require("../../middleware/rateLimits");
const { audit } = require("../../lib/audit");
const { setFlash, takeFlash } = require("../../lib/flash");
const { validateIdParams } = require("../../middleware/idParams");
const { setPublished, saveDecisions, IN_STOCK_SQL } = require("../../lib/collections");
const { generateSuggestions, updateAllCollections } = require("../../lib/collectionSuggestions");
const { translateEmptyFrench } = require("../../lib/collectionTranslate");
const { clearSitemapCache } = require("../seo");

const router = express.Router();
validateIdParams(router, "id");
// Publishing, unpublishing or approving changes what sitemap.xml lists: drop its one-hour cache after any change here.
router.use("/admin/collections", (req, res, next) => { if (req.method === "POST") res.on("finish", clearSitemapCache); next(); });

const FLASH = "collections";
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 1000;
const MAX_PROMPT = 3000;

// A form refusal or a result goes through the session (Post/Redirect/Get), shown once on the next page.
const flash = (req, data) => setFlash(req, FLASH, data);

const redirectBack = (res, id, to) => res.redirect(303, to === "list" ? "/admin/collections" : `/admin/collections/${id}`);

async function loadCollection(id) {
  const { rows } = await pool.query("SELECT * FROM curated_collections WHERE id = $1", [id]);
  return rows[0] || null;
}

router.get("/admin/collections", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT cc.id, cc.slug, cc.title_en, cc.sort_order, cc.published, cc.last_generated_at,
            COUNT(*) FILTER (WHERE cb.status = 'suggested')::int AS suggested,
            COUNT(*) FILTER (WHERE cb.status = 'approved')::int AS approved,
            COUNT(*) FILTER (WHERE cb.status = 'approved' AND ${IN_STOCK_SQL("cb.book_id")})::int AS approved_in_stock,
            (SELECT COUNT(*)::int FROM books b
             WHERE ${IN_STOCK_SQL()}
               AND NOT EXISTS (SELECT 1 FROM curated_collection_books x WHERE x.collection_id = cc.id AND x.book_id = b.id)
               AND (cc.last_generated_at IS NULL OR EXISTS (SELECT 1 FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock' AND c.created_at > cc.last_generated_at))) AS new_books
     FROM curated_collections cc
     LEFT JOIN curated_collection_books cb ON cb.collection_id = cc.id
     GROUP BY cc.id
     ORDER BY cc.sort_order, cc.id`
  );
  res.render("admin/collections", { active: "collections", collections: rows, flash: takeFlash(req, FLASH) });
});

// "Generate suggestions" and "Translate to French" call the paid AI: 10 a minute per admin (like the other AI buttons),
// plus the shared daily cap inside the call. A refusal is shown on the same page, not as raw JSON.
const aiLimit = aiAdminLimiter({
  handler: async (req, res) => {
    await flash(req, { error: AI_LIMIT_MESSAGE });
    res.redirect(303, `/admin/collections/${Number(req.params.id) || 0}`);
  },
});

// The flash for one build result (Add new books / Full rebuild).
function resultFlash(result, what) {
  if (!result.ok) return { error: result.error };
  if (result.nothingNew) return { notice: `${what}: Nothing new. No book in stock is waiting to be looked at for this collection.` };
  return {
    notice: `${what}: ${result.added} new suggestion${result.added === 1 ? "" : "s"} added from ${result.considered} book${result.considered === 1 ? "" : "s"} looked at. Nothing is shown to customers until you approve books${result.added ? " (they are waiting for your review below)" : ""}.` +
      (result.partial ? " Part of the list could not be checked this time: run it again later for the rest." : ""),
  };
}

// "Update all collections" (a fixed path: registered before the /:id routes) and the "Full rebuild" confirm step.
// Both call the paid AI: 10 a minute per admin, plus the shared daily cap inside each call.
const aiLimitList = aiAdminLimiter({
  handler: async (req, res) => {
    await flash(req, { error: AI_LIMIT_MESSAGE });
    res.redirect(303, "/admin/collections");
  },
});

const summaryLine = (r) => {
  switch (r.status) {
    case "added": return `${r.title}: ${r.added} new suggestion${r.added === 1 ? "" : "s"} to review (${r.considered} new book${r.considered === 1 ? "" : "s"} looked at)`;
    case "nothing": return `${r.title}: Nothing new`;
    case "never": return `${r.title}: never built yet, use its own Generate suggestions button`;
    case "later": return `${r.title}: not reached this time (press Update all collections again)`;
    default: return `${r.title}: FAILED, ${r.error}`;
  }
};

router.post("/admin/collections/update-all", requireAdmin, aiLimitList, async (req, res) => {
  const results = await updateAllCollections(pool);
  const added = results.reduce((n, r) => n + (r.added || 0), 0);
  const failed = results.filter((r) => r.status === "failed").length;
  await audit(req, { action: "collection.update_all", detail: `${added} suggestions added, ${failed} failed` });
  const lines = results.filter((r) => r.status !== "never").map(summaryLine);
  await flash(req, {
    [failed ? "error" : "notice"]: `Update all collections: ${added} new suggestion${added === 1 ? "" : "s"} waiting for your review${failed ? `, ${failed} collection${failed === 1 ? "" : "s"} could not be updated` : ""}. Nothing is shown to customers until you approve books.`,
    lines,
  });
  res.redirect(303, "/admin/collections");
});

router.get("/admin/collections/:id/rebuild", requireAdmin, async (req, res) => {
  const collection = await loadCollection(Number(req.params.id));
  if (!collection) return res.status(404).render("404");
  res.render("admin/collection_rebuild", { active: "collections", collection });
});

router.post("/admin/collections/:id/rebuild", requireAdmin, aiLimit, async (req, res) => {
  const id = Number(req.params.id);
  if (!(await loadCollection(id))) return res.status(404).render("404");
  if (req.body.confirm !== "yes") {
    await flash(req, { error: "Full rebuild was not confirmed, so nothing was done." });
    return redirectBack(res, id);
  }
  const result = await generateSuggestions(pool, id, { mode: "full" });
  await audit(req, { action: "collection.full_rebuild", targetType: "collection", targetId: id, detail: result.ok ? `${result.added} added` : `failed: ${result.reason}` });
  await flash(req, resultFlash(result, "Full rebuild"));
  redirectBack(res, id);
});

router.get("/admin/collections/:id", requireAdmin, async (req, res) => {
  const collection = await loadCollection(Number(req.params.id));
  if (!collection) return res.status(404).render("404");
  const { rows: books } = await pool.query(
    `SELECT b.id, b.title, b.authors, b.categories, cb.status, cb.reason, ${IN_STOCK_SQL()} AS in_stock
     FROM curated_collection_books cb JOIN books b ON b.id = cb.book_id
     WHERE cb.collection_id = $1
     ORDER BY CASE cb.status WHEN 'suggested' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, cb.position, b.id`,
    [collection.id]
  );
  const f = takeFlash(req, FLASH);
  // After "Translate to French" the typed values come back unsaved, for the admin to read first.
  const form = f && f.form ? { ...collection, ...f.form } : collection;
  const counts = { suggested: 0, approved: 0, rejected: 0 };
  for (const b of books) counts[b.status] += 1;
  const { rows: nb } = await pool.query(
    "SELECT COUNT(DISTINCT book_id)::int AS n FROM book_copies WHERE status = 'in_stock' AND $1::timestamptz IS NOT NULL AND created_at > $1",
    [collection.last_generated_at]
  );
  res.render("admin/collection_edit", { active: "collections", collection, form, books, counts, flash: f, newBooks: nb[0].n });
});

router.post("/admin/collections/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const collection = await loadCollection(id);
  if (!collection) return res.status(404).render("404");
  const str = (v, max) => String(Array.isArray(v) ? v[0] : v == null ? "" : v).replace(/\r\n/g, "\n").trim().slice(0, max);
  const values = {
    title_en: str(req.body.title_en, MAX_TITLE),
    description_en: str(req.body.description_en, MAX_DESCRIPTION),
    title_fr: str(req.body.title_fr, MAX_TITLE),
    description_fr: str(req.body.description_fr, MAX_DESCRIPTION),
    curation_prompt: str(req.body.curation_prompt, MAX_PROMPT),
    sort_order: String(req.body.sort_order == null ? "" : req.body.sort_order).trim(),
  };
  const sort = Number(values.sort_order);
  let error = null;
  if (!values.title_en) error = "The English title cannot be empty.";
  else if (values.sort_order === "" || !Number.isInteger(sort) || sort < -1000 || sort > 100000) error = "Sort order must be a whole number (smaller numbers come first).";
  if (error) {
    await flash(req, { error, form: values });
    return redirectBack(res, id);
  }
  await pool.query(
    `UPDATE curated_collections
     SET title_en = $2, description_en = $3, title_fr = $4, description_fr = $5, curation_prompt = $6, sort_order = $7, updated_at = now()
     WHERE id = $1`,
    [id, values.title_en, values.description_en, values.title_fr, values.description_fr, values.curation_prompt, sort]
  );
  // A published collection must keep its French text: emptying it takes the collection off the site, not off the rules.
  let note = "Saved.";
  if (collection.published && (!values.title_fr || !values.description_fr)) {
    await pool.query("UPDATE curated_collections SET published = FALSE WHERE id = $1", [id]);
    note = "Saved. The French title or description is empty, so the collection was unpublished. Fill them in and publish again.";
  }
  await audit(req, { action: "collection.edit", targetType: "collection", targetId: id });
  await flash(req, { notice: note });
  redirectBack(res, id);
});

router.post("/admin/collections/:id/published", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const publish = req.body.published === "1";
  const result = await setPublished(pool, id, publish);
  if (result.notFound) return res.status(404).render("404");
  if (!result.ok) {
    await flash(req, { error: result.error });
  } else {
    await audit(req, { action: publish ? "collection.publish" : "collection.unpublish", targetType: "collection", targetId: id });
    await flash(req, { notice: publish ? "Published: customers can now see this collection (only its approved books that are in stock)." : "Unpublished: customers no longer see this collection." });
  }
  redirectBack(res, id, req.body.back);
});

router.post("/admin/collections/:id/review", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!(await loadCollection(id))) return res.status(404).render("404");
  const list = (v) => [].concat(v == null ? [] : v).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const approve = new Set(list(req.body.approve));
  const reject = new Set(list(req.body.reject));
  const rows = list(req.body.ids).map((bookId) => ({ bookId, approve: approve.has(bookId), reject: reject.has(bookId) }));
  const result = await saveDecisions(pool, id, rows);
  if (!result.ok) {
    await flash(req, { error: result.error });
  } else {
    await audit(req, { action: "collection.review", targetType: "collection", targetId: id, detail: `${approve.size} approved, ${reject.size} rejected` });
    await flash(req, {
      notice: `Saved your choices (${result.changed} changed).` +
        (result.unpublished ? " This collection has no approved book left, so it was unpublished." : ""),
    });
  }
  redirectBack(res, id);
});

router.post("/admin/collections/:id/generate", requireAdmin, aiLimit, async (req, res) => {
  const id = Number(req.params.id);
  if (!(await loadCollection(id))) return res.status(404).render("404");
  const result = await generateSuggestions(pool, id);
  await audit(req, { action: "collection.generate", targetType: "collection", targetId: id, detail: result.ok ? `${result.added} added` : `failed: ${result.reason}` });
  await flash(req, resultFlash(result, "Add new books"));
  redirectBack(res, id);
});

router.post("/admin/collections/:id/translate", requireAdmin, aiLimit, async (req, res) => {
  const id = Number(req.params.id);
  const collection = await loadCollection(id);
  if (!collection) return res.status(404).render("404");
  const pick = (k) => String(Array.isArray(req.body[k]) ? req.body[k][0] : req.body[k] == null ? "" : req.body[k]);
  const typed = {
    title_en: pick("title_en"), description_en: pick("description_en"), title_fr: pick("title_fr"), description_fr: pick("description_fr"),
    curation_prompt: pick("curation_prompt"), sort_order: pick("sort_order"),
  };
  const result = await translateEmptyFrench(typed);
  await audit(req, { action: "collection.translate", targetType: "collection", targetId: id, detail: result.ok ? `${result.filled.length} filled` : "failed" });
  if (!result.ok) {
    await flash(req, { error: result.error, form: typed });
  } else if (!result.filled.length) {
    await flash(req, { notice: "Nothing to translate: the French title and description are already filled in (or there is no English to translate).", form: typed });
  } else {
    await flash(req, { notice: "French filled in below. Read it, change what you like, then press Save: nothing is saved until you do.", form: { ...typed, title_fr: result.title_fr, description_fr: result.description_fr } });
  }
  redirectBack(res, id);
});

module.exports = router;
