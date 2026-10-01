const express = require("express");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { pool } = require("../db");
const { hashToken } = require("../lib/resetTokens");
const { sendResetLink } = require("../lib/passwordReset");
const { sendVerificationEmail, sendSignupAttemptEmail } = require("../lib/emailVerification");
const { validateNewPassword } = require("../lib/passwordPolicy");
const { requireAuth } = require("../middleware/auth");
const { baseUrl } = require("../lib/baseUrl");

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

// Precomputed once at startup so a login attempt against a nonexistent
// email still runs a bcrypt compare of comparable cost — otherwise the
// "no such user" path returns measurably faster than "wrong password",
// letting an attacker enumerate registered emails via response timing.
const DUMMY_HASH = bcrypt.hashSync("no-such-account-timing-equalizer", 12);

const SIGNUP_NOTICE =
  "Thanks! Check your inbox for an email with next steps. Once your email is confirmed, log in. If you already have an account, try logging in or resetting your password.";

const LOGIN_LOCK_THRESHOLD = 5;
const LOGIN_LOCK_DURATION_MS = 15 * 60 * 1000;

// Every visitor already has a session (and thus a session ID) before
// logging in — csrfProtection gives them one on their very first request,
// to hand out a CSRF token. Writing req.session.user onto that same,
// already-existing session ID would mean a session fixed before login
// (however that happened) carries straight through into an authenticated
// one. Regenerating here gives login a fresh session ID, same as
// any other privilege change — the pre-auth session's CSRF token goes
// with it (csrfProtection issues a new one on the very next request,
// which is fine, only the redirect target below reads it), but a cart
// built up while still logged out is worth keeping.
function loginAs(req, res, user, redirectTo) {
  const cart = req.session.cart;
  const cartSeq = req.session.cartSeq;
  req.session.regenerate((err) => {
    if (err) {
      console.error(err);
      return res.status(500).render("login", { error: "Something went wrong. Please try again.", notice: null });
    }
    req.session.user = {
      id: user.id, email: user.email, displayName: user.display_name,
      isAdmin: user.is_admin, isMember: user.is_member, isVolunteer: user.is_volunteer,
      passwordChangedAt: user.password_changed_at.getTime(),
    };
    if (cart) req.session.cart = cart;
    if (cartSeq) req.session.cartSeq = cartSeq;
    res.redirect(redirectTo);
  });
}

router.get("/signup", (req, res) => {
  if (req.session.user) {
    const u = req.session.user;
    return res.redirect(u.isAdmin ? "/admin" : (u.isMember || u.isVolunteer) ? "/dashboard" : "/");
  }
  res.render("signup", { error: null, notice: null });
});

router.post("/signup", authLimiter, async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";
  const displayName = (req.body.displayName || "").trim();

  if (!email || !password || !displayName) {
    return res.status(400).render("signup", { error: "All fields are required.", notice: null });
  }
  const passwordError = await validateNewPassword(password);
  if (passwordError) {
    return res.status(400).render("signup", { error: passwordError, notice: null });
  }

  // Identical response whether or not the email is registered — a
  // distinct redirect/auto-login for new accounts would let anyone probe
  // which addresses have accounts. The new user proves they own the inbox
  // (and can then log in); an existing owner is told someone tried. The
  // bcrypt hash runs on both paths so response time doesn't differ, and
  // mail is sent in the background so a slow mail server can't either.
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows: existing } = await pool.query("SELECT id, email, display_name FROM users WHERE email = $1", [email]);
    let created = null;
    if (!existing.length) {
      try {
        const { rows } = await pool.query(
          `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3)
           RETURNING id, email, display_name`,
          [email, hash, displayName]
        );
        created = rows[0];
      } catch (err) {
        // Lost a race with a concurrent signup for the same address.
        if (err.code !== "23505") throw err;
      }
    }
    const url = baseUrl(req);
    if (created) {
      // Not fatal — the account exists either way; it just can't be
      // auto-matched to a future HelloAsso membership payment until
      // verified (see syncMembershipForEmail in lib/membership.js).
      sendVerificationEmail(created, url).catch((err) => console.error("Verification email failed:", err.message));
    } else if (existing.length) {
      sendSignupAttemptEmail(existing[0], url).catch((err) => console.error("Signup-attempt email failed:", err.message));
    }
    res.render("signup", { error: null, notice: SIGNUP_NOTICE });
  } catch (err) {
    console.error(err);
    res.status(500).render("signup", { error: "Something went wrong. Please try again.", notice: null });
  }
});

router.get("/verify-email/:token", async (req, res) => {
  const tokenHash = hashToken(req.params.token);
  const { rows } = await pool.query(
    "SELECT * FROM email_verification_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()",
    [tokenHash]
  );
  const record = rows[0];
  if (!record) {
    return res.redirect("/login?verified=invalid");
  }
  await pool.query("UPDATE users SET email_verified_at = now() WHERE id = $1 AND email_verified_at IS NULL", [record.user_id]);
  await pool.query("UPDATE email_verification_tokens SET used_at = now() WHERE id = $1", [record.id]);
  res.redirect("/login?verified=success");
});

router.get("/login", (req, res) => {
  if (req.session.user) {
    const u = req.session.user;
    return res.redirect(u.isAdmin ? "/admin" : (u.isMember || u.isVolunteer) ? "/dashboard" : "/");
  }
  const notice =
    req.query.reset === "success" ? "Password updated — log in with your new password." :
    req.query.verified === "success" ? "Email confirmed — thanks!" :
    req.query.verified === "invalid" ? "That confirmation link is invalid or has expired." :
    null;
  res.render("login", { error: null, notice });
});

router.post("/login", authLimiter, async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";

  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = rows[0];

    // Always run a bcrypt compare of the same cost, even when there's no
    // such user, so the response time doesn't reveal whether the email
    // is registered.
    const ok = user
      ? await bcrypt.compare(password, user.password_hash)
      : await bcrypt.compare(password, DUMMY_HASH).then(() => false);

    // A locked account answers exactly like a wrong password (even for the
    // right one), so neither the lock nor the account's existence is
    // revealed; attempts during the lock aren't counted or extended.
    const locked = Boolean(user && user.locked_until && new Date(user.locked_until) > new Date());
    if (locked) {
      return res.status(401).render("login", { error: "Incorrect email or password.", notice: null });
    }

    if (!ok) {
      if (user) {
        const attempts = user.failed_login_attempts + 1;
        if (attempts >= LOGIN_LOCK_THRESHOLD) {
          await pool.query(
            "UPDATE users SET failed_login_attempts = 0, locked_until = $1 WHERE id = $2",
            [new Date(Date.now() + LOGIN_LOCK_DURATION_MS), user.id]
          );
        } else {
          await pool.query("UPDATE users SET failed_login_attempts = $1 WHERE id = $2", [attempts, user.id]);
        }
      }
      return res.status(401).render("login", { error: "Incorrect email or password.", notice: null });
    }

    // Only someone who proved they know the password learns the account
    // is deactivated.
    if (user.is_disabled) {
      return res.status(403).render("login", {
        error: "This account has been deactivated. Contact us if you think this is a mistake.",
        notice: null,
      });
    }

    if (user.failed_login_attempts > 0 || user.locked_until) {
      await pool.query("UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1", [user.id]);
    }
    await pool.query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);

    // Logging in doesn't make you a member — only actual members/admins
    // (and volunteers, a superset of members — see requireMember) land on
    // the Member's Access dashboard; everyone else goes to the regular
    // site, same as a logged-out visitor.
    loginAs(req, res, user, user.is_admin ? "/admin" : (user.is_member || user.is_volunteer) ? "/dashboard" : "/");
  } catch (err) {
    console.error(err);
    res.status(500).render("login", { error: "Something went wrong. Please try again.", notice: null });
  }
});

router.get("/forgot-password", (req, res) => {
  res.render("forgot_password", { notice: null, error: null });
});

router.post("/forgot-password", authLimiter, async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const notice = "If an account exists for that email, we've sent a password reset link.";

  if (email) {
    try {
      const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
      const user = rows[0];
      if (user) {
        // Background, so the response time doesn't reveal whether the
        // account exists (a mail round-trip only happens when it does).
        sendResetLink(user, baseUrl(req)).catch((err) => console.error("Reset email failed:", err.message));
      }
    } catch (err) {
      console.error(err);
    }
  }
  res.render("forgot_password", { notice, error: null });
});

router.get("/reset-password/:token", async (req, res) => {
  const tokenHash = hashToken(req.params.token);
  const { rows } = await pool.query(
    "SELECT * FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()",
    [tokenHash]
  );
  if (!rows.length) {
    return res.status(400).render("reset_password", { error: "This reset link is invalid or has expired.", token: null });
  }
  res.render("reset_password", { error: null, token: req.params.token });
});

router.post("/reset-password/:token", authLimiter, async (req, res) => {
  const newPassword = req.body.newPassword || "";
  const tokenHash = hashToken(req.params.token);

  const { rows } = await pool.query(
    "SELECT * FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()",
    [tokenHash]
  );
  const record = rows[0];
  if (!record) {
    return res.status(400).render("reset_password", { error: "This reset link is invalid or has expired.", token: null });
  }
  const passwordError = await validateNewPassword(newPassword);
  if (passwordError) {
    return res.status(400).render("reset_password", { error: passwordError, token: req.params.token });
  }

  const hash = await bcrypt.hash(newPassword, 12);
  // password_changed_at is what forces every other open session (this
  // reset flow isn't run from within one) to log out on its next
  // request — see attachUser in middleware/auth.js.
  await pool.query("UPDATE users SET password_hash = $1, password_changed_at = now() WHERE id = $2", [hash, record.user_id]);
  await pool.query("UPDATE password_reset_tokens SET used_at = now() WHERE id = $1", [record.id]);

  res.redirect("/login?reset=success");
});

router.get("/account/password", requireAuth, (req, res) => {
  res.render("change_password", { error: null, notice: null });
});

router.post("/account/password", requireAuth, async (req, res) => {
  const currentPassword = req.body.currentPassword || "";
  const newPassword = req.body.newPassword || "";

  const passwordError = await validateNewPassword(newPassword);
  if (passwordError) {
    return res.status(400).render("change_password", { error: passwordError, notice: null });
  }

  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.session.user.id]);
  const user = rows[0];
  const ok = user && (await bcrypt.compare(currentPassword, user.password_hash));
  if (!ok) {
    return res.status(401).render("change_password", { error: "Current password is incorrect.", notice: null });
  }

  const hash = await bcrypt.hash(newPassword, 12);
  const { rows: updated } = await pool.query(
    "UPDATE users SET password_hash = $1, password_changed_at = now() WHERE id = $2 RETURNING password_changed_at",
    [hash, user.id]
  );
  // Every OTHER open session for this account will fail attachUser's
  // freshness check on its next request and get logged out — but this
  // request's own session made the change, so it re-stamps its own
  // captured value rather than also logging itself out.
  req.session.user.passwordChangedAt = updated[0].password_changed_at.getTime();
  res.render("change_password", { error: null, notice: "Password updated." });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

module.exports = router;
