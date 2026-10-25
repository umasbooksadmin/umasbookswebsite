const express = require("express");
const { pool } = require("../db");
const { requireMember } = require("../middleware/auth");
const { refuseMembersOnly } = require("../lib/membersOnly");
const { localizeAll } = require("../lib/frenchText");

const router = express.Router();

// Only actually-live announcements. 'scheduled' is included as long as
// its published_at has actually passed — there's no periodic job
// flipping it to 'published' at that moment, so the date check alone is
// what makes it visible (see /admin/announcements, where the Scheduled
// tab may still show it briefly after that, purely as a cosmetic lag
// until an admin touches it). Not past its optional expiration; pinned
// ones lead regardless of date.
const LIVE_ANNOUNCEMENTS_WHERE = `
  status IN ('published', 'scheduled') AND published_at <= now() AND (expires_at IS NULL OR expires_at > now())
`;

// Not the shared requireMember middleware: a guest clicking
// "Member's Access" (which always links here — see the h-tools icon in
// partials/header.ejs and every static marketing page) is more likely
// looking to become a member than to log in to an account they don't
// have yet, so they land on the membership sign-up page instead of
// /login. A logged-in account that isn't a member/volunteer/admin gets the
// same "this area is for members" page as requireMember everywhere else.
function requireMemberOrOfferSignup(req, res, next) {
  if (!req.session.user) return res.redirect("/membership.html");
  const u = req.session.user;
  if (!u.isAdmin && !u.isMember && !u.isVolunteer) return refuseMembersOnly(req, res);
  next();
}

router.get("/dashboard", requireMemberOrOfferSignup, async (req, res) => {
  const [announcements, activeRound] = await Promise.all([
    pool.query(`SELECT * FROM announcements WHERE ${LIVE_ANNOUNCEMENTS_WHERE} ORDER BY is_pinned DESC, published_at DESC LIMIT 3`),
    pool.query("SELECT * FROM charity_rounds WHERE is_active = TRUE ORDER BY opens_at DESC LIMIT 1"),
  ]);

  let charity = null;
  if (activeRound.rows.length) {
    const round = activeRound.rows[0];
    // COALESCEs from the charity library the same way /admin/charity and
    // /charity do — a library-linked option's name/description can change
    // after the round was set up, and this always reflects that.
    const options = await pool.query(
      `SELECT o.id, COALESCE(c.name, o.name) AS name, COALESCE(c.description, o.description) AS description,
              (SELECT COUNT(*) FROM charity_votes v WHERE v.option_id = o.id)::int AS vote_count
       FROM charity_options o LEFT JOIN charities c ON c.id = o.charity_id
       WHERE o.round_id = $1 ORDER BY o.id ASC`,
      [round.id]
    );
    charity = { round, options: options.rows };
  }

  res.render("dashboard", { announcements: localizeAll("announcement", announcements.rows, req.lang), charity });
});

router.get("/announcements", requireMember, async (req, res) => {
  const { rows: announcements } = await pool.query(
    `SELECT * FROM announcements WHERE ${LIVE_ANNOUNCEMENTS_WHERE} ORDER BY is_pinned DESC, published_at DESC LIMIT 50`
  );
  res.render("announcements", { announcements: localizeAll("announcement", announcements, req.lang) });
});

module.exports = router;
