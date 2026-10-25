const express = require("express");
const { saveImage } = require("../../lib/imageStore");
const { sharpFromUpload } = require("../../lib/uploadImage");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { sanitizeHtml } = require("../../lib/sanitizeHtml");
const frenchText = require("../../lib/frenchText");

const { validateIdParams } = require("../../middleware/idParams");
const { parseId, clean } = require("../../lib/validation");
const { likeContains } = require("../../lib/parseParams");

const router = express.Router();
// Garbage ids get the 404 page, not a Postgres 22P02 and a 500.
validateIdParams(router, "id");

// ---------- Announcements ----------

const ANNOUNCEMENT_CATEGORIES = ["Programs", "Events", "Donations", "Volunteer", "Charity", "Community", "General"];
const ANNOUNCEMENT_STATUSES = ["draft", "scheduled", "published", "archived", "trash"];

async function processAnnouncementImage(file) {
  const resized = await sharpFromUpload(file.buffer)
    .rotate()
    .resize(800, 500, { fit: "cover" })
    .jpeg({ quality: 78 })
    .toBuffer();
  return saveImage(resized, "image/jpeg");
}

// "Publish now" / "Schedule for later" / "Save as draft" in the
// announcement form all boil down to one of these three (status,
// published_at) pairs — shared by create and update so they can't drift.
function resolveAnnouncementStatus(action, scheduledAt) {
  if (action === "draft") return { status: "draft", publishedAt: null };
  if (action === "schedule" && scheduledAt) return { status: "scheduled", publishedAt: new Date(scheduledAt) };
  return { status: "published", publishedAt: new Date() };
}

function announcementBackQuery(req) {
  return req.body.backQuery ? `?${req.body.backQuery}` : "";
}

router.get("/admin/announcements", requireAdmin, async (req, res) => {
  const status = ANNOUNCEMENT_STATUSES.includes(req.query.status) ? req.query.status : "all";
  const category = ANNOUNCEMENT_CATEGORIES.includes(req.query.category) ? req.query.category : "";
  const q = clean(req.query.q, 100);
  const dateRange = req.query.dateRange || "";
  const pinnedOnly = req.query.pinnedOnly === "1";
  const sort = req.query.sort === "oldest" ? "oldest" : "newest";

  const where = [];
  const params = [];
  if (status === "all") {
    where.push("a.status != 'trash'");
  } else {
    params.push(status);
    where.push(`a.status = $${params.length}`);
  }
  if (category) {
    params.push(category);
    where.push(`a.category = $${params.length}`);
  }
  if (q) {
    params.push(likeContains(q));
    where.push(`(a.title ILIKE $${params.length} OR a.body ILIKE $${params.length} OR a.excerpt ILIKE $${params.length})`);
  }
  if (pinnedOnly) where.push("a.is_pinned = TRUE");
  if (dateRange === "7d") where.push("a.created_at >= now() - interval '7 days'");
  if (dateRange === "30d") where.push("a.created_at >= now() - interval '30 days'");
  if (dateRange === "year") where.push("a.created_at >= date_trunc('year', now())");

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { rows: announcements } = await pool.query(
    `SELECT a.*, e.title AS event_title FROM announcements a LEFT JOIN events e ON e.id = a.event_id
     ${whereClause}
     ORDER BY a.is_pinned DESC, COALESCE(a.published_at, a.created_at) ${sort === "oldest" ? "ASC" : "DESC"}
     LIMIT 200`,
    params
  );

  const { rows: countRows } = await pool.query("SELECT status, COUNT(*)::int AS n FROM announcements GROUP BY status");
  const counts = { draft: 0, scheduled: 0, published: 0, archived: 0, trash: 0 };
  for (const r of countRows) counts[r.status] = r.n;
  const allCount = counts.draft + counts.scheduled + counts.published + counts.archived;

  const { rows: events } = await pool.query(
    "SELECT id, title, starts_at FROM events WHERE starts_at >= now() ORDER BY starts_at ASC LIMIT 50"
  );

  let editing = null;
  if (parseId(req.query.edit) !== null) {
    const { rows } = await pool.query("SELECT * FROM announcements WHERE id = $1", [parseId(req.query.edit)]);
    editing = rows[0] || null;
  }

  res.render("admin/announcements", {
    active: "announcements",
    fr: frenchText,
    announcements,
    counts,
    allCount,
    events,
    editing,
    categories: ANNOUNCEMENT_CATEGORIES,
    filters: { status, category, q, dateRange, pinnedOnly, sort },
  });
});

router.post("/admin/announcements", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const excerpt = (req.body.excerpt || "").trim().slice(0, 200) || null;
  const body = sanitizeHtml((req.body.body || "").trim());
  const category = ANNOUNCEMENT_CATEGORIES.includes(req.body.category) ? req.body.category : null;
  const isPinned = req.body.pinned === "on";
  const expiresAt = req.body.expiresEnabled === "on" && req.body.expiresAt ? new Date(req.body.expiresAt) : null;
  const eventId = parseId(req.body.eventId);
  const { status, publishedAt } = resolveAnnouncementStatus(req.body.statusAction, req.body.scheduledAt);
  const backQuery = announcementBackQuery(req);

  if (!title || !body) return res.redirect(`/admin/announcements${backQuery}`);

  const imageFile = req.files && req.files.image && req.files.image[0];
  const imageUrl = imageFile ? await processAnnouncementImage(imageFile) : null;
  // The optional French version (title, summary, content): "" is stored as NULL = no French for that part; the
  // content passes the same sanitising as the English one.
  const french = frenchText.readFrench("announcement", req.body);
  if (french.excerpt_fr) french.excerpt_fr = french.excerpt_fr.slice(0, 200);

  await pool.query(
    `INSERT INTO announcements (title, excerpt, body, category, status, published_at, image_url, is_pinned, expires_at, event_id, created_by,
       title_fr, excerpt_fr, body_fr)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [title, excerpt, body, category, status, publishedAt, imageUrl, isPinned, expiresAt, eventId, req.session.user.id,
      french.title_fr, french.excerpt_fr, french.body_fr]
  );
  res.redirect(`/admin/announcements${backQuery}`);
});

// Registered before /:id: otherwise :id matches the literal "bulk" and the
// bulk actions never run.
router.post("/admin/announcements/bulk", requireAdmin, async (req, res) => {
  const ids = [].concat(req.body.ids || []).map((v) => parseId(String(v))).filter((n) => n !== null);
  const backQuery = announcementBackQuery(req);

  if (ids.length) {
    if (req.body.bulkAction === "delete") {
      await pool.query("DELETE FROM announcements WHERE id = ANY($1)", [ids]);
      await audit(req, { action: "announcement.bulk_delete", targetType: "announcement", detail: `ids ${ids.join(",")}` });
    } else {
      const map = { publish: "published", archive: "archived", trash: "trash", draft: "draft" };
      const newStatus = map[req.body.bulkAction];
      if (newStatus === "published") {
        await pool.query(
          "UPDATE announcements SET status=$1, published_at = COALESCE(published_at, now()), updated_at = now() WHERE id = ANY($2)",
          [newStatus, ids]
        );
      } else if (newStatus) {
        await pool.query("UPDATE announcements SET status=$1, updated_at = now() WHERE id = ANY($2)", [newStatus, ids]);
      }
    }
  }
  res.redirect(`/admin/announcements${backQuery}`);
});

router.post("/admin/announcements/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const title = (req.body.title || "").trim();
  const excerpt = (req.body.excerpt || "").trim().slice(0, 200) || null;
  const body = sanitizeHtml((req.body.body || "").trim());
  const category = ANNOUNCEMENT_CATEGORIES.includes(req.body.category) ? req.body.category : null;
  const isPinned = req.body.pinned === "on";
  const expiresAt = req.body.expiresEnabled === "on" && req.body.expiresAt ? new Date(req.body.expiresAt) : null;
  const eventId = parseId(req.body.eventId);
  const { status, publishedAt } = resolveAnnouncementStatus(req.body.statusAction, req.body.scheduledAt);
  const backQuery = announcementBackQuery(req);

  if (!title || !body) return res.redirect(`/admin/announcements${backQuery}`);

  const imageFile = req.files && req.files.image && req.files.image[0];
  const newImageUrl = imageFile ? await processAnnouncementImage(imageFile) : null;
  const clearImage = !imageFile && req.body.removeImage === "on";
  const french = frenchText.readFrench("announcement", req.body);
  if (french.excerpt_fr) french.excerpt_fr = french.excerpt_fr.slice(0, 200);

  await pool.query(
    `UPDATE announcements SET title=$1, excerpt=$2, body=$3, category=$4, status=$5, published_at=$6,
       image_url = CASE WHEN $7::text IS NOT NULL THEN $7 WHEN $8 THEN NULL ELSE image_url END,
       is_pinned=$9, expires_at=$10, event_id=$11, title_fr=$13, excerpt_fr=$14, body_fr=$15, updated_at=now()
     WHERE id=$12`,
    [title, excerpt, body, category, status, publishedAt, newImageUrl, clearImage, isPinned, expiresAt, eventId, id,
      french.title_fr, french.excerpt_fr, french.body_fr]
  );
  res.redirect(`/admin/announcements${backQuery}`);
});

router.post("/admin/announcements/:id/status", requireAdmin, async (req, res) => {
  const map = { archive: "archived", trash: "trash", restore: "published", publish: "published", draft: "draft" };
  const newStatus = map[req.body.action];
  const backQuery = announcementBackQuery(req);
  if (newStatus) {
    if (newStatus === "published") {
      await pool.query(
        "UPDATE announcements SET status=$1, published_at = COALESCE(published_at, now()), updated_at = now() WHERE id = $2",
        [newStatus, Number(req.params.id)]
      );
    } else {
      await pool.query("UPDATE announcements SET status=$1, updated_at = now() WHERE id = $2", [newStatus, Number(req.params.id)]);
    }
  }
  res.redirect(`/admin/announcements${backQuery}`);
});

router.post("/admin/announcements/:id/pin", requireAdmin, async (req, res) => {
  await pool.query("UPDATE announcements SET is_pinned = NOT is_pinned, updated_at = now() WHERE id = $1", [Number(req.params.id)]);
  res.redirect(`/admin/announcements${announcementBackQuery(req)}`);
});

// Permanent delete — the row-level "..." menu and the Trash tab's bulk
// action only ever call this once status is already 'trash'; moving
// something to trash in the first place goes through /status above.
router.post("/admin/announcements/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM announcements WHERE id = $1", [Number(req.params.id)]);
  await audit(req, { action: "announcement.delete", targetType: "announcement", targetId: Number(req.params.id) });
  res.redirect(`/admin/announcements${announcementBackQuery(req)}`);
});

module.exports = router;
