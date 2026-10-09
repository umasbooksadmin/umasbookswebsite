const { isActiveMember } = require("../lib/memberStatus");
const { refuseMembersOnly } = require("../lib/membersOnly");
// Role flags and disabled-status are cached into req.session.user at
// login (see loginAs in routes/auth.js) rather than looked up per
// request — left alone, that cache can go stale for the session cookie's
// full 30-day life: a disabled or demoted admin kept their old access
// until they happened to log back in, and changing a password (a reset
// link, or a change from another device) never touched sessions that
// were already open elsewhere. Re-fetching the real row here, on every
// request from a logged-in user, and refreshing req.session.user in
// place, means requireAuth/requireAdmin/requireMember/requireVolunteer
// below always see the current truth — no changes needed there, they
// just keep reading req.session.user as before.
function attachUser(pool) {
  return async function (req, res, next) {
    if (!req.session.user) {
      res.locals.user = null;
      return next();
    }

    // Express 4 doesn't catch a rejected promise from async middleware —
    // without this, a DB error here would leave the request hanging
    // instead of reaching the app's 500 handler.
    let rows;
    try {
      ({ rows } = await pool.query(
        "SELECT is_admin, is_member, member_expires_at, is_volunteer, is_till, is_disabled, password_changed_at, totp_enabled_at FROM users WHERE id = $1",
        [req.session.user.id]
      ));
    } catch (err) {
      return next(err);
    }
    const row = rows[0];

    // Deleted, disabled, or this session predates the account's most
    // recent password change (including a session with no
    // passwordChangedAt captured at all — one already open from before
    // this check existed) — force it out rather than let a stale cookie
    // keep working until it expires on its own. Clearing req.session.user
    // (not destroying the whole session — see below) is enough:
    // requireAuth/requireAdmin/requireMember/requireVolunteer all treat a
    // missing req.session.user as logged out, and express-session's
    // resave:false still persists this change since the session was
    // genuinely modified, so the same cookie sees the log-out on its next
    // request too.
    //
    // Session.prototype.destroy (express-session) does `delete
    // this.req.session` synchronously the instant it's called, before
    // its async store deletion even starts — calling it here would leave
    // req.session undefined for every middleware still to run in this
    // same request (the cart-count middleware right after this one,
    // which reads req.session.cart, crashed the request outright when
    // this was tried).
    const stillCurrent = row && String(row.password_changed_at.getTime()) === String(req.session.user.passwordChangedAt);
    if (!row || row.is_disabled || !stillCurrent) {
      req.session.user = null;
      res.locals.user = null;
      return next();
    }

    req.session.user.isAdmin = row.is_admin;
    // Not just the flag: the sweep that clears it only runs every 6 hours.
    req.session.user.isMember = isActiveMember(row);
    req.session.user.isVolunteer = row.is_volunteer;
    req.session.user.isTill = row.is_till;
    req.session.user.totpEnabled = Boolean(row.totp_enabled_at);

    // Inactivity clock (src/lib/privacy.js erases accounts with no login for
    // 3 years). Sessions last 30 days sliding, so an active member may never
    // log in again with a password; count any authenticated request as
    // activity, but write at most once per UTC day. The day marker lives in
    // the session, so other requests cost no extra query.
    const today = new Date().toISOString().slice(0, 10);
    if (req.session.user.activeDay !== today) {
      try {
        await pool.query("UPDATE users SET last_login_at = now(), inactivity_warned_at = NULL WHERE id = $1", [
          req.session.user.id,
        ]);
        req.session.user.activeDay = today;
      } catch (err) {
        // Not worth failing the request; retried on the next one.
        console.error("Could not refresh last_login_at:", err.message);
      }
    }

    res.locals.user = req.session.user;
    next();
  };
}

// Always on in production. Tests (which log in as admins all over the
// place) can switch it off with ADMIN_2FA_REQUIRED=false, which is ignored
// when NODE_ENV=production so a stray env var can't weaken the live site.
function admin2faRequired() {
  return process.env.NODE_ENV === "production" || process.env.ADMIN_2FA_REQUIRED !== "false";
}

// A customer who reaches an admin address gets the refusal in their own language.
// The admin screens themselves stay English.
const adminsOnly = (req) => (req.tr ? req.tr("Admins only.", "Réservé aux administrateurs.") : "Admins only.");

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login");
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  if (!req.session.user.isAdmin) return res.status(403).send(adminsOnly(req));
  // Admins must have two-step verification: until it is set up, the only
  // thing an admin session can do is reach the setup page.
  if (admin2faRequired() && !req.session.user.totpEnabled) return res.redirect("/account/2fa?required=1");
  next();
}

// The till (/admin/till): an admin, or an account holder an admin gave "Till access"
// (users.is_till). Used ONLY on the till page and its scan / check / sale / void / receipt
// routes; every other admin route stays requireAdmin. Admins keep two-step verification;
// a till-only account does not need it, but its till session ends after 8 hours without
// any till request (the cookie itself lasts 30 days).
const TILL_IDLE_MS = 8 * 60 * 60 * 1000;
const TILL_TOUCH_MS = 60 * 1000;
function requireTillOrAdmin(req, res, next) {
  const u = req.session.user;
  if (!u) return res.redirect("/login");
  if (u.isAdmin) return requireAdmin(req, res, next);
  if (!u.isTill) return res.status(403).send(adminsOnly(req));
  const now = Date.now();
  if (!u.tillActiveAt || now - u.tillActiveAt > TILL_IDLE_MS) {
    req.session.user = null;
    res.locals.user = null;
    return res.redirect("/login");
  }
  // Written at most once a minute: a session write per scan would be wasteful.
  if (now - u.tillActiveAt > TILL_TOUCH_MS) u.tillActiveAt = now;
  res.locals.tillOnly = true;
  next();
}

// Being logged in isn't the same as being a member — the Member's Access
// dashboard (forum, charity vote, meeting scheduling) is a paid
// membership perk. A logged-in user who isn't a member (or admin) is told so
// on a short page (403, lib/membersOnly.js), a guest is sent to log in; their
// account, cart and favorites stay unaffected since those only need
// requireAuth. Volunteers are a superset of members (see requireVolunteer
// below), so they pass this check too.
function requireMember(req, res, next) {
  const u = req.session.user;
  if (!u || (!u.isAdmin && !u.isMember && !u.isVolunteer)) return refuseMembersOnly(req, res);
  next();
}

// The volunteer shift-signup calendar is narrower than requireMember —
// a plain member doesn't automatically get it, only someone an admin has
// specifically marked as a volunteer (or an admin themselves).
function requireVolunteer(req, res, next) {
  const u = req.session.user;
  if (!u || (!u.isAdmin && !u.isVolunteer)) return refuseMembersOnly(req, res, { area: "volunteer" });
  next();
}

module.exports = { admin2faRequired, attachUser, requireAuth, requireAdmin, requireTillOrAdmin, TILL_IDLE_MS, requireMember, requireVolunteer };
