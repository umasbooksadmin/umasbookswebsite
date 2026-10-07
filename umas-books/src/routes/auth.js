const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { limit, ipKey } = require("../middleware/rateLimits");
const { pool } = require("../db");
const { hashToken } = require("../lib/resetTokens");
const { isActiveMember } = require("../lib/memberStatus");
const { sendResetLink, createResetToken } = require("../lib/passwordReset");
const { sendVerificationEmail, sendSignupAttemptEmail } = require("../lib/emailVerification");
const { validateNewPassword } = require("../lib/passwordPolicy");
const { requireAuth } = require("../middleware/auth");
const { isEmail, clean } = require("../lib/validation");
const { baseUrl } = require("../lib/baseUrl");
const { saveSession } = require("../lib/session");
const { safeReturnTo } = require("../lib/returnTo");
const totp = require("../lib/totp");
const { audit } = require("../lib/audit");
const { syncMembershipInBackground, syncMembershipForEmail } = require("../lib/membership");
const helloasso = require("../lib/helloasso");
const { isPreviewMode } = require("../lib/preview");
const { loginThrottle } = require("../lib/loginThrottle");

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
// "Send me the confirmation link again": answers identically whatever the
// account's state (no enumeration), so every request counts; on top of this
// per-IP cap, an account is sent at most one link per RESEND_COOLDOWN_MS.
const resendLimiter = limit({ windowMs: 15 * MINUTE, max: 6 });
const RESEND_COOLDOWN_MS = 5 * MINUTE;
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

const signupNotice = (req) =>
  req.tr(
    "Thanks! Check your inbox: we've emailed you a link to confirm your address and choose your password. If you already have an account, try logging in or resetting your password.",
    "Merci ! Consultez votre boîte de réception : nous vous avons envoyé un lien pour confirmer votre adresse et choisir votre mot de passe. Si vous avez déjà un compte, essayez de vous connecter ou de réinitialiser votre mot de passe."
  );

// Two-step code failures lock the account (countFailedAttempt below). Password
// failures are throttled per (account, IP) pair plus a softer per-account total:
// see lib/loginThrottle.js for why (a stranger must not lock the owner out).
const LOGIN_LOCK_THRESHOLD = 5;
const LOGIN_LOCK_DURATION_MS = 15 * 60 * 1000;

// Every person who can submit the login form already has a session (and
// thus a session ID) — rendering the form's CSRF token (see csrfProtection)
// is what created it. Writing req.session.user onto that same,
// already-existing session ID would mean a session fixed before login
// (however that happened) carries straight through into an authenticated
// one. Regenerating here gives login a fresh session ID, same as
// any other privilege change — the pre-auth session's CSRF token goes
// with it (csrfProtection issues a new one lazily, the next time a page
// or /api/csrf-token reads it), but a cart
// built up while still logged out is worth keeping.
// Remember the language the person has chosen for later emails. Only when
// they actually chose one (cookie present): a bare Accept-Language guess
// must not overwrite a language stored earlier.
async function refreshUserLang(req, userId) {
  if (!req.langFromCookie) return;
  await pool.query("UPDATE users SET lang = $1 WHERE id = $2", [req.lang, userId]);
}

// Where a fresh login lands: a validated returnTo (e.g. the cart a guest was
// sent away from at checkout) wins, otherwise the role's usual home.
function landingFor(user, returnTo) {
  return safeReturnTo(returnTo) || (user.is_admin ? "/admin" : user.is_till ? "/admin/till" : (user.is_member || user.is_volunteer) ? "/dashboard" : "/");
}

function loginAs(req, res, user, redirectTo) {
  loginThrottle.recordSuccess(user.id, ipKey(req)); // clears this address's failures; remembers it as a usual one
  const cart = req.session.cart;
  const cartSeq = req.session.cartSeq;
  req.session.regenerate((err) => {
    if (err) {
      console.error(err);
      return res.status(500).render("login", { error: req.tr("Something went wrong. Please try again.", "Une erreur est survenue. Veuillez réessayer."), notice: null });
    }
    req.session.user = {
      id: user.id, email: user.email, displayName: user.display_name,
      isAdmin: user.is_admin, isMember: isActiveMember(user), isVolunteer: user.is_volunteer, isTill: Boolean(user.is_till), tillActiveAt: Date.now(),
      passwordChangedAt: user.password_changed_at.getTime(),
      totpEnabled: Boolean(user.totp_enabled_at),
    };
    if (user.is_admin) audit(req, { action: "admin.login", targetType: "user", targetId: user.id });
    if (cart) req.session.cart = cart;
    if (cartSeq) req.session.cartSeq = cartSeq;
    // Persist before redirecting — see lib/session.js.
    saveSession(req).then(
      () => res.redirect(redirectTo),
      (saveErr) => {
        console.error(saveErr);
        res.status(500).render("login", { error: req.tr("Something went wrong. Please try again.", "Une erreur est survenue. Veuillez réessayer."), notice: null });
      }
    );
  });
}

// One atomic statement: a read-add-write in JS lets parallel wrong guesses
// all read the same count and undercount past the lock threshold. Used for
// wrong two-step codes only, so guessing a code is capped per account (not per
// cookie/IP). Wrong passwords use lib/loginThrottle.js (per account+IP pair).
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
  res.locals.returnTo = safeReturnTo(req.query.returnTo);
  res.render("signup", { error: null, notice: null });
});

// The one place an account is created from a typed name + email: used by the
// signup form (POST /signup) and by the membership page's "join" form (POST
// /membership/join), so both behave identically (unusable password, email
// confirmation first, neutral for an existing address). `membership` only
// changes the wording of the confirmation email. Throws on a database error.
async function registerAccount(req, { email, displayName, returnTo, membership = false }) {
  // Unusable: random, never revealed. The hash still runs on both paths so
  // response time doesn't differ between new and existing emails.
  const hash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);
  const { rows: existing } = await pool.query("SELECT id, email, display_name, lang FROM users WHERE email = $1", [email]);
  let created = null;
  if (!existing.length) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, display_name, lang, first_verification_pending) VALUES ($1, $2, $3, $4, TRUE)
         RETURNING id, email, display_name, lang`,
        [email, hash, displayName, req.lang]
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
    sendVerificationEmail(created, url, { choosePassword: true, returnTo, membership }).catch((err) => console.error("Verification email failed:", err.message));
  } else if (existing.length) {
    sendSignupAttemptEmail(existing[0], url).catch((err) => console.error("Signup-attempt email failed:", err.message));
  }
}

router.post("/signup", signupLimiter, async (req, res) => {
  const email = clean(req.body.email, 200).toLowerCase();
  // No password at signup (any "password" field sent is ignored): the person
  // chooses it only after proving they own the mailbox, on the page the
  // confirmation link leads to (GET /verify-email below). Nobody can set a
  // password on an address they merely typed in.
  const displayName = clean(req.body.displayName, 100);
  // Where to send the person once confirmed and logged in (e.g. back to the
  // cart): validated here, then carried inside the single-use tokens.
  const returnTo = safeReturnTo(req.body.returnTo);
  res.locals.returnTo = returnTo;

  if (!email || !displayName) {
    return res.status(400).render("signup", { error: req.tr("All fields are required.", "Tous les champs sont obligatoires."), notice: null });
  }

  // Not a single plain address ("a@x.com, b@y.com" would make nodemailer
  // mail every recipient from our Gmail with attacker-chosen text): no
  // account, no mail, but the SAME neutral response as a real signup, so
  // this can't be told apart from one (signup stays enumeration-safe).
  if (!isEmail(email)) {
    return res.render("signup", { error: null, notice: signupNotice(req) });
  }

  // Identical response whether or not the email is registered — a
  // distinct redirect/auto-login for new accounts would let anyone probe
  // which addresses have accounts. The new user proves they own the inbox
  // (and can then log in); an existing owner is told someone tried. The
  // bcrypt hash runs on both paths so response time doesn't differ, and
  // mail is sent in the background so a slow mail server can't either.
  try {
    await registerAccount(req, { email, displayName, returnTo });
    res.render("signup", { error: null, notice: signupNotice(req) });
  } catch (err) {
    console.error(err);
    res.status(500).render("signup", { error: req.tr("Something went wrong. Please try again.", "Une erreur est survenue. Veuillez réessayer."), notice: null });
  }
});

// ---- Becoming a member (the page itself is views/marketing/membership.ejs,
// its state in src/lib/membershipPage.js) -------------------------------------
const MEMBERSHIP_PAGE = "/membership.html";
const MEMBERSHIP_LOGIN_URL = `/login?returnTo=${encodeURIComponent(MEMBERSHIP_PAGE)}`;

// A guest joins in ONE step: this creates the account exactly like POST
// /signup does (registerAccount: unusable password, confirmation email, the
// same neutral behaviour for an address that already has an account), then
// the page shows the payment form. Pay first, confirm the email after: the
// confirmation link (returnTo = this page) leads to "choose your password",
// whose completion runs the membership sync for the confirmed address.
//
// ENUMERATION: the next page is IDENTICAL whether or not the address already
// has an account (payment form always shown, same texts), so it reveals
// nothing; an existing owner just gets the usual "someone tried to sign up"
// email. Showing the form only for new addresses would be an existence oracle.
// What this costs: someone who types another person's address and pays would
// pay for THAT account's membership: no security issue (the money is theirs,
// the membership goes to the real owner), only their own typo, and the page
// asks them to log in first if they already have an account. The typed email
// is kept only in the session (never in a URL) and expires after two hours.
// A logged-in person is never given this form: they become a member on their
// existing account, and this route does nothing for them.
router.post("/membership/join", signupLimiter, async (req, res) => {
  // Preview mode: sign-up and payment stay off; nothing is created.
  if (isPreviewMode() || req.session.user) return res.redirect(303, MEMBERSHIP_PAGE);
  const email = clean(req.body.email, 200).toLowerCase();
  const displayName = clean(req.body.displayName, 100);
  // A badly formed address is told so (this reveals nothing about accounts)
  // and creates nothing; "a@x.com, b@y.com" never reaches the mailer.
  if (!email || !displayName || !isEmail(email)) {
    req.session.membershipFlash = { error: "fields", name: displayName, email: isEmail(email) ? email : "" };
    return saveSession(req).then(() => res.redirect(303, MEMBERSHIP_PAGE), (err) => {
      console.error(err);
      res.status(500).type("text").send("Something went wrong. Please try again.");
    });
  }
  try {
    await registerAccount(req, { email, displayName, returnTo: MEMBERSHIP_PAGE, membership: true });
    req.session.membershipJoin = { email, at: Date.now() };
    await saveSession(req);
    res.redirect(303, MEMBERSHIP_PAGE);
  } catch (err) {
    console.error(err);
    res.status(500).type("text").send("Something went wrong. Please try again.");
  }
});

// "Use a different email" on the payment step: forget the typed address.
router.post("/membership/join/reset", async (req, res) => {
  delete req.session.membershipJoin;
  // Saved BEFORE redirecting: express-session answers a redirect before the
  // store write lands, so the next page view could still see the old state
  // (and show the payment step again instead of the form).
  await saveSession(req);
  res.redirect(303, MEMBERSHIP_PAGE);
});

// Per ACCOUNT (not per IP): each press asks HelloAsso.
const membershipCheckLimiter = limit({
  windowMs: 10 * MINUTE,
  max: 5,
  keyGenerator: (req) => `user:${req.session.user.id}`,
});

// "Check my membership": runs the same verified sync the webhook and the
// backstop run, now, for THIS account's confirmed email (taken from the
// account, never from the request), then reports the outcome on the page.
router.post("/membership/check", (req, res, next) => {
  if (!req.session.user) return res.redirect(303, MEMBERSHIP_LOGIN_URL);
  next();
}, membershipCheckLimiter, async (req, res) => {
  const flash = async (check) => {
    req.session.membershipFlash = { check };
    await saveSession(req);
    res.redirect(303, MEMBERSHIP_PAGE);
  };
  try {
    const { rows } = await pool.query("SELECT email, email_verified_at, is_disabled FROM users WHERE id = $1", [req.session.user.id]);
    const u = rows[0];
    if (!u || u.is_disabled) return res.redirect(303, MEMBERSHIP_LOGIN_URL);
    // The sync only ever attaches payments to a CONFIRMED address.
    if (!u.email_verified_at) return await flash("unconfirmed");
    if (!helloasso.isConfigured()) return await flash("error");
    await syncMembershipForEmail(pool, u.email);
    const { rows: after } = await pool.query("SELECT is_member, member_expires_at FROM users WHERE id = $1", [req.session.user.id]);
    const found = isActiveMember(after[0]);
    if (found) req.session.user.isMember = true;
    return await flash(found ? "found" : "notfound");
  } catch (err) {
    console.error("Membership check failed:", err.message);
    try { return await flash("error"); } catch (e) { console.error(e); return res.status(500).type("text").send("Something went wrong. Please try again."); }
  }
});

// ACCOUNT PRE-HIJACK DEFENCE. Signup collects no password at all; the account
// starts with an unusable one. (Older still-unconfirmed accounts that did
// choose one at signup are covered by the same rules below.)
//  1. POST /login refuses a self-signup account until its email is confirmed,
//     so whoever typed the address at signup never holds a session before the
//     real inbox owner has acted.
//  2. The FIRST confirmation through the emailed link is a change of
//     ownership: the signup password is destroyed (replaced by a random
//     hash nobody knows), every session is killed (password_changed_at) and
//     the person is sent straight to "choose your password" with a fresh
//     single-use token. Whoever clicked the link controls the mailbox, so
//     they, and only they, pick the password. An attacker who signed up with
//     a victim's address and their own password is locked out the moment
//     the victim confirms. Membership matching waits for that password
//     choice (the reset POST runs syncMembershipInBackground).
// Only accounts flagged by POST /signup (first_verification_pending) take
// this path: admin-created, grandfathered and admin-email-changed accounts
// keep their passwords and just become verified.
// The link in the email only SHOWS a page with one button; the work happens on
// the button's POST. Mail scanners (Outlook SafeLinks, antivirus) open every
// link in a message with a GET, and a GET that changed state would use the
// single-use token up before the person ever clicked (they would then see
// "invalid or expired"). Same pattern as /request-a-book/confirm/:token.
// Both verbs share one limiter: the route is unauthenticated.
const verifyEmailLimiter = limit({ windowMs: 15 * MINUTE, max: 30 });

// One hash, computed once at startup (cost 10, ~100 ms, a one-off) and reused
// for every first confirmation: nobody knows what it is the hash of (random
// bytes thrown away), which is all "unusable password" needs. Hashing inside
// the request let anyone burn CPU by hitting the URL with random tokens.
const UNUSABLE_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString("hex"), 10);

const renderVerifyEmail = (res, state, token, status = 200) => {
  res.set("Cache-Control", "no-store");
  return res.status(status).render("verify_email", { state, token });
};

router.get("/verify-email/:token", verifyEmailLimiter, async (req, res) => {
  // Read-only peek: nothing is consumed here.
  const { rows } = await pool.query(
    "SELECT 1 FROM email_verification_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()",
    [hashToken(req.params.token)]
  );
  return rows.length ? renderVerifyEmail(res, "ask", req.params.token) : renderVerifyEmail(res, "invalid", "", 400);
});

router.post("/verify-email/:token", verifyEmailLimiter, async (req, res) => {
  const tokenHash = hashToken(req.params.token);
  const client = await pool.connect();
  let outcome;
  try {
    await client.query("BEGIN");
    // The token is the atomic gate: of concurrent clicks exactly one wins.
    const { rows: claimed } = await client.query(
      `UPDATE email_verification_tokens SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id, return_to`,
      [tokenHash]
    );
    if (!claimed.length) {
      await client.query("ROLLBACK");
      return renderVerifyEmail(res, "invalid", "", 400);
    }
    const { rows: users } = await client.query(
      "SELECT id, email, email_verified_at, first_verification_pending FROM users WHERE id = $1 FOR UPDATE",
      [claimed[0].user_id]
    );
    const user = users[0];
    // Stored by us from a validated value; re-validated on the way out.
    const returnTo = safeReturnTo(claimed[0].return_to);
    const returnParam = returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : "";
    if (!user || user.email_verified_at) {
      outcome = { redirect: `/login?verified=success${returnParam}` };
    } else if (user.first_verification_pending) {
      await client.query(
        `UPDATE users SET email_verified_at = now(), first_verification_pending = FALSE,
                password_hash = $2, password_changed_at = now(),
                failed_login_attempts = 0, locked_until = NULL
         WHERE id = $1`,
        [user.id, UNUSABLE_PASSWORD_HASH]
      );
      await client.query("UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [user.id]);
      const rawReset = await createResetToken(client, user.id, returnTo);
      outcome = { redirect: `/reset-password/${rawReset}?confirmed=1`, noStore: true };
    } else {
      await client.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [user.id]);
      outcome = { redirect: `/login?verified=success${returnParam}`, syncEmail: user.email };
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (outcome.syncEmail) syncMembershipInBackground(pool, outcome.syncEmail);
  if (outcome.noStore) res.set("Cache-Control", "no-store");
  res.redirect(outcome.redirect);
});

// Neutral for every account state; sends only for a self-signup account still
// waiting for its first confirmation, at most once per cooldown.
router.post("/resend-verification", resendLimiter, async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const returnTo = safeReturnTo(req.body.returnTo);
  res.locals.returnTo = returnTo;
  const notice = req.tr(
    "If that account is waiting for confirmation, we've sent a new link. Check your inbox.",
    "Si ce compte attend sa confirmation, nous avons envoyé un nouveau lien. Consultez votre boîte de réception."
  );
  if (email) {
    try {
      const { rows } = await pool.query(
        `SELECT u.id, u.email, u.display_name, u.lang FROM users u
         WHERE u.email = $1 AND u.email_verified_at IS NULL AND u.first_verification_pending
           AND NOT EXISTS (SELECT 1 FROM email_verification_tokens t
                           WHERE t.user_id = u.id AND t.created_at > now() - ($2::int * interval '1 millisecond'))`,
        [email, RESEND_COOLDOWN_MS]
      );
      if (rows[0]) {
        // Background, like signup: response time can't reveal the account.
        sendVerificationEmail(rows[0], baseUrl(req), { choosePassword: true, returnTo, throttle: "skipInterval" }).catch((err) => console.error("Verification email failed:", err.message));
      }
    } catch (err) {
      console.error(err);
    }
  }
  res.render("login", { error: null, notice });
});

router.get("/login", (req, res) => {
  if (req.session.user) {
    const u = req.session.user;
    return res.redirect(safeReturnTo(req.query.returnTo) || (u.isAdmin ? "/admin" : (u.isMember || u.isVolunteer) ? "/dashboard" : "/"));
  }
  res.locals.returnTo = safeReturnTo(req.query.returnTo);
  const notice =
    req.query.reset === "confirmed" ? req.tr("Password saved — your email is confirmed. Log in to get started.", "Mot de passe enregistré : votre adresse e-mail est confirmée. Connectez-vous pour commencer.") :
    req.query.reset === "success" ? req.tr("Password updated — log in with your new password.", "Mot de passe mis à jour : connectez-vous avec votre nouveau mot de passe.") :
    req.query.verified === "success" ? req.tr("Email confirmed — thanks!", "Adresse e-mail confirmée, merci !") :
    req.query.verified === "invalid" ? req.tr("That confirmation link is invalid or has expired.", "Ce lien de confirmation est invalide ou a expiré.") :
    null;
  res.render("login", { error: null, notice });
});

router.post("/login", loginLimiter, async (req, res) => {
  const returnTo = safeReturnTo(req.body.returnTo);
  res.locals.returnTo = returnTo;
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
    const clientKey = ipKey(req);
    const locked = Boolean(user && ((user.locked_until && new Date(user.locked_until) > new Date()) || loginThrottle.isBlocked(user.id, clientKey)));
    if (locked) {
      return res.status(401).render("login", { error: req.tr("Incorrect email or password.", "E-mail ou mot de passe incorrect."), notice: null });
    }

    if (!ok) {
      if (user) {
        // Counted per (account, IP) and per account in memory (synchronous,
        // so parallel guesses cannot undercount): lib/loginThrottle.js.
        loginThrottle.recordFailure(user.id, clientKey);
      }
      return res.status(401).render("login", { error: req.tr("Incorrect email or password.", "E-mail ou mot de passe incorrect."), notice: null });
    }

    // Only someone who proved they know the password learns the account
    // is deactivated.
    if (user.is_disabled) {
      return res.status(403).render("login", {
        error: req.tr("This account has been deactivated. Contact us if you think this is a mistake.", "Ce compte a été désactivé. Contactez-nous si vous pensez qu'il s'agit d'une erreur."),
        notice: null,
      });
    }

    // A self-signup account can't log in until its email is confirmed (see
    // the pre-hijack note above GET /verify-email). Only someone who
    // typed the right password learns this; the form offers a fresh link.
    if (user.first_verification_pending && !user.email_verified_at) {
      return res.status(403).render("login", {
        error: req.tr("Please confirm your email first: open the link we sent you. You can request a new one below.", "Veuillez d'abord confirmer votre adresse e-mail : ouvrez le lien que nous vous avons envoyé. Vous pouvez en demander un nouveau ci-dessous."),
        notice: null,
        unverifiedEmail: user.email,
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
      req.session.pending2fa = { userId: user.id, at: Date.now(), fails: 0, returnTo };
      await saveSession(req);
      return res.redirect("/login/2fa");
    }

    await pool.query("UPDATE users SET last_login_at = now(), inactivity_warned_at = NULL WHERE id = $1", [user.id]);
    await refreshUserLang(req, user.id);

    // Logging in doesn't make you a member — only actual members/admins
    // (and volunteers, a superset of members — see requireMember) land on
    // the Member's Access dashboard; everyone else goes to the regular
    // site, same as a guest.
    loginAs(req, res, user, landingFor(user, returnTo));
  } catch (err) {
    console.error(err);
    res.status(500).render("login", { error: req.tr("Something went wrong. Please try again.", "Une erreur est survenue. Veuillez réessayer."), notice: null });
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
      res.locals.returnTo = safeReturnTo(pending.returnTo);
      req.session.pending2fa = null;
      await saveSession(req);
      return res.status(401).render("login", { error: req.tr("Too many wrong codes. Log in again.", "Trop de codes erronés. Veuillez vous reconnecter."), notice: null });
    }
    await saveSession(req);
    return res.status(401).render("login_2fa", { error: req.tr("That code didn't work. Try again.", "Ce code n'a pas fonctionné. Veuillez réessayer.") });
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
      return res.status(401).render("login", { error: req.tr("Too many wrong attempts. Try again in a few minutes.", "Trop de tentatives erronées. Veuillez réessayer dans quelques minutes."), notice: null });
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

    const returnTo = pending.returnTo;
    req.session.pending2fa = null;
    await pool.query("UPDATE users SET last_login_at = now(), inactivity_warned_at = NULL, failed_login_attempts = 0, locked_until = NULL WHERE id = $1", [user.id]);
    await refreshUserLang(req, user.id);
    loginAs(req, res, user, landingFor(user, returnTo));
  } catch (err) {
    console.error(err);
    res.status(500).render("login", { error: req.tr("Something went wrong. Please try again.", "Une erreur est survenue. Veuillez réessayer."), notice: null });
  }
});

router.get("/forgot-password", (req, res) => {
  res.render("forgot_password", { notice: null, error: null });
});

router.post("/forgot-password", forgotLimiter, async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const notice = req.tr("If an account exists for that email, we've sent a password reset link.", "Si un compte existe pour cette adresse e-mail, nous y avons envoyé un lien de réinitialisation du mot de passe.");

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
    return res.status(400).render("reset_password", { error: req.tr("This reset link is invalid or has expired.", "Ce lien de réinitialisation est invalide ou a expiré."), token: null });
  }
  res.render("reset_password", { error: null, token: req.params.token, confirmed: req.query.confirmed === "1" });
});

router.post("/reset-password/:token", resetLimiter, async (req, res) => {
  const newPassword = req.body.newPassword || "";
  const tokenHash = hashToken(req.params.token);
  const invalid = () =>
    res.status(400).render("reset_password", { error: req.tr("This reset link is invalid or has expired.", "Ce lien de réinitialisation est invalide ou a expiré."), token: null });

  // Cheap non-consuming look first, so a too-weak password doesn't burn
  // the link; the real gate is the atomic claim below.
  const { rows } = await pool.query(
    "SELECT 1 FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()",
    [tokenHash]
  );
  if (!rows.length) return invalid();
  const passwordError = await validateNewPassword(newPassword, req.tr);
  if (passwordError) {
    return res.status(400).render("reset_password", { error: passwordError, token: req.params.token, confirmed: req.query.confirmed === "1" });
  }

  const hash = await bcrypt.hash(newPassword, 12);
  const client = await pool.connect();
  let email;
  let returnTo;
  try {
    await client.query("BEGIN");
    // The token is the atomic gate: of any number of concurrent requests
    // with the same token, exactly one gets a row back.
    const { rows: claimed } = await client.query(
      `UPDATE password_reset_tokens SET used_at = now()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id, return_to`,
      [tokenHash]
    );
    if (!claimed.length) {
      await client.query("ROLLBACK");
      return invalid();
    }
    const userId = claimed[0].user_id;
    returnTo = safeReturnTo(claimed[0].return_to);
    // password_changed_at is what forces every other open session (this
    // reset flow isn't run from within one) to log out on its next
    // request, see attachUser in middleware/auth.js. A completed reset
    // also proves control of the inbox, so it verifies the email and
    // clears any login lockout, and retires the user's other pending links.
    const { rows: users } = await client.query(
      `UPDATE users SET password_hash = $1, password_changed_at = now(),
              email_verified_at = COALESCE(email_verified_at, now()),
              first_verification_pending = FALSE,
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
  const returnParam = returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : "";
  res.redirect(`/login?reset=${req.query.confirmed === "1" ? "confirmed" : "success"}${returnParam}`);
});

router.get("/account/password", requireAuth, (req, res) => {
  res.render("change_password", { error: null, notice: null });
});

router.post("/account/password", requireAuth, passwordChangeLimiter, async (req, res) => {
  const currentPassword = req.body.currentPassword || "";
  const newPassword = req.body.newPassword || "";

  const passwordError = await validateNewPassword(newPassword, req.tr);
  if (passwordError) {
    return res.status(400).render("change_password", { error: passwordError, notice: null });
  }

  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.session.user.id]);
  const user = rows[0];
  const ok = user && (await bcrypt.compare(currentPassword, user.password_hash));
  if (!ok) {
    return res.status(401).render("change_password", { error: req.tr("Current password is incorrect.", "Le mot de passe actuel est incorrect."), notice: null });
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
  res.render("change_password", { error: null, notice: req.tr("Password updated.", "Mot de passe mis à jour.") });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

module.exports = router;
