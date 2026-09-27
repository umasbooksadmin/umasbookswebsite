const express = require("express");
const sharp = require("sharp");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { pool } = require("../db");
const { requireAdmin } = require("../middleware/auth");
const { sendResetLink } = require("../lib/passwordReset");
const { baseUrl } = require("../lib/baseUrl");
const { parseMonthParam, monthRange, monthGrid, groupByDate, monthNav, resolveCalendarRange, calendarBackQuery } = require("../lib/calendar");
const { normalizeIsbn, lookupByIsbn, searchByTitleAuthor, translateGenresToFrench } = require("../lib/bookLookup");
const { extractBookInfoFromPhoto } = require("../lib/coverVision");
const { generateBookDescription, translateDescriptionToFrench } = require("../lib/bookDescription");
const { CONDITIONS, STATUSES, normalizeCondition, normalizeStatus, normalizeGenres } = require("../lib/inventory");
const { expireStaleReservations, matchWishlistOnArrival } = require("../lib/reservations");
const { seatsTakenExpr } = require("../lib/classCapacity");
const { sanitizeHtml } = require("../lib/sanitizeHtml");
const { CHARITY_CATEGORIES } = require("../lib/charityCategories");

const router = express.Router();

// New copies default to a $0 cost / $5 price, but a book already in
// inventory should default to whatever its existing copies are set at.
async function getDefaultCopyPricing(isbn) {
  const defaults = { price: 5, acquisitionCost: 0 };
  if (!isbn) return defaults;
  const { rows } = await pool.query(
    `SELECT c.price, c.acquisition_cost FROM book_copies c
     JOIN books b ON b.id = c.book_id
     WHERE b.isbn = $1 ORDER BY c.created_at DESC LIMIT 1`,
    [isbn]
  );
  if (!rows.length) return defaults;
  return {
    price: rows[0].price != null ? Number(rows[0].price) : defaults.price,
    acquisitionCost: rows[0].acquisition_cost != null ? Number(rows[0].acquisition_cost) : defaults.acquisitionCost,
  };
}

// Best-effort cover lookup for books saved without one — tries the ISBN
// first (most precise), then falls back to a title/author search.
async function findCoverUrl({ isbn, title, author }) {
  if (isbn) {
    const byIsbn = await lookupByIsbn(isbn);
    if (byIsbn && byIsbn.coverUrl) return byIsbn.coverUrl;
  }
  if (title) {
    const candidates = await searchByTitleAuthor(title, author);
    const withCover = candidates.find((c) => c.coverUrl);
    if (withCover) return withCover.coverUrl;
  }
  return null;
}

// Render has no persistent disk, so an uploaded cover photo can't be
// saved to the filesystem — it's resized/compressed down to a small
// thumbnail and stored inline as a data URI in the same cover_url column
// a lookup-sourced image URL would go in.
async function processCoverPhoto(file) {
  const resized = await sharp(file.buffer)
    .rotate()
    .resize(500, 700, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer();
  return `data:image/jpeg;base64,${resized.toString("base64")}`;
}

// ---------- Overview ----------

// Every number on the dashboard is a real query against this app's own
// data — there's no visitor-analytics/traffic tracking anywhere in this
// app, so there's deliberately no "website traffic" stat here; showing
// one would mean making it up. "This month" vs "last month" comparisons
// use calendar-month boundaries in the server's local time.
router.get("/admin", requireAdmin, async (req, res) => {
  const [orders, sales, books, accounts, memberCount] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::int AS today,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int AS this_month,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now() - interval '1 month')
                            AND created_at < date_trunc('month', now()))::int AS last_month
      FROM orders`),
    pool.query(`
      SELECT
        COALESCE(SUM(total_amount) FILTER (WHERE created_at >= CURRENT_DATE), 0) AS today,
        COALESCE(SUM(total_amount) FILTER (WHERE created_at >= date_trunc('month', now())), 0) AS this_month,
        COALESCE(SUM(total_amount) FILTER (WHERE created_at >= date_trunc('month', now() - interval '1 month')
                            AND created_at < date_trunc('month', now())), 0) AS last_month
      FROM orders WHERE status = 'paid'`),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'in_stock')::int AS in_stock,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int AS added_this_month,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now() - interval '1 month')
                            AND created_at < date_trunc('month', now()))::int AS added_last_month
      FROM book_copies`),
    pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int AS new_this_month,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now() - interval '1 month')
                            AND created_at < date_trunc('month', now()))::int AS new_last_month
      FROM users`),
    pool.query("SELECT COUNT(*)::int AS n FROM users WHERE is_member = TRUE"),
  ]);

  res.render("admin/index", {
    active: "overview",
    stats: {
      ordersToday: orders.rows[0].today,
      ordersThisMonth: orders.rows[0].this_month,
      ordersLastMonth: orders.rows[0].last_month,
      salesToday: sales.rows[0].today,
      salesThisMonth: sales.rows[0].this_month,
      salesLastMonth: sales.rows[0].last_month,
      inStockCount: books.rows[0].in_stock,
      booksAddedThisMonth: books.rows[0].added_this_month,
      booksAddedLastMonth: books.rows[0].added_last_month,
      totalAccounts: accounts.rows[0].total,
      newAccountsThisMonth: accounts.rows[0].new_this_month,
      newAccountsLastMonth: accounts.rows[0].new_last_month,
      memberCount: memberCount.rows[0].n,
    },
  });
});

// ---------- Orders ----------

router.get("/admin/orders", requireAdmin, async (req, res) => {
  const { rows: orders } = await pool.query(`
    SELECT o.*, (
      SELECT json_agg(json_build_object('title', i.item_title, 'price', i.price) ORDER BY i.id)
      FROM order_items i WHERE i.order_id = o.id
    ) AS items
    FROM orders o ORDER BY o.created_at DESC LIMIT 200`);
  res.render("admin/orders", { active: "orders", orders });
});

// ---------- Accounts ----------

const MEMBERS_PAGE_SIZE = 10;

// Every activity/spend figure here is matched to an account by email —
// like the HelloAsso membership sync, this is the only link available
// since the shop, events and classes are all guest-checkout by email
// rather than user_id. Only books and drop-in seats are ever actually
// paid for today (event/class sign-ups are free — see event_signups/
// class_signups), so only those two get a euro total; the other two
// show a real count with no fabricated spend figure attached.
const MEMBER_ACTIVITY_JOIN = `
  LEFT JOIN (
    SELECT o.buyer_email, COUNT(i.id) AS book_count, COALESCE(SUM(i.price), 0) AS book_spend
    FROM order_items i JOIN orders o ON o.id = i.order_id
    WHERE o.status = 'paid' AND i.book_copy_id IS NOT NULL
    GROUP BY o.buyer_email
  ) bo ON lower(bo.buyer_email) = lower(u.email)
  LEFT JOIN (
    SELECT o.buyer_email, COUNT(i.id) AS dropin_count, COALESCE(SUM(i.price), 0) AS dropin_spend
    FROM order_items i JOIN orders o ON o.id = i.order_id
    WHERE o.status = 'paid' AND i.class_dropin_seat_id IS NOT NULL
    GROUP BY o.buyer_email
  ) dr ON lower(dr.buyer_email) = lower(u.email)
`;

function membersBackQuery(req) {
  return req.body.backQuery ? `&${req.body.backQuery}` : "";
}

async function loadMemberDetail(userId) {
  const { rows: userRows } = await pool.query(
    `SELECT u.*,
            (SELECT COUNT(*) FROM event_signups es WHERE lower(es.email) = lower(u.email))::int AS events_count,
            (SELECT COUNT(*) FROM class_signups cs WHERE lower(cs.email) = lower(u.email))::int AS programs_count,
            COALESCE(bo.book_count, 0)::int AS books_count,
            COALESCE(bo.book_spend, 0)::numeric AS books_spend,
            COALESCE(dr.dropin_count, 0)::int AS dropin_count,
            COALESCE(dr.dropin_spend, 0)::numeric AS dropin_spend
     FROM users u
     ${MEMBER_ACTIVITY_JOIN}
     WHERE u.id = $1`,
    [userId]
  );
  const user = userRows[0];
  if (!user) return null;

  const { rows: activity } = await pool.query(
    `(SELECT 'order' AS kind, o.created_at AS at, o.total_amount AS amount,
             (SELECT string_agg(i.item_title, ', ') FROM order_items i WHERE i.order_id = o.id) AS label
      FROM orders o WHERE o.status = 'paid' AND lower(o.buyer_email) = lower($1))
     UNION ALL
     (SELECT 'event' AS kind, es.created_at AS at, NULL AS amount, e.title AS label
      FROM event_signups es JOIN events e ON e.id = es.event_id WHERE lower(es.email) = lower($1))
     UNION ALL
     (SELECT 'program' AS kind, cs.created_at AS at, NULL AS amount, c.title AS label
      FROM class_signups cs JOIN classes c ON c.id = cs.class_id WHERE lower(cs.email) = lower($1))
     ORDER BY at DESC LIMIT 20`,
    [user.email]
  );

  return {
    user,
    totalSpent: Number(user.books_spend) + Number(user.dropin_spend),
    activity,
  };
}

router.get("/admin/members", requireAdmin, async (req, res) => {
  const q = (req.query.q || "").trim();
  const role = ["admin", "member"].includes(req.query.role) ? req.query.role : "";
  const status = ["active", "inactive"].includes(req.query.status) ? req.query.status : "";
  const dateRange = req.query.dateRange || "";
  const sort = ["name_asc", "name_desc"].includes(req.query.sort) ? req.query.sort : "newest";
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const where = [];
  const params = [];
  if (q) {
    params.push(`%${q}%`);
    where.push(`(u.display_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
  }
  if (role === "admin") where.push("u.is_admin = TRUE");
  if (role === "member") where.push("u.is_admin = FALSE");
  if (status === "active") where.push("u.is_disabled = FALSE");
  if (status === "inactive") where.push("u.is_disabled = TRUE");
  if (dateRange === "7d") where.push("u.created_at >= now() - interval '7 days'");
  if (dateRange === "30d") where.push("u.created_at >= now() - interval '30 days'");
  if (dateRange === "year") where.push("u.created_at >= date_trunc('year', now())");
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderClause = sort === "name_asc" ? "u.display_name ASC" : sort === "name_desc" ? "u.display_name DESC" : "u.created_at DESC";

  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM users u ${whereClause}`, params);
  const totalMatching = countRows[0].n;
  const totalPages = Math.max(1, Math.ceil(totalMatching / MEMBERS_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * MEMBERS_PAGE_SIZE;

  const { rows: members } = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.is_admin, u.is_member, u.is_disabled, u.member_expires_at, u.created_at, u.last_login_at,
            (SELECT COUNT(*) FROM event_signups es WHERE lower(es.email) = lower(u.email))::int AS events_count,
            (SELECT COUNT(*) FROM class_signups cs WHERE lower(cs.email) = lower(u.email))::int AS programs_count,
            COALESCE(bo.book_count, 0)::int AS books_count,
            COALESCE(bo.book_spend, 0)::numeric AS books_spend,
            COALESCE(dr.dropin_count, 0)::int AS dropin_count,
            COALESCE(dr.dropin_spend, 0)::numeric AS dropin_spend
     FROM users u
     ${MEMBER_ACTIVITY_JOIN}
     ${whereClause}
     ORDER BY ${orderClause}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, MEMBERS_PAGE_SIZE, offset]
  );
  for (const m of members) m.total_spent = Number(m.books_spend) + Number(m.dropin_spend);

  const { rows: statRows } = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM users) AS total_members,
      (SELECT COUNT(*)::int FROM users WHERE is_admin) AS total_admins,
      (SELECT COUNT(*)::int FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.status = 'paid' AND i.book_copy_id IS NOT NULL) AS book_order_count,
      (SELECT COALESCE(SUM(i.price), 0) FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.status = 'paid' AND i.book_copy_id IS NOT NULL) AS book_order_total,
      (SELECT COUNT(*)::int FROM event_signups) AS event_signup_count,
      (SELECT COUNT(*)::int FROM class_signups) AS program_signup_count,
      (SELECT COUNT(*)::int FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.status = 'paid' AND i.class_dropin_seat_id IS NOT NULL) AS dropin_count,
      (SELECT COALESCE(SUM(i.price), 0) FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.status = 'paid' AND i.class_dropin_seat_id IS NOT NULL) AS dropin_total
  `);
  const stats = statRows[0];

  const detail = req.query.view ? await loadMemberDetail(Number(req.query.view)) : null;
  const panel = ["overview", "activity", "edit"].includes(req.query.panel) ? req.query.panel : "overview";

  res.render("admin/members", {
    active: "members",
    members,
    stats,
    detail,
    panel,
    filters: { q, role, status, dateRange, sort },
    pagination: { page: currentPage, totalPages, totalMatching, pageSize: MEMBERS_PAGE_SIZE },
  });
});

router.post("/admin/members", requireAdmin, async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const displayName = (req.body.displayName || "").trim();
  const isMember = req.body.isMember === "on";
  const isAdmin = req.body.isAdmin === "on";
  if (!email || !displayName) return res.redirect("/admin/members");

  const { rows: existing } = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
  if (existing.length) return res.redirect("/admin/members");

  // No password is set here — a random, never-shown value fills the
  // NOT NULL column and the account stays unusable until the invite
  // email's reset link (same flow as "Forgot password") lets them set
  // their own, exactly like a real signup would.
  const placeholderHash = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 12);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, is_member) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, display_name`,
    [email, placeholderHash, displayName, isAdmin, isMember]
  );
  try {
    await sendResetLink(rows[0], baseUrl(req));
  } catch (err) {
    console.error("Add Member invite email failed:", err.message);
  }
  res.redirect("/admin/members");
});

router.post("/admin/members/:id/toggle-member", requireAdmin, async (req, res) => {
  // Clears member_expires_at on manual toggle so a hand-granted membership
  // doesn't get silently expired by the HelloAsso-driven backstop sweep
  // (see expireStaleMemberships in lib/membership.js), and so re-granting
  // status to someone whose paid membership lapsed starts as indefinite
  // rather than reusing their old (past) expiry date.
  const id = Number(req.params.id);
  await pool.query("UPDATE users SET is_member = NOT is_member, member_expires_at = NULL WHERE id = $1", [id]);
  res.redirect(`/admin/members?view=${id}${membersBackQuery(req)}`);
});

router.post("/admin/members/:id/toggle-admin", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  // An admin can't demote themselves — that could leave the account list
  // with no one able to manage it.
  if (id === req.session.user.id) return res.redirect(`/admin/members?view=${id}${membersBackQuery(req)}`);
  await pool.query("UPDATE users SET is_admin = NOT is_admin WHERE id = $1", [id]);
  res.redirect(`/admin/members?view=${id}${membersBackQuery(req)}`);
});

router.post("/admin/members/:id/toggle-disabled", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.user.id) return res.redirect(`/admin/members?view=${id}${membersBackQuery(req)}`);
  await pool.query("UPDATE users SET is_disabled = NOT is_disabled WHERE id = $1", [id]);
  res.redirect(`/admin/members?view=${id}${membersBackQuery(req)}`);
});

router.post("/admin/members/:id/edit", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const displayName = (req.body.displayName || "").trim();
  const email = (req.body.email || "").trim().toLowerCase();
  if (displayName && email) {
    await pool.query("UPDATE users SET display_name = $1, email = $2 WHERE id = $3", [displayName, email, id]);
  }
  res.redirect(`/admin/members?view=${id}${membersBackQuery(req)}`);
});

router.post("/admin/members/:id/delete", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.user.id) return res.redirect(`/admin/members${membersBackQuery(req).replace("&", "?")}`);
  await pool.query("DELETE FROM users WHERE id = $1", [id]);
  res.redirect(`/admin/members${membersBackQuery(req).replace("&", "?")}`);
});

// ---------- Announcements ----------

const ANNOUNCEMENT_CATEGORIES = ["Programs", "Events", "Donations", "Volunteer", "Charity", "Community", "General"];
const ANNOUNCEMENT_STATUSES = ["draft", "scheduled", "published", "archived", "trash"];

async function processAnnouncementImage(file) {
  const resized = await sharp(file.buffer)
    .rotate()
    .resize(800, 500, { fit: "cover" })
    .jpeg({ quality: 78 })
    .toBuffer();
  return `data:image/jpeg;base64,${resized.toString("base64")}`;
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
  const q = (req.query.q || "").trim();
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
    params.push(`%${q}%`);
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
  if (req.query.edit) {
    const { rows } = await pool.query("SELECT * FROM announcements WHERE id = $1", [Number(req.query.edit)]);
    editing = rows[0] || null;
  }

  res.render("admin/announcements", {
    active: "announcements",
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
  const eventId = req.body.eventId ? Number(req.body.eventId) : null;
  const { status, publishedAt } = resolveAnnouncementStatus(req.body.statusAction, req.body.scheduledAt);
  const backQuery = announcementBackQuery(req);

  if (!title || !body) return res.redirect(`/admin/announcements${backQuery}`);

  const imageFile = req.files && req.files.image && req.files.image[0];
  const imageUrl = imageFile ? await processAnnouncementImage(imageFile) : null;

  await pool.query(
    `INSERT INTO announcements (title, excerpt, body, category, status, published_at, image_url, is_pinned, expires_at, event_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [title, excerpt, body, category, status, publishedAt, imageUrl, isPinned, expiresAt, eventId, req.session.user.id]
  );
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
  const eventId = req.body.eventId ? Number(req.body.eventId) : null;
  const { status, publishedAt } = resolveAnnouncementStatus(req.body.statusAction, req.body.scheduledAt);
  const backQuery = announcementBackQuery(req);

  if (!title || !body) return res.redirect(`/admin/announcements${backQuery}`);

  const imageFile = req.files && req.files.image && req.files.image[0];
  const newImageUrl = imageFile ? await processAnnouncementImage(imageFile) : null;
  const clearImage = !imageFile && req.body.removeImage === "on";

  await pool.query(
    `UPDATE announcements SET title=$1, excerpt=$2, body=$3, category=$4, status=$5, published_at=$6,
       image_url = CASE WHEN $7::text IS NOT NULL THEN $7 WHEN $8 THEN NULL ELSE image_url END,
       is_pinned=$9, expires_at=$10, event_id=$11, updated_at=now()
     WHERE id=$12`,
    [title, excerpt, body, category, status, publishedAt, newImageUrl, clearImage, isPinned, expiresAt, eventId, id]
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
  res.redirect(`/admin/announcements${announcementBackQuery(req)}`);
});

router.post("/admin/announcements/bulk", requireAdmin, async (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter((n) => Number.isInteger(n));
  const backQuery = announcementBackQuery(req);

  if (ids.length) {
    if (req.body.bulkAction === "delete") {
      await pool.query("DELETE FROM announcements WHERE id = ANY($1)", [ids]);
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

// ---------- Blog ----------

router.get("/admin/blog", requireAdmin, async (req, res) => {
  const { rows: posts } = await pool.query("SELECT * FROM blog_posts ORDER BY published_at DESC LIMIT 50");
  res.render("admin/blog", { active: "blog", posts });
});

router.post("/admin/blog", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const body = (req.body.body || "").trim();
  if (title && body) {
    await pool.query(
      "INSERT INTO blog_posts (title, body, created_by) VALUES ($1, $2, $3)",
      [title, body, req.session.user.id]
    );
  }
  res.redirect("/admin/blog");
});

router.post("/admin/blog/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM blog_posts WHERE id = $1", [Number(req.params.id)]);
  res.redirect("/admin/blog");
});

// ---------- Volunteer shifts ----------

router.get("/admin/volunteer-shifts", requireAdmin, async (req, res) => {
  const range = resolveCalendarRange(req.query, 0);
  const { rows: shifts } = await pool.query(
    `SELECT s.*, (SELECT COUNT(*) FROM volunteer_signups g WHERE g.shift_id = s.id) AS signup_count
     FROM volunteer_shifts s WHERE s.starts_at >= $1 AND s.starts_at < $2 ORDER BY s.starts_at ASC`,
    [range.start, range.end]
  );
  const weeks = range.buildWeeks(groupByDate(shifts, "starts_at"));
  res.render("admin/volunteer", { active: "volunteer", weeks, view: range.view, ...range.nav });
});

router.post("/admin/volunteer-shifts", requireAdmin, async (req, res) => {
  const role = (req.body.role || "").trim();
  const date = req.body.date;
  const startTime = req.body.startTime;
  const endTime = req.body.endTime;
  const notes = (req.body.notes || "").trim() || null;
  const repeatWeeks = Math.max(1, Math.min(52, Number(req.body.repeatWeeks) || 1));

  if (role && date && startTime && endTime) {
    const start = new Date(`${date}T${startTime}`);
    const end = new Date(`${date}T${endTime}`);
    const weekMs = 7 * 24 * 60 * 60 * 1000;

    for (let i = 0; i < repeatWeeks; i++) {
      const s = new Date(start.getTime() + i * weekMs);
      const e = new Date(end.getTime() + i * weekMs);
      await pool.query(
        `INSERT INTO volunteer_shifts (role, starts_at, ends_at, capacity, notes, created_by)
         VALUES ($1, $2, $3, 1, $4, $5)`,
        [role, s.toISOString(), e.toISOString(), notes, req.session.user.id]
      );
    }
  }
  const backQuery = calendarBackQuery(req.body);
  res.redirect(backQuery ? `/admin/volunteer-shifts?${backQuery}` : "/admin/volunteer-shifts");
});

router.post("/admin/volunteer-shifts/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM volunteer_shifts WHERE id = $1", [Number(req.params.id)]);
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/volunteer-shifts?${backQuery}` : "/admin/volunteer-shifts");
});

// ---------- Meetings ----------

router.get("/admin/meetings", requireAdmin, async (req, res) => {
  const range = resolveCalendarRange(req.query, 0);
  const { rows: meetings } = await pool.query(
    `SELECT m.*, (SELECT COUNT(*) FROM meeting_rsvps r WHERE r.meeting_id = m.id) AS rsvp_count
     FROM meetings m WHERE m.scheduled_at >= $1 AND m.scheduled_at < $2 ORDER BY m.scheduled_at ASC`,
    [range.start, range.end]
  );
  const weeks = range.buildWeeks(groupByDate(meetings, "scheduled_at"));
  res.render("admin/meetings", { active: "meetings", weeks, view: range.view, ...range.nav });
});

router.post("/admin/meetings", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const date = req.body.date;
  const time = req.body.time;
  const location = (req.body.location || "").trim() || null;
  const agenda = (req.body.agenda || "").trim() || null;

  if (title && date && time) {
    const scheduledAt = `${date}T${time}`;
    await pool.query(
      `INSERT INTO meetings (title, scheduled_at, location, agenda, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [title, scheduledAt, location, agenda, req.session.user.id]
    );
  }
  const backQuery = calendarBackQuery(req.body);
  res.redirect(backQuery ? `/admin/meetings?${backQuery}` : "/admin/meetings");
});

router.post("/admin/meetings/:id/minutes", requireAdmin, async (req, res) => {
  const minutes = (req.body.minutes || "").trim() || null;
  await pool.query("UPDATE meetings SET minutes = $1 WHERE id = $2", [minutes, Number(req.params.id)]);
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/meetings?${backQuery}` : "/admin/meetings");
});

router.post("/admin/meetings/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM meetings WHERE id = $1", [Number(req.params.id)]);
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/meetings?${backQuery}` : "/admin/meetings");
});

// ---------- Events (public sign-up) ----------

router.get("/admin/events", requireAdmin, async (req, res) => {
  const range = resolveCalendarRange(req.query, 0);
  const { rows: events } = await pool.query(
    `SELECT e.*, (SELECT COUNT(*) FROM event_signups s WHERE s.event_id = e.id) AS signup_count
     FROM events e WHERE e.starts_at >= $1 AND e.starts_at < $2 ORDER BY e.starts_at ASC`,
    [range.start, range.end]
  );
  const eventIds = events.map((e) => e.id);
  const { rows: signupRows } = eventIds.length
    ? await pool.query("SELECT * FROM event_signups WHERE event_id = ANY($1) ORDER BY created_at ASC", [eventIds])
    : { rows: [] };
  const signupsByEvent = {};
  for (const s of signupRows) {
    if (!signupsByEvent[s.event_id]) signupsByEvent[s.event_id] = [];
    signupsByEvent[s.event_id].push(s);
  }

  const weeks = range.buildWeeks(groupByDate(events, "starts_at"));
  res.render("admin/events", { active: "events", weeks, signupsByEvent, view: range.view, ...range.nav });
});

router.post("/admin/events", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim() || null;
  const location = (req.body.location || "").trim() || null;
  const date = req.body.date;
  const startTime = req.body.startTime;
  const endTime = req.body.endTime || null;
  const capacity = req.body.capacity ? Number(req.body.capacity) : null;
  const price = req.body.price ? Number(req.body.price) : null;

  if (title && date && startTime) {
    const startsAt = `${date}T${startTime}`;
    const endsAt = endTime ? `${date}T${endTime}` : null;
    await pool.query(
      `INSERT INTO events (title, description, location, starts_at, ends_at, capacity, price, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [title, description, location, startsAt, endsAt, capacity, price, req.session.user.id]
    );
  }
  const backQuery = calendarBackQuery(req.body);
  res.redirect(backQuery ? `/admin/events?${backQuery}` : "/admin/events");
});

router.post("/admin/events/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim() || null;
  const location = (req.body.location || "").trim() || null;
  const startsAt = req.body.startsAt;
  const endsAt = req.body.endsAt || null;
  const capacity = req.body.capacity ? Number(req.body.capacity) : null;
  const price = req.body.price ? Number(req.body.price) : null;

  if (title && startsAt) {
    await pool.query(
      `UPDATE events SET title=$1, description=$2, location=$3, starts_at=$4, ends_at=$5, capacity=$6, price=$7
       WHERE id = $8`,
      [title, description, location, startsAt, endsAt, capacity, price, id]
    );
  }
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/events?${backQuery}` : "/admin/events");
});

router.post("/admin/events/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM events WHERE id = $1", [Number(req.params.id)]);
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/events?${backQuery}` : "/admin/events");
});

router.post("/admin/events/:id/signups/:signupId/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM event_signups WHERE id = $1 AND event_id = $2", [Number(req.params.signupId), Number(req.params.id)]);
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/events?${backQuery}` : "/admin/events");
});

// ---------- Sessions (public sign-up) ----------

const PROGRAM_TYPES = ["Little Explorers", "Éveil English", "Young Adventurers", "Young Readers", "Teen Literature", "English Café"];

router.get("/admin/sessions", requireAdmin, async (req, res) => {
  const range = resolveCalendarRange(req.query, 0);
  const { rows: classes } = await pool.query(
    `SELECT c.*, ${seatsTakenExpr("c")}::int AS seats_taken
     FROM classes c WHERE c.starts_at >= $1 AND c.starts_at < $2 ORDER BY c.starts_at ASC`,
    [range.start, range.end]
  );
  const classIds = classes.map((c) => c.id);
  const { rows: signupRows } = classIds.length
    ? await pool.query("SELECT * FROM class_signups WHERE class_id = ANY($1) ORDER BY created_at ASC", [classIds])
    : { rows: [] };
  const signupsByClass = {};
  for (const s of signupRows) {
    if (!signupsByClass[s.class_id]) signupsByClass[s.class_id] = [];
    signupsByClass[s.class_id].push(s);
  }

  const { rows: dropinRows } = classIds.length
    ? await pool.query(
        `SELECT d.id, d.class_id, o.buyer_name, o.buyer_email, d.created_at
         FROM class_dropin_seats d JOIN orders o ON o.id = d.order_id
         WHERE d.class_id = ANY($1) AND d.status = 'sold' ORDER BY d.created_at ASC`,
        [classIds]
      )
    : { rows: [] };
  const dropinByClass = {};
  for (const d of dropinRows) {
    if (!dropinByClass[d.class_id]) dropinByClass[d.class_id] = [];
    dropinByClass[d.class_id].push(d);
  }

  const weeks = range.buildWeeks(groupByDate(classes, "starts_at"));
  res.render("admin/sessions", { active: "sessions", weeks, signupsByClass, dropinByClass, programTypes: PROGRAM_TYPES, view: range.view, ...range.nav });
});

router.post("/admin/sessions", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim() || null;
  const location = (req.body.location || "").trim() || null;
  const date = req.body.date;
  const startTime = req.body.startTime;
  const endTime = req.body.endTime || null;
  const capacity = req.body.capacity ? Number(req.body.capacity) : 5;
  const dropinPrice = req.body.dropinPrice ? Number(req.body.dropinPrice) : null;
  const programType = PROGRAM_TYPES.includes(req.body.programType) ? req.body.programType : null;

  if (title && date && startTime) {
    const startsAt = `${date}T${startTime}`;
    const endsAt = endTime ? `${date}T${endTime}` : null;
    await pool.query(
      `INSERT INTO classes (title, description, location, starts_at, ends_at, capacity, dropin_price, program_type, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [title, description, location, startsAt, endsAt, capacity, dropinPrice, programType, req.session.user.id]
    );
  }
  const backQuery = calendarBackQuery(req.body);
  res.redirect(backQuery ? `/admin/sessions?${backQuery}` : "/admin/sessions");
});

router.post("/admin/sessions/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim() || null;
  const location = (req.body.location || "").trim() || null;
  const startsAt = req.body.startsAt;
  const endsAt = req.body.endsAt || null;
  const capacity = req.body.capacity ? Number(req.body.capacity) : null;
  const dropinPrice = req.body.dropinPrice ? Number(req.body.dropinPrice) : null;
  const programType = PROGRAM_TYPES.includes(req.body.programType) ? req.body.programType : null;

  if (title && startsAt) {
    await pool.query(
      `UPDATE classes SET title=$1, description=$2, location=$3, starts_at=$4, ends_at=$5, capacity=$6, dropin_price=$7, program_type=$8
       WHERE id = $9`,
      [title, description, location, startsAt, endsAt, capacity, dropinPrice, programType, id]
    );
  }
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/sessions?${backQuery}` : "/admin/sessions");
});

router.post("/admin/sessions/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM classes WHERE id = $1", [Number(req.params.id)]);
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/sessions?${backQuery}` : "/admin/sessions");
});

router.post("/admin/sessions/:id/signups/:signupId/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM class_signups WHERE id = $1 AND class_id = $2", [Number(req.params.signupId), Number(req.params.id)]);
  const backQuery = calendarBackQuery(req.query);
  res.redirect(backQuery ? `/admin/sessions?${backQuery}` : "/admin/sessions");
});

// ---------- Charity vote ----------

async function processCharityImage(file) {
  const resized = await sharp(file.buffer)
    .rotate()
    .resize(600, 400, { fit: "cover" })
    .jpeg({ quality: 78 })
    .toBuffer();
  return `data:image/jpeg;base64,${resized.toString("base64")}`;
}

// Every round-options query joins back to the library this way — a
// library-linked option (charity_id set) always shows the charity's
// current name/description/etc, never a stale copy; a pre-redesign
// free-text option (charity_id NULL) falls back to its own columns.
const CHARITY_OPTION_SELECT = `
  SELECT o.id, o.round_id, o.charity_id,
         COALESCE(c.name, o.name) AS name,
         COALESCE(c.description, o.description) AS description,
         c.category, c.image_url, c.website_url,
         (SELECT COUNT(*) FROM charity_votes v WHERE v.option_id = o.id)::int AS vote_count
  FROM charity_options o LEFT JOIN charities c ON c.id = o.charity_id
`;

router.get("/admin/charity", requireAdmin, async (req, res) => {
  const tab = ["current", "library", "ideas", "past"].includes(req.query.tab) ? req.query.tab : "current";
  const ideasSubTab = ["pending", "approved", "rejected"].includes(req.query.ideasTab) ? req.query.ideasTab : "pending";
  const q = (req.query.q || "").trim();

  const { rows: activeRounds } = await pool.query("SELECT * FROM charity_rounds WHERE is_active = TRUE ORDER BY opens_at DESC LIMIT 1");
  const activeRound = activeRounds[0] || null;

  let currentOptions = [];
  if (activeRound) {
    const { rows } = await pool.query(`${CHARITY_OPTION_SELECT} WHERE o.round_id = $1 ORDER BY o.id ASC`, [activeRound.id]);
    currentOptions = rows;
  }
  const totalCurrentVotes = currentOptions.reduce((sum, o) => sum + o.vote_count, 0);

  const libParams = [];
  let libWhere = "WHERE is_archived = FALSE";
  if (q) {
    libParams.push(`%${q}%`);
    libWhere += ` AND (name ILIKE $${libParams.length} OR category ILIKE $${libParams.length})`;
  }
  const { rows: libraryCharities } = await pool.query(`SELECT * FROM charities ${libWhere} ORDER BY name ASC`, libParams);
  const includedCharityIds = new Set(currentOptions.filter((o) => o.charity_id).map((o) => o.charity_id));
  const availableCharities = libraryCharities.filter((c) => !includedCharityIds.has(c.id));

  const { rows: allIdeas } = await pool.query(
    "SELECT i.*, u.display_name AS submitted_by_name FROM charity_ideas i LEFT JOIN users u ON u.id = i.submitted_by ORDER BY i.created_at DESC"
  );
  const ideaCounts = { pending: 0, approved: 0, rejected: 0 };
  for (const idea of allIdeas) ideaCounts[idea.status]++;
  const ideas = allIdeas.filter((i) => i.status === ideasSubTab);

  const { rows: pastRounds } = await pool.query("SELECT * FROM charity_rounds WHERE is_active = FALSE ORDER BY opens_at DESC LIMIT 20");
  const pastRoundsWithResults = [];
  for (const r of pastRounds) {
    const { rows: opts } = await pool.query(
      `${CHARITY_OPTION_SELECT} WHERE o.round_id = $1 ORDER BY vote_count DESC`,
      [r.id]
    );
    pastRoundsWithResults.push({ round: r, options: opts, total: opts.reduce((sum, o) => sum + o.vote_count, 0) });
  }

  res.render("admin/charity", {
    active: "charity",
    tab,
    ideasSubTab,
    q,
    activeRound,
    currentOptions,
    totalCurrentVotes,
    libraryCharities,
    availableCharities,
    categories: CHARITY_CATEGORIES,
    ideas,
    ideaCounts,
    pastRoundsWithResults,
  });
});

router.post("/admin/charity-rounds", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const label = (req.body.label || "").trim() || null;
  const opensAt = req.body.opensAt || null;
  const closesAt = req.body.closesAt || null;
  const allowMultiple = req.body.allowMultiple === "on";
  const visibleTo = req.body.visibleTo === "everyone" ? "everyone" : "members";
  const showResultsDuringVote = req.body.showResultsDuringVote === "on";

  if (title) {
    await pool.query("UPDATE charity_rounds SET is_active = FALSE WHERE is_active = TRUE");
    await pool.query(
      `INSERT INTO charity_rounds (title, label, opens_at, closes_at, allow_multiple, visible_to, show_results_during_vote, is_active)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4, $5, $6, $7, TRUE)`,
      [title, label, opensAt, closesAt, allowMultiple, visibleTo, showResultsDuringVote]
    );
  }
  res.redirect("/admin/charity?tab=current");
});

router.post("/admin/charity-rounds/:id/settings", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const title = (req.body.title || "").trim();
  const label = (req.body.label || "").trim() || null;
  const opensAt = req.body.opensAt || null;
  const closesAt = req.body.closesAt || null;
  const allowMultiple = req.body.allowMultiple === "on";
  const visibleTo = req.body.visibleTo === "everyone" ? "everyone" : "members";
  const showResultsDuringVote = req.body.showResultsDuringVote === "on";

  if (title) {
    await pool.query(
      `UPDATE charity_rounds SET title=$1, label=$2, opens_at = COALESCE($3::timestamptz, opens_at), closes_at=$4,
         allow_multiple=$5, visible_to=$6, show_results_during_vote=$7 WHERE id=$8`,
      [title, label, opensAt, closesAt, allowMultiple, visibleTo, showResultsDuringVote, id]
    );
  }
  res.redirect("/admin/charity?tab=current");
});

router.post("/admin/charity-rounds/:id/close", requireAdmin, async (req, res) => {
  await pool.query(
    "UPDATE charity_rounds SET is_active = FALSE, closes_at = COALESCE(closes_at, now()) WHERE id = $1",
    [Number(req.params.id)]
  );
  res.redirect("/admin/charity?tab=past");
});

router.post("/admin/charities", requireAdmin, async (req, res) => {
  const name = (req.body.name || "").trim();
  const description = (req.body.description || "").trim() || null;
  const category = CHARITY_CATEGORIES.includes(req.body.category) ? req.body.category : null;
  const websiteUrl = (req.body.websiteUrl || "").trim() || null;
  const addToCurrentVote = req.body.addToCurrentVote === "on";
  const returnTab = req.body.returnTab === "current" ? "current" : "library";

  if (!name) return res.redirect(`/admin/charity?tab=${returnTab}`);

  const imageFile = req.files && req.files.image && req.files.image[0];
  const imageUrl = imageFile ? await processCharityImage(imageFile) : null;

  const { rows } = await pool.query(
    `INSERT INTO charities (name, description, category, website_url, image_url, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [name, description, category, websiteUrl, imageUrl, req.session.user.id]
  );

  if (addToCurrentVote) {
    const { rows: activeRounds } = await pool.query("SELECT id FROM charity_rounds WHERE is_active = TRUE LIMIT 1");
    if (activeRounds.length) {
      await pool.query(
        "INSERT INTO charity_options (round_id, charity_id, name) VALUES ($1, $2, $3) ON CONFLICT (round_id, charity_id) DO NOTHING",
        [activeRounds[0].id, rows[0].id, name]
      );
    }
  }
  res.redirect(`/admin/charity?tab=${returnTab}`);
});

router.post("/admin/charities/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const name = (req.body.name || "").trim();
  const description = (req.body.description || "").trim() || null;
  const category = CHARITY_CATEGORIES.includes(req.body.category) ? req.body.category : null;
  const websiteUrl = (req.body.websiteUrl || "").trim() || null;
  const returnTab = req.body.returnTab === "current" ? "current" : "library";

  if (!name) return res.redirect(`/admin/charity?tab=${returnTab}`);

  const imageFile = req.files && req.files.image && req.files.image[0];
  if (imageFile) {
    const imageUrl = await processCharityImage(imageFile);
    await pool.query(
      "UPDATE charities SET name=$1, description=$2, category=$3, website_url=$4, image_url=$5 WHERE id=$6",
      [name, description, category, websiteUrl, imageUrl, id]
    );
  } else {
    await pool.query(
      "UPDATE charities SET name=$1, description=$2, category=$3, website_url=$4 WHERE id=$5",
      [name, description, category, websiteUrl, id]
    );
  }
  res.redirect(`/admin/charity?tab=${returnTab}`);
});

router.post("/admin/charities/:id/archive", requireAdmin, async (req, res) => {
  await pool.query("UPDATE charities SET is_archived = NOT is_archived WHERE id = $1", [Number(req.params.id)]);
  res.redirect(`/admin/charity?tab=${req.body.returnTab === "current" ? "current" : "library"}`);
});

router.post("/admin/charity-options", requireAdmin, async (req, res) => {
  const charityId = Number(req.body.charityId);
  if (charityId) {
    const { rows: activeRounds } = await pool.query("SELECT id FROM charity_rounds WHERE is_active = TRUE LIMIT 1");
    const { rows: charityRows } = await pool.query("SELECT name FROM charities WHERE id = $1", [charityId]);
    if (activeRounds.length && charityRows.length) {
      await pool.query(
        "INSERT INTO charity_options (round_id, charity_id, name) VALUES ($1, $2, $3) ON CONFLICT (round_id, charity_id) DO NOTHING",
        [activeRounds[0].id, charityId, charityRows[0].name]
      );
    }
  }
  res.redirect("/admin/charity?tab=current");
});

router.post("/admin/charity-options/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM charity_options WHERE id = $1", [Number(req.params.id)]);
  res.redirect("/admin/charity?tab=current");
});

router.post("/admin/charity-ideas/:id/approve", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query("SELECT * FROM charity_ideas WHERE id = $1", [id]);
  const idea = rows[0];
  if (idea && idea.status === "pending") {
    const { rows: charityRows } = await pool.query(
      "INSERT INTO charities (name, description, category, website_url, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [idea.name, idea.description, idea.category, idea.website_url, req.session.user.id]
    );
    await pool.query("UPDATE charity_ideas SET status = 'approved', resulting_charity_id = $1 WHERE id = $2", [charityRows[0].id, id]);
  }
  res.redirect("/admin/charity?tab=ideas&ideasTab=pending");
});

router.post("/admin/charity-ideas/:id/reject", requireAdmin, async (req, res) => {
  await pool.query("UPDATE charity_ideas SET status = 'rejected' WHERE id = $1 AND status = 'pending'", [Number(req.params.id)]);
  res.redirect("/admin/charity?tab=ideas&ideasTab=pending");
});

router.post("/admin/charity-ideas/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM charity_ideas WHERE id = $1", [Number(req.params.id)]);
  res.redirect(`/admin/charity?tab=ideas&ideasTab=${["pending", "approved", "rejected"].includes(req.body.ideasTab) ? req.body.ideasTab : "pending"}`);
});

// ---------- Inventory ----------

router.get("/admin/inventory", requireAdmin, async (req, res) => {
  await expireStaleReservations(pool);
  const q = (req.query.q || "").trim();
  const params = [];
  let where = "";
  if (q) {
    params.push(`%${q}%`);
    where = "WHERE b.title ILIKE $1 OR b.authors ILIKE $1 OR b.isbn ILIKE $1";
  }
  const { rows: books } = await pool.query(
    `SELECT b.*, COUNT(c.id)::int AS copy_count,
            COUNT(c.id) FILTER (WHERE c.status = 'in_stock')::int AS in_stock_count
     FROM books b LEFT JOIN book_copies c ON c.book_id = b.id
     ${where}
     GROUP BY b.id ORDER BY b.title ASC LIMIT 200`,
    params
  );
  res.render("admin/inventory/index", { active: "inventory", books, q });
});

router.get("/admin/inventory/scan", requireAdmin, (req, res) => {
  res.render("admin/inventory/scan", {
    active: "inventory",
    error: null,
    saved: req.query.saved === "1",
    visionEnabled: !!process.env.ANTHROPIC_API_KEY,
  });
});

router.post("/admin/inventory/lookup", requireAdmin, async (req, res) => {
  const visionEnabled = !!process.env.ANTHROPIC_API_KEY;
  let book = null;
  let error = null;

  const scanPhoto = req.files && req.files.photo && req.files.photo[0];
  if (scanPhoto) {
    const info = await extractBookInfoFromPhoto(scanPhoto.buffer, scanPhoto.mimetype);
    if (!info || (!info.isbn && !info.title)) {
      return res.render("admin/inventory/scan", {
        active: "inventory", visionEnabled,
        error: "Couldn't read anything useful from that photo — try a clearer shot, or enter details manually below.",
      });
    }
    if (info.isbn) {
      book = await lookupByIsbn(info.isbn);
    }
    if (!book && info.title) {
      const candidates = await searchByTitleAuthor(info.title, info.author);
      book = candidates[0] || null;
    }
    if (!book) {
      book = { isbn: info.isbn ? normalizeIsbn(info.isbn) : null, title: info.title, author: info.author, publisher: null, publishedYear: null, description: null, coverUrl: null, genre: null, genreFr: null, descriptionFr: null };
      error = "Found some details from the photo, but no catalog match — check everything below before saving.";
    }
  } else {
    const isbn = (req.body.isbn || "").trim();
    if (!isbn) {
      return res.render("admin/inventory/scan", { active: "inventory", visionEnabled, error: "Enter an ISBN or choose a photo." });
    }
    book = await lookupByIsbn(isbn);
    if (!book) {
      book = { isbn: normalizeIsbn(isbn), title: null, author: null, publisher: null, publishedYear: null, description: null, coverUrl: null, genre: null, genreFr: null, descriptionFr: null };
      error = "No catalog match for that ISBN — enter the details manually below.";
    }
  }

  const defaultPricing = await getDefaultCopyPricing(book.isbn);
  res.render("admin/inventory/new", { active: "inventory", book, error, fromScan: true, conditions: CONDITIONS, statuses: STATUSES, defaultPricing });
});

router.get("/admin/inventory/new", requireAdmin, (req, res) => {
  res.render("admin/inventory/new", {
    active: "inventory",
    book: { isbn: null, title: null, author: null, publisher: null, publishedYear: null, description: null, coverUrl: null, genre: null, genreFr: null, descriptionFr: null },
    error: null,
    fromScan: false,
    conditions: CONDITIONS,
    statuses: STATUSES,
    defaultPricing: { price: 5, acquisitionCost: 0 },
  });
});

router.post("/admin/inventory/generate-description", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const author = (req.body.author || "").trim() || null;
  const publisher = (req.body.publisher || "").trim() || null;
  const publishedYear = req.body.publishedYear ? Number(req.body.publishedYear) : null;

  if (!title) return res.status(400).json({ error: "Enter a title first." });

  const description = await generateBookDescription({ title, author, publisher, publishedYear });
  if (!description) return res.status(502).json({ error: "Couldn't generate a description — try again, or write one manually." });
  const descriptionFr = await translateDescriptionToFrench(description);
  res.json({ description, descriptionFr });
});

router.post("/admin/inventory", requireAdmin, async (req, res) => {
  const title = (req.body.title || "").trim();
  const author = (req.body.author || "").trim() || null;
  const isbn = req.body.isbn ? normalizeIsbn(req.body.isbn) : null;
  const publisher = (req.body.publisher || "").trim() || null;
  const publishedYear = req.body.publishedYear ? Number(req.body.publishedYear) : null;
  const genre = normalizeGenres(req.body.genre);
  let genreFr = (req.body.genreFr || "").trim() || (genre ? translateGenresToFrench(genre) : null);
  let description = (req.body.description || "").trim() || null;
  let descriptionFr = (req.body.descriptionFr || "").trim() || null;
  let coverUrl = (req.body.coverUrl || "").trim() || null;

  if (!title) {
    return res.render("admin/inventory/new", {
      active: "inventory",
      book: { isbn, title: null, author, publisher, publishedYear, description, descriptionFr, coverUrl, genre, genreFr },
      error: "Title is required.",
      fromScan: req.body.fromScan === "1",
      conditions: CONDITIONS,
      statuses: STATUSES,
      defaultPricing: {
        price: req.body.price ? Number(req.body.price) : 5,
        acquisitionCost: req.body.acquisitionCost ? Number(req.body.acquisitionCost) : 0,
      },
    });
  }

  const coverPhoto = req.files && req.files.coverPhoto && req.files.coverPhoto[0];
  if (coverPhoto) coverUrl = await processCoverPhoto(coverPhoto);

  // A second physical copy of a book already in inventory (same ISBN)
  // should add a copy to that existing record, not create a duplicate
  // book entry — otherwise scanning a title you already stock splits
  // into a separate single-copy book instead of accumulating on one.
  let bookId = null;
  if (isbn) {
    const { rows: existingRows } = await pool.query("SELECT * FROM books WHERE isbn = $1", [isbn]);
    if (existingRows.length) {
      const existing = existingRows[0];
      bookId = existing.id;
      if (!existing.description || !existing.cover_url || !existing.description_fr) {
        const [genDescription, genCoverUrl] = await Promise.all([
          existing.description ? null : (description || generateBookDescription({ title, author, publisher, publishedYear })),
          existing.cover_url ? null : (coverUrl || findCoverUrl({ isbn, title, author })),
        ]);
        const finalDescription = existing.description || genDescription;
        const genDescriptionFr = existing.description_fr
          ? null
          : (descriptionFr || (finalDescription ? await translateDescriptionToFrench(finalDescription) : null));
        if (genDescription || genCoverUrl || genDescriptionFr) {
          await pool.query(
            `UPDATE books SET description = COALESCE($1, description), cover_url = COALESCE($2, cover_url),
                    description_fr = COALESCE($3, description_fr), updated_at = now() WHERE id = $4`,
            [genDescription, genCoverUrl, genDescriptionFr, bookId]
          );
        }
      }
    }
  }

  if (!bookId) {
    [description, coverUrl] = await Promise.all([
      description || generateBookDescription({ title, author, publisher, publishedYear }),
      coverUrl || findCoverUrl({ isbn, title, author }),
    ]);
    descriptionFr = descriptionFr || (description ? await translateDescriptionToFrench(description) : null);

    const { rows } = await pool.query(
      `INSERT INTO books (isbn, title, authors, publisher, published_year, description, description_fr, cover_url, categories, categories_fr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [isbn || null, title, author, publisher, publishedYear, description, descriptionFr, coverUrl, genre, genreFr, req.session.user.id]
    );
    bookId = rows[0].id;
  }

  const condition = normalizeCondition(req.body.condition);
  const status = normalizeStatus(req.body.status);
  const price = req.body.price ? Number(req.body.price) : null;
  const acquisitionCost = req.body.acquisitionCost ? Number(req.body.acquisitionCost) : null;
  const acquiredAt = req.body.acquiredAt || null;
  const notes = (req.body.copyNotes || "").trim() || null;

  const { rows: copyRows } = await pool.query(
    `INSERT INTO book_copies (book_id, condition, price, acquisition_cost, acquired_at, status, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [bookId, condition, price, acquisitionCost, acquiredAt, status, notes, req.session.user.id]
  );

  // A copy arriving as in_stock might be exactly what someone's on the
  // wishlist for — claim it for them instead of leaving it up for grabs.
  if (status === "in_stock") {
    await matchWishlistOnArrival(pool, { bookId, copyId: copyRows[0].id, title });
  }

  if (req.body.fromScan === "1") return res.redirect("/admin/inventory/scan?saved=1");
  res.redirect(`/admin/inventory/${bookId}`);
});

router.get("/admin/inventory/:id", requireAdmin, async (req, res) => {
  await expireStaleReservations(pool);
  const id = Number(req.params.id);
  const { rows: bookRows } = await pool.query("SELECT * FROM books WHERE id = $1", [id]);
  const book = bookRows[0];
  if (!book) return res.status(404).render("404");
  const { rows: copies } = await pool.query(
    "SELECT * FROM book_copies WHERE book_id = $1 ORDER BY created_at DESC", [id]
  );
  res.render("admin/inventory/show", { active: "inventory", book, copies, conditions: CONDITIONS, statuses: STATUSES });
});

router.post("/admin/inventory/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const title = (req.body.title || "").trim();
  const author = (req.body.author || "").trim() || null;
  const isbn = req.body.isbn ? normalizeIsbn(req.body.isbn) : null;
  const publisher = (req.body.publisher || "").trim() || null;
  const publishedYear = req.body.publishedYear ? Number(req.body.publishedYear) : null;
  const genre = normalizeGenres(req.body.genre);
  let genreFr = (req.body.genreFr || "").trim() || (genre ? translateGenresToFrench(genre) : null);
  let description = (req.body.description || "").trim() || null;
  let descriptionFr = (req.body.descriptionFr || "").trim() || null;
  let coverUrl = (req.body.coverUrl || "").trim() || null;

  if (title) {
    const coverPhoto = req.files && req.files.coverPhoto && req.files.coverPhoto[0];
    if (coverPhoto) coverUrl = await processCoverPhoto(coverPhoto);

    [description, coverUrl] = await Promise.all([
      description || generateBookDescription({ title, author, publisher, publishedYear }),
      coverUrl || findCoverUrl({ isbn, title, author }),
    ]);
    descriptionFr = descriptionFr || (description ? await translateDescriptionToFrench(description) : null);
    await pool.query(
      `UPDATE books SET isbn=$1, title=$2, authors=$3, publisher=$4, published_year=$5,
              description=$6, description_fr=$7, cover_url=$8, categories=$9, categories_fr=$10, updated_at=now()
       WHERE id = $11`,
      [isbn || null, title, author, publisher, publishedYear, description, descriptionFr, coverUrl, genre, genreFr, id]
    );
  }
  res.redirect(`/admin/inventory/${id}`);
});

router.post("/admin/inventory/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM books WHERE id = $1", [Number(req.params.id)]);
  res.redirect("/admin/inventory");
});

router.post("/admin/inventory/:id/copies/:copyId", requireAdmin, async (req, res) => {
  const bookId = Number(req.params.id);
  const copyId = Number(req.params.copyId);
  const condition = normalizeCondition(req.body.condition);
  const status = normalizeStatus(req.body.status);
  const price = req.body.price ? Number(req.body.price) : null;
  const acquisitionCost = req.body.acquisitionCost ? Number(req.body.acquisitionCost) : null;
  const acquiredAt = req.body.acquiredAt || null;
  const notes = (req.body.notes || "").trim() || null;
  await pool.query(
    `UPDATE book_copies SET condition=$1, status=$2, price=$3, acquisition_cost=$4, acquired_at=$5, notes=$6, updated_at=now()
     WHERE id = $7 AND book_id = $8`,
    [condition, status, price, acquisitionCost, acquiredAt, notes, copyId, bookId]
  );
  res.redirect(`/admin/inventory/${bookId}`);
});

router.post("/admin/inventory/:id/copies/:copyId/cancel-reservation", requireAdmin, async (req, res) => {
  await pool.query(
    `UPDATE book_copies SET status='in_stock', reserved_by_name=NULL, reserved_by_email=NULL,
            reserved_by_phone=NULL, reserved_at=NULL, updated_at=now()
     WHERE id = $1 AND book_id = $2`,
    [Number(req.params.copyId), Number(req.params.id)]
  );
  res.redirect(`/admin/inventory/${req.params.id}`);
});

router.post("/admin/inventory/:id/copies/:copyId/delete", requireAdmin, async (req, res) => {
  const bookId = Number(req.params.id);
  await pool.query("DELETE FROM book_copies WHERE id = $1 AND book_id = $2", [Number(req.params.copyId), bookId]);
  const { rows } = await pool.query("SELECT 1 FROM book_copies WHERE book_id = $1", [bookId]);
  if (!rows.length) {
    await pool.query("DELETE FROM books WHERE id = $1", [bookId]);
    return res.redirect("/admin/inventory");
  }
  res.redirect(`/admin/inventory/${bookId}`);
});

// ---------- Wishlist ----------

router.get("/admin/wishlist", requireAdmin, async (req, res) => {
  const { rows: requests } = await pool.query(
    "SELECT * FROM wishlist_requests ORDER BY status ASC, created_at DESC"
  );
  res.render("admin/wishlist", { active: "wishlist", requests });
});

router.post("/admin/wishlist/:id/fulfill", requireAdmin, async (req, res) => {
  await pool.query(
    "UPDATE wishlist_requests SET status = 'fulfilled', updated_at = now() WHERE id = $1",
    [Number(req.params.id)]
  );
  res.redirect("/admin/wishlist");
});

router.post("/admin/wishlist/:id/reopen", requireAdmin, async (req, res) => {
  await pool.query(
    "UPDATE wishlist_requests SET status = 'open', updated_at = now() WHERE id = $1",
    [Number(req.params.id)]
  );
  res.redirect("/admin/wishlist");
});

router.post("/admin/wishlist/:id/delete", requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM wishlist_requests WHERE id = $1", [Number(req.params.id)]);
  res.redirect("/admin/wishlist");
});

module.exports = router;
