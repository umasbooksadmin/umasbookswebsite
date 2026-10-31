const express = require("express");
const { saveImage } = require("../../lib/imageStore");
const { sharpFromUpload } = require("../../lib/uploadImage");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { sanitizeHtml } = require("../../lib/sanitizeHtml");
const { frenchState, hasText } = require("../../lib/blogPosts");
const { translatePost } = require("../../lib/blogTranslate");
const { aiAdminLimiter } = require("../../middleware/rateLimits");
const { clearSitemapCache } = require("../seo");

const { LIMITS, lengthProblem } = require("../../lib/adminForm");
const { redirectWithFlash, takePageFlash } = require("../../lib/postRedirect");
const { validateIdParams } = require("../../middleware/idParams");
const { parseId, clean } = require("../../lib/validation");
const { parisInstant, parisDateString } = require("../../lib/tz");
const { likeContains, parseIntParam } = require("../../lib/parseParams");
const { makeBackQuery, oneOf, text, pageNumber } = require("../../lib/backQuery");

const router = express.Router();
// Garbage ids get the 404 page, not a Postgres 22P02 and a 500.
validateIdParams(router, "id");
// A saved, published or deleted post changes /sitemap-blog.xml (cached for an hour): drop the cached copy after any change.
router.use("/admin/blog", (req, res, next) => { if (req.method === "POST") res.on("finish", clearSitemapCache); next(); });

// ---------- Blog ----------

const BLOG_CATEGORIES = ["News", "Events", "Donations", "Programs", "Community", "Books", "Education"];
const BLOG_STATUSES = ["draft", "scheduled", "published"];
const BLOG_PAGE_SIZE = 6;
// The "French" status shown in the editor and the list (lib/blogPosts.js frenchState).
const FRENCH_LABELS = {
  missing: "missing",
  draft: "draft",
  ready: "ready",
};

async function processBlogImage(file) {
  const resized = await sharpFromUpload(file.buffer)
    .rotate()
    .resize(800, 500, { fit: "cover" })
    .jpeg({ quality: 78 })
    .toBuffer();
  return saveImage(resized, "image/jpeg");
}

function slugifyTitle(title) {
  return (
    title
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "") // strip accents so "Éveil" -> "eveil"
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "post"
  );
}

async function uniqueBlogSlug(base, excludeId) {
  let slug = base;
  let n = 2;
  for (;;) {
    const { rows } = await pool.query(
      excludeId ? "SELECT id FROM blog_posts WHERE slug = $1 AND id != $2" : "SELECT id FROM blog_posts WHERE slug = $1",
      excludeId ? [slug, excludeId] : [slug]
    );
    if (!rows.length) return slug;
    slug = `${base}-${n++}`;
  }
}

// "Draft" never gets a published_at; "Scheduled"/"Published" use the
// form's Publish Date field (defaulting to today for Published if left
// blank) — the /api/blog/posts feed (src/routes/blog.js) only ever
// returns 'published' rows whose published_at has actually passed, so a
// 'scheduled' one becomes visible on its own once that date arrives.
//
// The typed date means PARIS time: "2026-10-31" is the start of that day in Paris (and an optional
// publishTime "HH:MM" that time), never UTC midnight, which is 01:00-02:00 in Paris.
function resolveBlogPublishedAt(status, dateStr, timeStr) {
  if (status === "draft") return null;
  return dateStr ? parisInstant(dateStr, timeStr || "00:00") : new Date();
}

// The list filters to return to after a save/bulk action: rebuilt from a whitelist, never appended as posted (lib/backQuery.js).
const DATE_RANGES = ["7d", "30d", "year"];
const blogBack = makeBackQuery({
  status: oneOf(BLOG_STATUSES), category: oneOf(BLOG_CATEGORIES), q: text(100), dateRange: oneOf(DATE_RANGES), page: pageNumber,
});
function blogBackQuery(req) {
  return blogBack(req.body.backQuery);
}

// What the form sent, cleaned the same way for create and edit. `error` is a
// sentence for the admin (shown above the form); `values` is what to put back
// in the form when something is wrong so nothing typed is lost.
function readBlogForm(req) {
  const title = (req.body.title || "").trim();
  const excerpt = (req.body.excerpt || "").trim() || null;
  const body = sanitizeHtml((req.body.body || "").trim());
  const category = BLOG_CATEGORIES.includes(req.body.category) ? req.body.category : null;
  const tags = (req.body.tags || "").trim() || null;
  const status = BLOG_STATUSES.includes(req.body.status) ? req.body.status : "published";
  const dateStr = typeof req.body.publishDate === "string" ? req.body.publishDate.trim() : "";
  const timeStr = typeof req.body.publishTime === "string" ? req.body.publishTime.trim() : "";
  // The French version (all three parts optional; the same sanitising as the English body). An editor holding only
  // empty paragraphs is stored as nothing.
  const titleFr = String(req.body.title_fr || "").trim() || null;
  const excerptFr = String(req.body.excerpt_fr || "").trim() || null;
  const bodyFrClean = sanitizeHtml(String(req.body.body_fr || "").trim());
  const bodyFr = hasText(bodyFrClean) ? bodyFrClean : null;
  const values = {
    title, excerpt: excerpt || "", body, category: category || "", tags: tags || "", status, publishDate: dateStr,
    title_fr: titleFr || "", excerpt_fr: excerptFr || "", body_fr: bodyFr || "",
  };

  let error = null;
  // An editor with only empty paragraphs/line breaks counts as empty.
  const bodyText = body.replace(/<[^>]*>/g, "").replace(/&nbsp;|\s/g, "");
  const tooLong = lengthProblem([
    ["The title", title, LIMITS.title], ["The summary", excerpt, LIMITS.text], ["The tags", tags, LIMITS.line], ["The content", body, LIMITS.richText],
    ["The French title", titleFr, LIMITS.title], ["The French summary", excerptFr, LIMITS.text], ["The French content", bodyFr, LIMITS.richText],
  ]);
  if (tooLong) error = tooLong;
  else if (!title) error = "Please give the post a title. Nothing was saved.";
  else if (!bodyText && status !== "draft") error = "Please write some content before publishing or scheduling the post (a draft may stay empty). Nothing was saved.";
  else if (dateStr && !parisInstant(dateStr)) {
    error = "The publish date is not a valid date (use the date picker, or year-month-day like 2026-10-31). Nothing was saved.";
  } else if (timeStr && !parisInstant(dateStr || "2000-01-01", timeStr)) {
    error = "The publish time is not a valid time (use hours:minutes like 18:30). Nothing was saved.";
  }
  const publishedAt = error ? null : resolveBlogPublishedAt(status, dateStr, dateStr ? timeStr : "");
  return { title, excerpt, body, titleFr, excerptFr, bodyFr, category, tags, status, publishedAt, values, error };
}

// The admin sees the reason, with what they typed still in the form. The
// browser is sent to the form (303) rather than shown a page of its own.
function refuseBlogForm(req, res, form, message, editId) {
  const backQuery = blogBackQuery(req);
  const path = editId ? `/admin/blog?edit=${editId}${backQuery ? `&${backQuery.slice(1)}` : ""}` : `/admin/blog${backQuery}`;
  return redirectWithFlash(req, res, path, "adminBlog", { error: message || form.error, values: form.values, editId: editId || null });
}

const IMAGE_PROBLEM =
  "The post was NOT saved because that picture could not be read. Please choose a JPG, PNG or WebP image (a photo in iPhone HEIC format must be saved as JPG first). Nothing else was changed; your text is still in the form.";

// Returns the stored image URL, or null (with the refusal already sent) when
// the picture cannot be decoded.
async function storeBlogImage(req, res, form, imageFile, editId) {
  try {
    return await processBlogImage(imageFile);
  } catch (err) {
    console.warn(`Blog image refused (${imageFile.mimetype}, ${imageFile.size} bytes): ${err.message}`);
    await refuseBlogForm(req, res, form, IMAGE_PROBLEM, editId);
    return null;
  }
}

router.get("/admin/blog", requireAdmin, async (req, res) => {
  const status = BLOG_STATUSES.includes(req.query.status) ? req.query.status : "";
  const category = BLOG_CATEGORIES.includes(req.query.category) ? req.query.category : "";
  const q = clean(req.query.q, 100);
  const dateRange = req.query.dateRange || "";
  const page = parseIntParam(req.query.page, { min: 1, max: 1000000, default: 1 });

  const where = [];
  const params = [];
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (category) {
    params.push(category);
    where.push(`category = $${params.length}`);
  }
  if (q) {
    params.push(likeContains(q));
    where.push(`(title ILIKE $${params.length} OR body ILIKE $${params.length} OR tags ILIKE $${params.length})`);
  }
  if (dateRange === "7d") where.push("created_at >= now() - interval '7 days'");
  if (dateRange === "30d") where.push("created_at >= now() - interval '30 days'");
  if (dateRange === "year") where.push("created_at >= date_trunc('year', now())");
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM blog_posts ${whereClause}`, params);
  const totalMatching = countRows[0].n;
  const totalPages = Math.max(1, Math.ceil(totalMatching / BLOG_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * BLOG_PAGE_SIZE;

  const { rows: posts } = await pool.query(
    `SELECT * FROM blog_posts ${whereClause}
     ORDER BY COALESCE(published_at, created_at) DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, BLOG_PAGE_SIZE, offset]
  );

  let editing = null;
  if (parseId(req.query.edit) !== null) {
    const { rows } = await pool.query("SELECT * FROM blog_posts WHERE id = $1", [parseId(req.query.edit)]);
    editing = rows[0] || null;
  }

  // A refused save (or a saved one) left a message and what was typed.
  const flash = takePageFlash(req, res, "adminBlog") || {};
  const keepTyped = flash.values && (flash.editId || null) === (editing ? editing.id : null);
  const today = parisDateString(new Date());
  const base = editing
    ? {
        title: editing.title, excerpt: editing.excerpt || "", body: editing.body, category: editing.category || "",
        tags: editing.tags || "", status: editing.status,
        publishDate: editing.published_at ? parisDateString(editing.published_at) : today,
        title_fr: editing.title_fr || "", excerpt_fr: editing.excerpt_fr || "", body_fr: editing.body_fr || "",
      }
    : { title: "", excerpt: "", body: "", category: "", tags: "", status: "published", publishDate: today, title_fr: "", excerpt_fr: "", body_fr: "" };
  const formValues = keepTyped ? { ...base, ...flash.values } : base;

  res.render("admin/blog", {
    active: "blog",
    posts,
    editing,
    formValues,
    flashError: flash.error || null,
    flashNotice: flash.notice || null,
    categories: BLOG_CATEGORIES,
    frenchState,
    frenchLabels: FRENCH_LABELS,
    // What the French status says for the text now in the form (what was just typed after a refused save, else what is stored).
    formFrenchState: frenchState({ title: formValues.title, excerpt: formValues.excerpt, title_fr: formValues.title_fr, excerpt_fr: formValues.excerpt_fr, body_fr: formValues.body_fr }),
    filters: { status, category, q, dateRange },
    pagination: { page: currentPage, totalPages, totalMatching, pageSize: BLOG_PAGE_SIZE },
  });
});

router.post("/admin/blog", requireAdmin, async (req, res) => {
  const form = readBlogForm(req);
  if (form.error) return refuseBlogForm(req, res, form, null, null);

  const imageFile = req.files && req.files.image && req.files.image[0];
  let imageUrl = null;
  if (imageFile) {
    imageUrl = await storeBlogImage(req, res, form, imageFile, null);
    if (!imageUrl) return;
  }
  const slug = await uniqueBlogSlug(slugifyTitle(form.title));

  await pool.query(
    `INSERT INTO blog_posts (slug, title, excerpt, body, category, tags, status, published_at, image_url, created_by, title_fr, excerpt_fr, body_fr)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [slug, form.title, form.excerpt, form.body, form.category, form.tags, form.status, form.publishedAt, imageUrl, req.session.user.id, form.titleFr, form.excerptFr, form.bodyFr]
  );
  const word = form.status === "draft" ? "saved as a draft" : form.status === "scheduled" ? "scheduled" : "published";
  return redirectWithFlash(req, res, `/admin/blog${blogBackQuery(req)}`, "adminBlog", { notice: `"${form.title}" was ${word}.` });
});

// "Translate to French": the editor's script sends what is typed in the form (nothing is saved), and gets the French
// text back to read and edit. It calls the paid AI service, so: 10 a minute per admin, plus the shared daily cap.
// Registered before /:id like "bulk".
const translateLimit = aiAdminLimiter();
router.post("/admin/blog/translate", requireAdmin, translateLimit, async (req, res) => {
  const pick = (k) => String(Array.isArray(req.body[k]) ? req.body[k][0] : req.body[k] == null ? "" : req.body[k]);
  const typed = {
    title: pick("title"), excerpt: pick("excerpt"), body: sanitizeHtml(pick("body").trim()),
    title_fr: pick("title_fr"), excerpt_fr: pick("excerpt_fr"), body_fr: pick("body_fr"),
  };
  const result = await translatePost(typed, { overwrite: pick("overwrite") === "1" });
  await audit(req, { action: "blog.translate", targetType: "blog_post", detail: result.ok ? `${result.filled.length} filled` : "failed" });
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({
    titleFr: result.title_fr, excerptFr: result.excerpt_fr, bodyFr: result.body_fr, filled: result.filled,
    notice: "French filled in below. Read it, change what you like, then press Save: nothing is saved until you do." +
      (result.partial ? " Part of it could not be translated this time: translate again, or write the rest by hand." : ""),
  });
});

// Registered before /:id: otherwise :id matches the literal "bulk" and the
// bulk actions never run.
router.post("/admin/blog/bulk", requireAdmin, async (req, res) => {
  const ids = [].concat(req.body.ids || []).map((v) => parseId(String(v))).filter((n) => n !== null);
  const backQuery = blogBackQuery(req);
  if (ids.length) {
    if (req.body.bulkAction === "delete") {
      await pool.query("DELETE FROM blog_posts WHERE id = ANY($1)", [ids]);
      await audit(req, { action: "blog.bulk_delete", targetType: "blog_post", detail: `ids ${ids.join(",")}` });
    } else if (req.body.bulkAction === "publish") {
      await pool.query(
        "UPDATE blog_posts SET status = 'published', published_at = COALESCE(published_at, now()), updated_at = now() WHERE id = ANY($1)",
        [ids]
      );
      await audit(req, { action: "blog.bulk_publish", targetType: "blog_post", detail: `ids ${ids.join(",")}` });
    } else if (req.body.bulkAction === "draft") {
      await pool.query("UPDATE blog_posts SET status = 'draft', updated_at = now() WHERE id = ANY($1)", [ids]);
      await audit(req, { action: "blog.bulk_draft", targetType: "blog_post", detail: `ids ${ids.join(",")}` });
    }
  }
  res.redirect(`/admin/blog${backQuery}`);
});

router.post("/admin/blog/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const form = readBlogForm(req);
  if (form.error) return refuseBlogForm(req, res, form, null, id);

  const imageFile = req.files && req.files.image && req.files.image[0];
  const clearImage = !imageFile && req.body.removeImage === "on";

  let result;
  if (imageFile) {
    const imageUrl = await storeBlogImage(req, res, form, imageFile, id);
    if (!imageUrl) return;
    result = await pool.query(
      `UPDATE blog_posts SET title=$1, excerpt=$2, body=$3, category=$4, tags=$5, status=$6, published_at=$7, image_url=$8,
         title_fr=$10, excerpt_fr=$11, body_fr=$12, updated_at=now() WHERE id=$9`,
      [form.title, form.excerpt, form.body, form.category, form.tags, form.status, form.publishedAt, imageUrl, id, form.titleFr, form.excerptFr, form.bodyFr]
    );
  } else {
    result = await pool.query(
      `UPDATE blog_posts SET title=$1, excerpt=$2, body=$3, category=$4, tags=$5, status=$6, published_at=$7,
         image_url = CASE WHEN $8 THEN NULL ELSE image_url END, title_fr=$10, excerpt_fr=$11, body_fr=$12, updated_at=now() WHERE id=$9`,
      [form.title, form.excerpt, form.body, form.category, form.tags, form.status, form.publishedAt, clearImage, id, form.titleFr, form.excerptFr, form.bodyFr]
    );
  }
  if (!result.rowCount) {
    return redirectWithFlash(req, res, `/admin/blog${blogBackQuery(req)}`, "adminBlog", { error: "That post no longer exists (it may have been deleted). Nothing was saved." });
  }
  return redirectWithFlash(req, res, `/admin/blog${blogBackQuery(req)}`, "adminBlog", { notice: `"${form.title}" was saved.` });
});

router.post("/admin/blog/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM blog_posts WHERE id = $1", [Number(req.params.id)]);
  await audit(req, { action: "blog.delete", targetType: "blog_post", targetId: Number(req.params.id) });
  res.redirect(`/admin/blog${blogBackQuery(req)}`);
});

module.exports = router;
