const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { sendResetLink } = require("../../lib/passwordReset");
const { baseUrl } = require("../../lib/baseUrl");
const { sendVerificationEmail } = require("../../lib/emailVerification");
const { syncMembershipInBackground, linkUnmatchedPayment } = require("../../lib/membership");
const { isEmail, clean, parseId } = require("../../lib/validation");
const { eraseMember } = require("../../lib/privacy");
const { buildMemberExport } = require("../../lib/memberExport");

const { validateIdParams } = require("../../middleware/idParams");

const router = express.Router();
// Garbage ids get the 404 page, not a Postgres 22P02 and a 500.
validateIdParams(router, "id");

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
  const q = clean(req.query.q, 100);
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
  if (role === "member") where.push("(u.is_member = TRUE AND (u.member_expires_at IS NULL OR u.member_expires_at > now()))");
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

  // parseId: a huge or non-numeric ?view= would otherwise reach Postgres
  // as an out-of-range int (a 500 and an alert email); treat it as "no
  // member selected".
  const viewId = parseId(req.query.view);
  const detail = viewId ? await loadMemberDetail(viewId) : null;
  const panel = ["overview", "activity", "edit"].includes(req.query.panel) ? req.query.panel : "overview";

  // Membership payments that matched no confirmed account (lib/membership.js),
  // and, when the admin is linking one, the accounts matching her email search.
  const { rows: unmatched } = await pool.query(
    `SELECT id, payer_email, amount_cents, paid_at, unmatched_reason, unmatched_at
     FROM membership_payments WHERE user_id IS NULL AND unmatched_at IS NOT NULL ORDER BY paid_at DESC LIMIT 100`
  );
  const linkPaymentId = parseId(req.query.linkPayment);
  const linkQ = String(req.query.linkQ || "").trim().slice(0, 100);
  let linkCandidates = null;
  if (linkPaymentId && linkQ) {
    ({ rows: linkCandidates } = await pool.query(
      `SELECT id, email, display_name, email_verified_at IS NOT NULL AS verified, is_member
       FROM users WHERE NOT is_disabled AND (email ILIKE $1 OR display_name ILIKE $1) ORDER BY email LIMIT 10`,
      [`%${linkQ.replace(/[\\%_]/g, "\\$&")}%`]
    ));
  }

  res.render("admin/members", {
    unmatched, linkPaymentId, linkQ, linkCandidates, linkNotice: String(req.query.linkNotice || ""),
    // Accounts and the new Members quick-link both land here (the same
    // list, just pre-filtered) — this distinguishes which sidebar entry
    // should highlight without needing two separate routes.
    active: role === "member" ? "members-filter" : "members",
    members,
    stats,
    detail,
    panel,
    emailTaken: req.query.emailTaken === "1",
    filters: { q, role, status, dateRange, sort },
    pagination: { page: currentPage, totalPages, totalMatching, pageSize: MEMBERS_PAGE_SIZE },
  });
});

router.post("/admin/members", requireAdmin, async (req, res) => {
  const email = clean(req.body.email, 200).toLowerCase();
  const displayName = clean(req.body.displayName, 100);
  const isMember = req.body.isMember === "on";
  const isVolunteer = req.body.isVolunteer === "on";
  const isAdmin = req.body.isAdmin === "on";
  if (!email || !displayName || !isEmail(email)) return res.redirect("/admin/members");

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
  // Verified from the start, so a membership payment made before this
  // account existed can be attributed now.
  syncMembershipInBackground(pool, rows[0].email);
  await audit(req, { action: "member.create", targetType: "user", targetId: rows[0].id });
  res.redirect("/admin/members");
});

// Right of access / portability: see lib/memberExport.js.
router.get("/admin/members/:id/export.json", requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(404).render("404");

  const data = await buildMemberExport(pool, id);
  if (!data) return res.status(404).render("404");
  // Reading someone's personal data is itself recorded (id only, no PII).
  await audit(req, { action: "member.export", targetType: "user", targetId: id });

  res.set("Cache-Control", "no-store");
  res.set("Content-Disposition", `attachment; filename="member-${id}-data.json"`);
  res.type("application/json").send(JSON.stringify(data, null, 2));
});

// Attach an unmatched membership payment to the chosen account and grant the
// membership, in one transaction (typo or different email on HelloAsso's form).
router.post("/admin/members/unmatched/:id/link", requireAdmin, async (req, res) => {
  const paymentId = Number(req.params.id);
  const userId = parseId(req.body.userId);
  const result = userId ? await linkUnmatchedPayment(pool, paymentId, userId) : { ok: false, reason: "no_account" };
  await audit(req, {
    action: "membership.link_payment", targetType: "membership_payment", targetId: paymentId,
    detail: result.ok ? `linked to account #${userId}` : `refused: ${result.reason}`,
  });
  res.redirect(`/admin/members?linkNotice=${result.ok ? "linked" : encodeURIComponent(result.reason)}#unmatched-payments`);
});

router.post("/admin/members/:id/toggle-member", requireAdmin, async (req, res) => {
  // Clears member_expires_at on manual toggle so a hand-granted membership
  // doesn't get silently expired by the HelloAsso-driven backstop sweep
  // (see expireStaleMemberships in lib/membership.js), and so re-granting
  // status to someone whose paid membership lapsed starts as indefinite
  // rather than reusing their old (past) expiry date.
  const id = Number(req.params.id);
  await pool.query("UPDATE users SET is_member = NOT is_member, member_expires_at = NULL WHERE id = $1", [id]);
  await audit(req, { action: "member.toggle_member", targetType: "user", targetId: id });
  res.redirect(`/admin/members?view=${id}${membersBackQuery(req)}`);
});

router.post("/admin/members/:id/toggle-volunteer", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await pool.query("UPDATE users SET is_volunteer = NOT is_volunteer WHERE id = $1", [id]);
  await audit(req, { action: "member.toggle_volunteer", targetType: "user", targetId: id });
  res.redirect(`/admin/members?view=${id}${membersBackQuery(req)}`);
});

router.post("/admin/members/:id/toggle-admin", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  // An admin can't demote themselves — that could leave the account list
  // with no one able to manage it.
  if (id === req.session.user.id) return res.redirect(`/admin/members?view=${id}${membersBackQuery(req)}`);
  await pool.query("UPDATE users SET is_admin = NOT is_admin WHERE id = $1", [id]);
  await audit(req, { action: "member.toggle_admin", targetType: "user", targetId: id });
  res.redirect(`/admin/members?view=${id}${membersBackQuery(req)}`);
});

router.post("/admin/members/:id/toggle-disabled", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.user.id) return res.redirect(`/admin/members?view=${id}${membersBackQuery(req)}`);
  await pool.query("UPDATE users SET is_disabled = NOT is_disabled WHERE id = $1", [id]);
  await audit(req, { action: "member.toggle_disabled", targetType: "user", targetId: id });
  res.redirect(`/admin/members?view=${id}${membersBackQuery(req)}`);
});

router.post("/admin/members/:id/edit", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const displayName = clean(req.body.displayName, 100);
  const email = clean(req.body.email, 200).toLowerCase();
  if (displayName && isEmail(email)) {
    const { rows: current } = await pool.query("SELECT email, email_verified_at FROM users WHERE id = $1", [id]);
    const emailChanged = current[0] && current[0].email.toLowerCase() !== email;
    // Orders are matched to an account by user_id, but orders placed before
    // checkout needed an account have none and are found by email only. Link
    // them to this account NOW (it proved the old address), so that after the
    // change they stay with it, and whoever registers the old address later
    // never sees them. Unproven (unverified) accounts link nothing.
    if (emailChanged && current[0].email_verified_at) {
      await pool.query(
        "UPDATE orders SET user_id = $1 WHERE user_id IS NULL AND lower(buyer_email) = lower($2)",
        [id, current[0].email]
      );
    }
    // A changed email is a brand-new, unproven address: verification is
    // cleared so syncMembershipForEmail (lib/membership.js) won't
    // attribute a HelloAsso payment to it until the new inbox's link is
    // clicked, and any still-unused link sent to the OLD address is
    // burned so it can't verify the new one.
    try {
      await pool.query(
        `UPDATE users SET display_name = $1, email = $2,
           email_verified_at = CASE WHEN $4 THEN NULL ELSE email_verified_at END,
           password_changed_at = CASE WHEN $4 THEN now() ELSE password_changed_at END
         WHERE id = $3`,
        [displayName, email, id, !!emailChanged]
      );
    } catch (err) {
      // users.email is UNIQUE — another account already has this address.
      if (err.code === "23505") {
        return res.redirect(`/admin/members?view=${id}&panel=edit&emailTaken=1${membersBackQuery(req)}`);
      }
      throw err;
    }
    await audit(req, { action: "member.edit", targetType: "user", targetId: id });
    if (emailChanged) {
      // password_changed_at (set above) logs out the account's existing
      // sessions via attachUser — an admin fixing a squatted/hijacked
      // account shouldn't leave the squatter logged in — and any unused
      // reset link already sent to the old address must die too.
      await pool.query("UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [id]);
      await pool.query("UPDATE email_verification_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [id]);
      try {
        await sendVerificationEmail({ id, email, display_name: displayName }, baseUrl(req));
      } catch (err) {
        console.error("Verification email after admin email change failed:", err.message);
      }
    }
  }
  res.redirect(`/admin/members?view=${id}${membersBackQuery(req)}`);
});

// Lost phone AND recovery codes: another admin clears the account's
// two-step setup. password_changed_at logs the account out everywhere;
// an admin must enrol again at their next admin visit.
router.post("/admin/members/:id/reset-2fa", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await pool.query(
    `UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL,
            password_changed_at = now() WHERE id = $1`,
    [id]
  );
  await pool.query("DELETE FROM totp_recovery_codes WHERE user_id = $1", [id]);
  await audit(req, { action: "member.reset_2fa", targetType: "user", targetId: id });
  console.log(`Two-step verification of member ${id} reset by admin ${req.session.user.id}.`);
  res.redirect(`/admin/members?view=${id}${membersBackQuery(req)}`);
});

router.post("/admin/members/:id/delete", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.user.id) return res.redirect(`/admin/members${membersBackQuery(req).replace("&", "?")}`);
  // The last admin can't be erased any more than demoted (toggle-admin).
  const { rows: target } = await pool.query("SELECT is_admin FROM users WHERE id = $1", [id]);
  if (target[0] && target[0].is_admin) {
    const { rows: admins } = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE is_admin");
    if (admins[0].n <= 1) return res.redirect(`/admin/members?view=${id}${membersBackQuery(req)}`);
  }
  // Erases the account AND everything held under its email (sign-ups,
  // reservations, order and payment contact details) — see lib/privacy.js.
  await eraseMember(pool, id);
  await audit(req, { action: "member.erase", targetType: "user", targetId: id });
  console.log(`Member ${id} erased by admin ${req.session.user.id}.`);
  res.redirect(`/admin/members${membersBackQuery(req).replace("&", "?")}`);
});

module.exports = router;
