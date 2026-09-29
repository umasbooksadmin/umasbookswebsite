const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { sendResetLink } = require("../../lib/passwordReset");
const { baseUrl } = require("../../lib/baseUrl");

const router = express.Router();

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
  if (role === "member") where.push("u.is_member = TRUE");
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
    `SELECT u.id, u.email, u.display_name, u.is_admin, u.is_member, u.is_volunteer, u.is_disabled, u.member_expires_at, u.created_at, u.last_login_at,
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
    // Accounts and the new Members quick-link both land here (the same
    // list, just pre-filtered) — this distinguishes which sidebar entry
    // should highlight without needing two separate routes.
    active: role === "member" ? "members-filter" : "members",
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
  const isVolunteer = req.body.isVolunteer === "on";
  const isAdmin = req.body.isAdmin === "on";
  if (!email || !displayName) return res.redirect("/admin/members");

  const { rows: existing } = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
  if (existing.length) return res.redirect("/admin/members");

  // No password is set here — a random, never-shown value fills the
  // NOT NULL column and the account stays unusable until the invite
  // email's reset link (same flow as "Forgot password") lets them set
  // their own, exactly like a real signup would.
  const placeholderHash = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 12);
  // email_verified_at is set immediately here (unlike a real signup) —
  // an admin is already vouching for this being the right email for a
  // real person, and the invite link below needs to be clicked from that
  // same inbox anyway before the account becomes usable at all.
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, is_member, is_volunteer, email_verified_at) VALUES ($1, $2, $3, $4, $5, $6, now())
     RETURNING id, email, display_name`,
    [email, placeholderHash, displayName, isAdmin, isMember, isVolunteer]
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

router.post("/admin/members/:id/toggle-volunteer", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await pool.query("UPDATE users SET is_volunteer = NOT is_volunteer WHERE id = $1", [id]);
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

module.exports = router;
