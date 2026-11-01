const express = require("express");
const { saveImage } = require("../../lib/imageStore");
const { sharpFromUpload } = require("../../lib/uploadImage");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { sanitizeHtml } = require("../../lib/sanitizeHtml");
const frenchText = require("../../lib/frenchText");
const { redirectWithFlash, takePageFlash } = require("../../lib/postRedirect");
const { LIMITS, lengthProblem } = require("../../lib/adminForm");

const { validateIdParams } = require("../../middleware/idParams");
const { parseId, clean, parseDay } = require("../../lib/validation");
const { likeContains } = require("../../lib/parseParams");
const { makeBackQuery, oneOf, text } = require("../../lib/backQuery");
const { parisInstant, parisDateString } = require("../../lib/tz");

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

// The expiration date (an <input type=date>, "YYYY-MM-DD") means "shown until the END of that day in Paris" (review
// 6B L3): stored as the instant the next Paris day starts. new Date("2026-11-05") was UTC midnight, so the announcement
// disappeared at 01:00 or 02:00 Paris on the 5th itself. -> { value: Date|null } | { error } (not a real date).
const EXPIRY_INVALID = "The expiration date must be a real date, like 2026-11-05.";
function parseExpiry(body) {
  if (body.expiresEnabled !== "on" || !String(body.expiresAt || "").trim()) return { value: null };
  const day = parseDay(String(body.expiresAt), { label: "The expiration date" });
  if (day.error || !day.value) return { error: EXPIRY_INVALID };
  const [y, m, d] = day.value.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  const value = parisInstant(next);
  return value ? { value } : { error: EXPIRY_INVALID };
}
// The day the edit form shows for a stored expiry: the last Paris day it is still shown (also right for an expiry saved
// before this change, at UTC midnight of the chosen day).
const expiryDayOf = (expiresAt) => (expiresAt ? parisDateString(new Date(new Date(expiresAt).getTime() - 1)) : "");

// The list filters to return to, rebuilt from a whitelist (lib/backQuery.js), never appended as posted.
const announcementBack = makeBackQuery({
  status: oneOf([...ANNOUNCEMENT_STATUSES, "all"]), category: oneOf(ANNOUNCEMENT_CATEGORIES), q: text(100),
  dateRange: oneOf(["7d", "30d", "year"]), pinnedOnly: oneOf(["1"]), sort: oneOf(["oldest", "newest"]),
});
function announcementBackQuery(req) {
  return announcementBack(req.body.backQuery);
}

// The first field over its limit, as a sentence (null when all fit): nothing is cut off silently.
function announcementTooLong(title, body, french) {
  return lengthProblem([
    ["The title", title, LIMITS.title], ["The content", body, LIMITS.richText],
    ["The French title", french.title_fr, LIMITS.title], ["The French content", french.body_fr, LIMITS.richText],
  ]);
}

router.get("/admin/announcements", requireAdmin, async (req, res) => {
  const flash = takePageFlash(req, res, "adminAnnouncements") || {};
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
    editing = rows[0] ? { ...rows[0], expires_day: expiryDayOf(rows[0].expires_at) } : null;
  }

  res.render("admin/announcements", {
    active: "announcements",
    fr: frenchText,
    announcements,
    counts,
    allCount,
    events,
    editing,
    flashError: flash.error || null,
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
  const expiry = parseExpiry(req.body);
  const expiresAt = expiry.value || null;
  const eventId = parseId(req.body.eventId);
  const { status, publishedAt } = resolveAnnouncementStatus(req.body.statusAction, req.body.scheduledAt);
  const backQuery = announcementBackQuery(req);

  if (!title || !body) return res.redirect(`/admin/announcements${backQuery}`);
  if (expiry.error) return redirectWithFlash(req, res, `/admin/announcements${backQuery}`, "adminAnnouncements", { error: expiry.error });

  // The optional French version (title, summary, content): "" is stored as NULL = no French for that part; the
  // content passes the same sanitising as the English one.
  const french = frenchText.readFrench("announcement", req.body);
  if (french.excerpt_fr) french.excerpt_fr = french.excerpt_fr.slice(0, 200);
  const tooLong = announcementTooLong(title, body, french);
  if (tooLong) return redirectWithFlash(req, res, `/admin/announcements${backQuery}`, "adminAnnouncements", { error: tooLong });

  const imageFile = req.files && req.files.image && req.files.image[0];
  const imageUrl = imageFile ? await processAnnouncementImage(imageFile) : null;

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
  const expiry = parseExpiry(req.body);
  const expiresAt = expiry.value || null;
  const eventId = parseId(req.body.eventId);
  const { status, publishedAt } = resolveAnnouncementStatus(req.body.statusAction, req.body.scheduledAt);
  const backQuery = announcementBackQuery(req);

  if (!title || !body) return res.redirect(`/admin/announcements${backQuery}`);
  if (expiry.error) return redirectWithFlash(req, res, `/admin/announcements${backQuery}`, "adminAnnouncements", { error: expiry.error });

  const french = frenchText.readFrench("announcement", req.body);
  if (french.excerpt_fr) french.excerpt_fr = french.excerpt_fr.slice(0, 200);
  const tooLong = announcementTooLong(title, body, french);
  if (tooLong) return redirectWithFlash(req, res, `/admin/announcements${backQuery}`, "adminAnnouncements", { error: tooLong });

  const imageFile = req.files && req.files.image && req.files.image[0];
  const newImageUrl = imageFile ? await processAnnouncementImage(imageFile) : null;
  const clearImage = !imageFile && req.body.removeImage === "on";

  await pool.query(
    // "Publish now" on an announcement that has already been out keeps its date (review 6B L3), like the Publish and
    // Restore buttons (COALESCE below): fixing a typo must not make a three-week-old announcement "today" and move it to
    // the top. A never-published draft, or one scheduled for later, is dated now.
    `UPDATE announcements SET title=$1, excerpt=$2, body=$3, category=$4, status=$5,
       published_at = CASE WHEN $5 = 'published' AND published_at IS NOT NULL AND published_at <= now() THEN published_at ELSE $6::timestamptz END,
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
