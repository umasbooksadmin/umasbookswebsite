const express = require("express");
const { sharpFromUpload } = require("../../lib/uploadImage");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { sanitizeHtml } = require("../../lib/sanitizeHtml");

const { validateIdParams } = require("../../middleware/idParams");
const { parseId } = require("../../lib/validation");

const router = express.Router();
// Garbage ids get the 404 page, not a Postgres 22P02 and a 500.
validateIdParams(router, "id");

// ---------- Blog ----------

const BLOG_CATEGORIES = ["News", "Events", "Donations", "Programs", "Community", "Books", "Education"];
const BLOG_STATUSES = ["draft", "scheduled", "published"];
const BLOG_PAGE_SIZE = 6;

async function processBlogImage(file) {
  const resized = await sharpFromUpload(file.buffer)
    .rotate()
    .resize(800, 500, { fit: "cover" })
    .jpeg({ quality: 78 })
    .toBuffer();
  return `data:image/jpeg;base64,${resized.toString("base64")}`;
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
      .slice(0, 60) || "post"
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
function resolveBlogPublishedAt(status, dateStr) {
  if (status === "draft") return null;
  return dateStr ? new Date(dateStr) : new Date();
}

function blogBackQuery(req) {
  return req.body.backQuery ? `?${req.body.backQuery}` : "";
}

router.get("/admin/blog", requireAdmin, async (req, res) => {
  const status = BLOG_STATUSES.includes(req.query.status) ? req.query.status : "";
  const category = BLOG_CATEGORIES.includes(req.query.category) ? req.query.category : "";
  const q = (req.query.q || "").trim();
  const dateRange = req.query.dateRange || "";
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

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
    params.push(`%${q}%`);
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
  if (req.query.edit) {
    const { rows } = await pool.query("SELECT * FROM blog_posts WHERE id = $1", [Number(req.query.edit)]);
    editing = rows[0] || null;
  }

  res.render("admin/blog", {
    active: "blog",
    posts,
    editing,
    categories: BLOG_CATEGORIES,
    filters: { status, category, q, dateRange },
    pagination: { page: currentPage, totalPages, totalMatching, pageSize: BLOG_PAGE_SIZE },
  });
});

router.post("/admin/blog", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const excerpt = (req.body.excerpt || "").trim() || null;
  const body = sanitizeHtml((req.body.body || "").trim());
  const category = BLOG_CATEGORIES.includes(req.body.category) ? req.body.category : null;
  const tags = (req.body.tags || "").trim() || null;
  const status = BLOG_STATUSES.includes(req.body.status) ? req.body.status : "published";
  const publishedAt = resolveBlogPublishedAt(status, req.body.publishDate);
  const backQuery = blogBackQuery(req);

  if (!title || !body) return res.redirect(`/admin/blog${backQuery}`);

  const imageFile = req.files && req.files.image && req.files.image[0];
  const imageUrl = imageFile ? await processBlogImage(imageFile) : null;
  const slug = await uniqueBlogSlug(slugifyTitle(title));

  await pool.query(
    `INSERT INTO blog_posts (slug, title, excerpt, body, category, tags, status, published_at, image_url, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [slug, title, excerpt, body, category, tags, status, publishedAt, imageUrl, req.session.user.id]
  );
  res.redirect(`/admin/blog${backQuery}`);
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
    } else if (req.body.bulkAction === "draft") {
      await pool.query("UPDATE blog_posts SET status = 'draft', updated_at = now() WHERE id = ANY($1)", [ids]);
    }
  }
  res.redirect(`/admin/blog${backQuery}`);
});

router.post("/admin/blog/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const title = (req.body.title || "").trim();
  const excerpt = (req.body.excerpt || "").trim() || null;
  const body = sanitizeHtml((req.body.body || "").trim());
  const category = BLOG_CATEGORIES.includes(req.body.category) ? req.body.category : null;
  const tags = (req.body.tags || "").trim() || null;
  const status = BLOG_STATUSES.includes(req.body.status) ? req.body.status : "published";
  const publishedAt = resolveBlogPublishedAt(status, req.body.publishDate);
  const backQuery = blogBackQuery(req);

  if (!title || !body) return res.redirect(`/admin/blog${backQuery}`);

  const imageFile = req.files && req.files.image && req.files.image[0];
  const clearImage = !imageFile && req.body.removeImage === "on";

  if (imageFile) {
    const imageUrl = await processBlogImage(imageFile);
    await pool.query(
      `UPDATE blog_posts SET title=$1, excerpt=$2, body=$3, category=$4, tags=$5, status=$6, published_at=$7, image_url=$8, updated_at=now() WHERE id=$9`,
      [title, excerpt, body, category, tags, status, publishedAt, imageUrl, id]
    );
  } else {
    await pool.query(
      `UPDATE blog_posts SET title=$1, excerpt=$2, body=$3, category=$4, tags=$5, status=$6, published_at=$7,
         image_url = CASE WHEN $8 THEN NULL ELSE image_url END, updated_at=now() WHERE id=$9`,
      [title, excerpt, body, category, tags, status, publishedAt, clearImage, id]
    );
  }
  res.redirect(`/admin/blog${backQuery}`);
});

router.post("/admin/blog/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM blog_posts WHERE id = $1", [Number(req.params.id)]);
  await audit(req, { action: "blog.delete", targetType: "blog_post", targetId: Number(req.params.id) });
  res.redirect(`/admin/blog${blogBackQuery(req)}`);
});

module.exports = router;
