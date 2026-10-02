const express = require("express");
const bcrypt = require("bcryptjs");
const { limit, ipKey } = require("../middleware/rateLimits");
const { pool } = require("../db");
const { hashToken } = require("../lib/resetTokens");
const { sendResetLink } = require("../lib/passwordReset");
const { sendVerificationEmail, sendSignupAttemptEmail } = require("../lib/emailVerification");
const { validateNewPassword } = require("../lib/passwordPolicy");
const { requireAuth } = require("../middleware/auth");
const { isEmail, clean } = require("../lib/validation");
const { baseUrl } = require("../lib/baseUrl");
const { saveSession } = require("../lib/session");
const totp = require("../lib/totp");
const { syncMembershipInBackground } = require("../lib/membership");

const router = express.Router();

const MINUTE = 60 * 1000;

// Separate per-IP buckets: a shop or school behind one NAT shares an IP,
// and one shared bucket that also counted successful logins let ordinary
// use lock the whole site's members out. Login and reset only count
// failures (what guessing looks like); the per-account lockout below is
// independent of these. Signup and forgot-password answer identically
// whatever happens (no enumeration), so every request counts there.
const loginLimiter = limit({ windowMs: 15 * MINUTE, max: 20, skipSuccessfulRequests: true });
const signupLimiter = limit({ windowMs: 60 * MINUTE, max: 30 });
const forgotLimiter = limit({ windowMs: 15 * MINUTE, max: 10 });
const resetLimiter = limit({ windowMs: 15 * MINUTE, max: 20, skipSuccessfulRequests: true });
// Guessing the current password from a logged-in (e.g. hijacked) session:
// 5 wrong attempts per account per 15 minutes. Keyed on the account, not
// the IP, and only a wrong current password (401) counts.
const passwordChangeLimiter = limit({
  windowMs: 15 * MINUTE,
  max: 5,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.statusCode !== 401,
  keyGenerator: (req) => `user:${req.session.user.id}`,
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

// Every visitor who can submit the login form already has a session (and
// thus a session ID) — rendering the form's CSRF token (see csrfProtection)
// is what created it. Writing req.session.user onto that same,
// already-existing session ID would mean a session fixed before login
// (however that happened) carries straight through into an authenticated
// one. Regenerating here gives login a fresh session ID, same as
// any other privilege change — the pre-auth session's CSRF token goes
// with it (csrfProtection issues a new one lazily, the next time a page
// or /api/csrf-token reads it), but a cart
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
      totpEnabled: Boolean(user.totp_enabled_at),
    };
    if (cart) req.session.cart = cart;
    if (cartSeq) req.session.cartSeq = cartSeq;
    // Persist before redirecting — see lib/session.js.
    saveSession(req).then(
      () => res.redirect(redirectTo),
      (saveErr) => {
        console.error(saveErr);
        res.status(500).render("login", { error: "Something went wrong. Please try again.", notice: null });
      }
    );
  });
}

// One atomic statement: a read-add-write in JS lets parallel wrong guesses
// all read the same count and undercount past the lock threshold. Used for
// wrong passwords AND wrong two-step codes, so guessing a code is capped
// per account (not per cookie/IP) like guessing a password.
function countFailedAttempt(userId) {
  return pool.query(
    `UPDATE users
     SET failed_login_attempts = CASE WHEN failed_login_attempts + 1 >= $2 THEN 0 ELSE failed_login_attempts + 1 END,
         locked_until = CASE WHEN failed_login_attempts + 1 >= $2 THEN $3::timestamptz ELSE locked_until END
     WHERE id = $1`,
    [userId, LOGIN_LOCK_THRESHOLD, new Date(Date.now() + LOGIN_LOCK_DURATION_MS)]
  );
}

router.get("/signup", (req, res) => {
  if (req.session.user) {
    const u = req.session.user;
    return res.redirect(u.isAdmin ? "/admin" : (u.isMember || u.isVolunteer) ? "/dashboard" : "/");
  }
  res.render("signup", { error: null, notice: null });
});

router.post("/signup", signupLimiter, async (req, res) => {
  const email = clean(req.body.email, 200).toLowerCase();
  const password = req.body.password || "";
  const displayName = clean(req.body.displayName, 100);

  if (!email || !password || !displayName) {
    return res.status(400).render("signup", { error: "All fields are required.", notice: null });
  }
  const passwordError = await validateNewPassword(password);
  if (passwordError) {
    return res.status(400).render("signup", { error: passwordError, notice: null });
  }

  // Not a single plain address ("a@x.com, b@y.com" would make nodemailer
  // mail every recipient from our Gmail with attacker-chosen text): no
  // account, no mail, but the SAME neutral response as a real signup, so
  // this can't be told apart from one (signup stays enumeration-safe).
  if (!isEmail(email)) {
    return res.render("signup", { error: null, notice: SIGNUP_NOTICE });
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
  const { rows: verified } = await pool.query(
    "UPDATE users SET email_verified_at = now() WHERE id = $1 AND email_verified_at IS NULL RETURNING email",
    [record.user_id]
  );
  await pool.query("UPDATE email_verification_tokens SET used_at = now() WHERE id = $1", [record.id]);
  if (verified.length) syncMembershipInBackground(pool, verified[0].email);
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

router.post("/login", loginLimiter, async (req, res) => {
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
        // One atomic statement: a read-add-write in JS lets parallel
        // wrong guesses all read the same count and write back the same
        // +1, undercounting past the lock threshold. The row lock makes
        // concurrent attempts count one by one; whichever one reaches the
        // threshold sets the lock and resets the counter in the same
        // statement (a later one, now seeing 0, simply counts again).
        await countFailedAttempt(user.id);
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

    // With two-step on, a right password must NOT wipe the failure count:
    // otherwise an attacker who has the password could re-login between
    // code guesses and never reach the lock. It's cleared after the code.
    if (!user.totp_enabled_at && (user.failed_login_attempts > 0 || user.locked_until)) {
      await pool.query("UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1", [user.id]);
    }

    // Two-step verification: the password alone doesn't log anyone in. The
    // session only remembers who is mid-login (for 5 minutes); loginAs
    // runs once the code checks out (POST /login/2fa below).
    if (user.totp_enabled_at) {
      req.session.pending2fa = { userId: user.id, at: Date.now(), fails: 0 };
      await saveSession(req);
      return res.redirect("/login/2fa");
    }

    await pool.query("UPDATE users SET last_login_at = now(), inactivity_warned_at = NULL WHERE id = $1", [user.id]);

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

const PENDING_2FA_MS = 5 * MINUTE;
const MAX_2FA_FAILS = 5;
// Per pending account, not per IP: guessing a 6-digit code is what this
// stops. Only failures count.
const twoFactorLimiter = limit({
  windowMs: 15 * MINUTE,
  max: 10,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.statusCode !== 401,
  keyGenerator: (req) => (req.session.pending2fa ? `2fa:${req.session.pending2fa.userId}` : `ip:${ipKey(req)}`),
});

function pendingLogin(req) {
  const p = req.session.pending2fa;
  if (!p || Date.now() - p.at > PENDING_2FA_MS) {
    req.session.pending2fa = null;
    return null;
  }
  return p;
}

router.get("/login/2fa", (req, res) => {
  if (!pendingLogin(req)) return res.redirect("/login");
  res.render("login_2fa", { error: null });
});

router.post("/login/2fa", twoFactorLimiter, async (req, res) => {
  const pending = pendingLogin(req);
  if (!pending) return res.redirect("/login");
  const fail = async () => {
    await countFailedAttempt(pending.userId);
    pending.fails += 1;
    if (pending.fails >= MAX_2FA_FAILS) {
      req.session.pending2fa = null;
      await saveSession(req);
      return res.status(401).render("login", { error: "Too many wrong codes. Log in again.", notice: null });
    }
    await saveSession(req);
    return res.status(401).render("login_2fa", { error: "That code didn't work. Try again." });
  };

  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [pending.userId]);
    const user = rows[0];
    if (!user || user.is_disabled || !user.totp_enabled_at) {
      req.session.pending2fa = null;
      return res.redirect("/login");
    }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      req.session.pending2fa = null;
      return res.status(401).render("login", { error: "Too many wrong attempts. Try again in a few minutes.", notice: null });
    }
    const code = String(req.body.code || "").trim();

    let accepted = false;
    if (/^\d{3}\s?\d{3}$/.test(code)) {
      let secret = null;
      try {
        secret = totp.decryptSecret(user.totp_secret_enc);
      } catch (err) {
        // The encryption key changed: the code can't be checked. Recovery
        // codes still work; an admin can reset the account's two-step.
        console.error(`Two-step secret of account ${user.id} could not be decrypted:`, err.message);
      }
      const step = secret && totp.verifyTotp(secret, code, { lastStep: user.totp_last_step });
      if (step != null && step !== false) {
        // Atomic: a replayed code (same step) matches no row.
        const { rowCount } = await pool.query(
          "UPDATE users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)",
          [user.id, step]
        );
        accepted = rowCount === 1;
      }
    } else if (code) {
      // One-time recovery code (for a lost phone); consumed on use.
      const { rowCount } = await pool.query(
        "UPDATE totp_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL",
        [user.id, totp.hashRecovery(code)]
      );
      accepted = rowCount === 1;
    }
    if (!accepted) return await fail();

    req.session.pending2fa = null;
    await pool.query("UPDATE users SET last_login_at = now(), inactivity_warned_at = NULL, failed_login_attempts = 0, locked_until = NULL WHERE id = $1", [user.id]);
    loginAs(req, res, user, user.is_admin ? "/admin" : (user.is_member || user.is_volunteer) ? "/dashboard" : "/");
  } catch (err) {
    console.error(err);
    res.status(500).render("login", { error: "Something went wrong. Please try again.", notice: null });
  }
});

router.get("/forgot-password", (req, res) => {
  res.render("forgot_password", { notice: null, error: null });
});

router.post("/forgot-password", forgotLimiter, async (req, res) => {
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

router.post("/reset-password/:token", resetLimiter, async (req, res) => {
  const newPassword = req.body.newPassword || "";
  const tokenHash = hashToken(req.params.token);
  const invalid = () =>
    res.status(400).render("reset_password", { error: "This reset link is invalid or has expired.", token: null });

  // Cheap non-consuming look first, so a too-weak password doesn't burn
  // the link; the real gate is the atomic claim below.
  const { rows } = await pool.query(
    "SELECT 1 FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()",
    [tokenHash]
  );
  if (!rows.length) return invalid();
  const passwordError = await validateNewPassword(newPassword);
  if (passwordError) {
    return res.status(400).render("reset_password", { error: passwordError, token: req.params.token });
  }

  const hash = await bcrypt.hash(newPassword, 12);
  const client = await pool.connect();
  let email;
  try {
    await client.query("BEGIN");
    // The token is the atomic gate: of any number of concurrent requests
    // with the same token, exactly one gets a row back.
    const { rows: claimed } = await client.query(
      `UPDATE password_reset_tokens SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [tokenHash]
    );
    if (!claimed.length) {
      await client.query("ROLLBACK");
      return invalid();
    }
    const userId = claimed[0].user_id;
    // password_changed_at is what forces every other open session (this
    // reset flow isn't run from within one) to log out on its next
    // request, see attachUser in middleware/auth.js. A completed reset
    // also proves control of the inbox, so it verifies the email and
    // clears any login lockout, and retires the user's other pending links.
    const { rows: users } = await client.query(
      `UPDATE users SET password_hash = $1, password_changed_at = now(),
              email_verified_at = COALESCE(email_verified_at, now()),
              failed_login_attempts = 0, locked_until = NULL
       WHERE id = $2 RETURNING email`,
      [hash, userId]
    );
    email = users[0] && users[0].email;
    await client.query("UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [userId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (email) syncMembershipInBackground(pool, email);
  res.redirect("/login?reset=success");
});

router.get("/account/password", requireAuth, (req, res) => {
  res.render("change_password", { error: null, notice: null });
});

router.post("/account/password", requireAuth, passwordChangeLimiter, async (req, res) => {
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
  // Persist before responding, or a quick next request reads the old stamp
  // and logs this very session out — see lib/session.js.
  await saveSession(req);
  res.render("change_password", { error: null, notice: "Password updated." });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

module.exports = router;
