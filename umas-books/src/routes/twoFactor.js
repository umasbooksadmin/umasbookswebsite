// Two-step verification setup and management (TOTP). Mandatory for admins
// (see requireAdmin), optional for everyone else. The login half lives in
// routes/auth.js (/login/2fa).

const express = require("express");
const QRCode = require("qrcode");
const bcrypt = require("bcryptjs");
const { pool, withTransaction } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { limit, onlyMarkedFailures } = require("../middleware/rateLimits");
const { redirectWithFlash, takePageFlash } = require("../lib/postRedirect");
const totp = require("../lib/totp");

const router = express.Router();

// Wrong codes only (a refusal marked counted: true, lib/postRedirect.js); keyed on the account.
const codeLimiter = limit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  requestWasSuccessful: onlyMarkedFailures,
  keyGenerator: (req) => `2fa:${req.session.user.id}`,
});

const loadUser = async (id) => (await pool.query("SELECT * FROM users WHERE id = $1", [id])).rows[0];

async function renderSetup(res, user, { error = null } = {}) {
  // Reuse the pending secret so reloading the page doesn't invalidate a QR
  // code that was already scanned.
  let secret;
  if (user.totp_secret_enc && !user.totp_enabled_at) {
    secret = totp.decryptSecret(user.totp_secret_enc);
  } else {
    secret = totp.generateSecret();
    await pool.query("UPDATE users SET totp_secret_enc = $2 WHERE id = $1", [user.id, totp.encryptSecret(secret)]);
  }
  const qr = await QRCode.toDataURL(totp.otpauthUri(secret, user.email), { margin: 1, width: 220 });
  res.render("two_factor_setup", { qr, secret, error });
}

// A wrong password or code is answered by redirecting back here (lib/postRedirect.js) with the
// message: only the message travels, never a code or a password.
const backHere = (req, res, error) => redirectWithFlash(req, res, "/account/2fa", "twoFactor", { error }, { counted: true });

router.get("/account/2fa", requireAuth, async (req, res) => {
  const user = await loadUser(req.session.user.id);
  const flash = takePageFlash(req, res, "twoFactor") || {};
  if (!user.totp_enabled_at) return renderSetup(res, user, { error: flash.error || null });
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM totp_recovery_codes WHERE user_id = $1 AND used_at IS NULL", [user.id]);
  res.render("two_factor_status", { error: flash.error || null, recoveryLeft: rows[0].n, isAdmin: user.is_admin });
});

router.post("/account/2fa/enable", requireAuth, codeLimiter, async (req, res) => {
  const user = await loadUser(req.session.user.id);
  if (user.totp_enabled_at) return res.redirect("/account/2fa");
  if (!user.totp_secret_enc) return res.redirect("/account/2fa");

  // Re-prove the password: without this, anyone holding a stolen admin
  // session (or password) before the real admin enrols could enrol their
  // OWN authenticator and lock the real admin out.
  if (!(await bcrypt.compare(String(req.body.password || ""), user.password_hash))) {
    return backHere(req, res, req.tr("Your password didn't match. Enter your account password to continue.", "Votre mot de passe ne correspond pas. Saisissez le mot de passe de votre compte pour continuer."));
  }

  const step = totp.verifyTotp(totp.decryptSecret(user.totp_secret_enc), req.body.code);
  if (step == null) return backHere(req, res, req.tr("That code didn't match. Check the code in your app and try again.", "Ce code ne correspond pas. Vérifiez le code dans votre application et réessayez."));

  const codes = Array.from({ length: totp.RECOVERY_COUNT }, totp.newRecoveryCode);
  await withTransaction(pool, async (db) => {
    await db.query("UPDATE users SET totp_enabled_at = now(), totp_last_step = $2 WHERE id = $1", [user.id, step]);
    await db.query("DELETE FROM totp_recovery_codes WHERE user_id = $1", [user.id]);
    for (const c of codes) {
      await db.query("INSERT INTO totp_recovery_codes (user_id, code_hash) VALUES ($1, $2)", [user.id, totp.hashRecovery(c)]);
    }
  });
  req.session.user.totpEnabled = true;
  // Deliberately the POST's own answer, not a redirect: the recovery codes are shown ONCE and are
  // stored only as hashes, so they cannot travel through the session to a GET page (a secret must
  // not be kept there). A re-sent form is refused safely (the code was already used, or two-step is
  // already on) and ends on /account/2fa.
  res.render("two_factor_codes", { codes, isAdmin: user.is_admin });
});

// Re-issue recovery codes (old ones stop working). Needs a fresh code.
router.post("/account/2fa/recovery-codes", requireAuth, codeLimiter, async (req, res) => {
  const user = await loadUser(req.session.user.id);
  if (!user.totp_enabled_at) return res.redirect("/account/2fa");
  const step = totp.verifyTotp(totp.decryptSecret(user.totp_secret_enc), req.body.code, { lastStep: user.totp_last_step });
  if (step == null) return backHere(req, res, req.tr("That code didn't match.", "Ce code ne correspond pas."));
  const codes = Array.from({ length: totp.RECOVERY_COUNT }, totp.newRecoveryCode);
  await withTransaction(pool, async (db) => {
    await db.query("UPDATE users SET totp_last_step = $2 WHERE id = $1", [user.id, step]);
    await db.query("DELETE FROM totp_recovery_codes WHERE user_id = $1", [user.id]);
    for (const c of codes) {
      await db.query("INSERT INTO totp_recovery_codes (user_id, code_hash) VALUES ($1, $2)", [user.id, totp.hashRecovery(c)]);
    }
  });
  // Deliberately the POST's own answer, not a redirect: the recovery codes are shown ONCE and are
  // stored only as hashes, so they cannot travel through the session to a GET page (a secret must
  // not be kept there). A re-sent form is refused safely (the code was already used, or two-step is
  // already on) and ends on /account/2fa.
  res.render("two_factor_codes", { codes, isAdmin: user.is_admin });
});

// Non-admins may turn it off again (with a valid code); admins may not —
// another admin resets theirs from Members if they lose the device.
router.post("/account/2fa/disable", requireAuth, codeLimiter, async (req, res) => {
  const user = await loadUser(req.session.user.id);
  if (!user.totp_enabled_at || user.is_admin) return res.redirect("/account/2fa");
  const step = totp.verifyTotp(totp.decryptSecret(user.totp_secret_enc), req.body.code, { lastStep: user.totp_last_step });
  if (step == null) return backHere(req, res, req.tr("That code didn't match.", "Ce code ne correspond pas."));
  await withTransaction(pool, async (db) => {
    await db.query("UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = $1", [user.id]);
    await db.query("DELETE FROM totp_recovery_codes WHERE user_id = $1", [user.id]);
  });
  req.session.user.totpEnabled = false;
  res.redirect("/account/2fa");
});

module.exports = router;
