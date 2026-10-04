// Members download or delete their own data (GDPR art. 15, 17 and 20):
//   GET  /account/privacy          explanation + the two forms
//   POST /account/privacy/export   JSON download of everything held about them
//   POST /account/privacy/delete   erase the account (accounting records stay, anonymised)
//   GET  /account/deleted          public goodbye page
//
// Both actions need a VERIFIED email address (users.email_verified_at): orders,
// reservations, sign-ups and book requests are linked to a person only by
// email, and signup does not prove the address is the signer's own, so without
// this someone could register a victim's email and download or erase the
// victim's records. Unverified members are refused and see why on the page,
// with a button to resend the confirmation email
// (POST /account/privacy/resend-verification: 3 an hour per account, and not
// again within 2 minutes of the last link).
//
// Both actions also need the CURRENT password (a hijacked session must not be
// able to take the data or wipe the account). Wrong passwords count toward ONE
// per-account throttle shared by both forms: 5 per 15 minutes, like the
// password change form. Admins cannot delete themselves here.
//
// The audit log (admin_audit_log) records "member.self_export" and
// "member.self_erase" with the member's id only: actor_label is 'self', never
// an email or a name.

const express = require("express");
const bcrypt = require("bcryptjs");
const { pool } = require("../db");
const mailer = require("../mailer");
const { requireAuth } = require("../middleware/auth");
const { limit } = require("../middleware/rateLimits");
const { buildMemberExport } = require("../lib/memberExport");
const { eraseMember } = require("../lib/privacy");
const { audit } = require("../lib/audit");
const { emailTr } = require("../lib/lang");
const { emailSafeName } = require("../lib/validation");
const { sendVerificationEmail } = require("../lib/emailVerification");
const { baseUrl } = require("../lib/baseUrl");

const router = express.Router();

const MINUTE = 60 * 1000;
const SESSION_COOKIE = "umasbooks.sid";
const CONFIRM_WORDS = ["delete", "supprimer"];

const privacyLimiter = limit({
  windowMs: 15 * MINUTE,
  max: 5,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.statusCode !== 401,
  keyGenerator: (req) => `user:${req.session.user.id}`,
  handler: (req, res) =>
    res
      .status(429)
      .type("text/plain")
      .send(
        req.tr(
          "Too many wrong passwords. Please wait 15 minutes and try again, or email admin@umasbooks.org.",
          "Trop de mots de passe incorrects. Veuillez patienter 15 minutes et réessayer, ou écrire à admin@umasbooks.org."
        )
      ),
});

const resendLimiter = limit({
  windowMs: 60 * MINUTE,
  max: 3,
  keyGenerator: (req) => `user:${req.session.user.id}`,
  handler: (req, res) =>
    res
      .status(429)
      .type("text/plain")
      .send(
        req.tr(
          "Too many confirmation emails. Please wait an hour and try again, or email admin@umasbooks.org.",
          "Trop d'e-mails de confirmation. Veuillez patienter une heure et réessayer, ou écrire à admin@umasbooks.org."
        )
      ),
});
const RESEND_COOLDOWN_MINUTES = 2;

const selfAudit = (req, action, userId) =>
  audit(pool, { action, targetType: "user", targetId: userId, actorUserId: userId, actorLabel: "self", ip: req.ip });

function page(req, res, { status = 200, error = null, notice = null, isAdmin = false, emailVerified = true, email = "" } = {}) {
  res.set("Cache-Control", "no-store");
  return res.status(status).render("account_privacy", { error, notice, isAdmin, emailVerified, email });
}

// The 403 page for an unverified address. Nothing is exported or erased.
function refuseUnverified(req, res, user) {
  return page(req, res, {
    status: 403,
    isAdmin: Boolean(user.is_admin),
    emailVerified: false,
    email: user.email,
    error: req.tr(
      "Confirm your email address first. We can only give out or erase the orders, reservations, sign-ups and book requests linked to an address once it is confirmed as yours.",
      "Confirmez d'abord votre adresse e-mail. Nous ne pouvons communiquer ou effacer les commandes, réservations, inscriptions et demandes de livres liées à une adresse qu'une fois celle-ci confirmée comme étant la vôtre."
    ),
  });
}

const accountRow = async (id) =>
  (await pool.query("SELECT id, email, display_name, lang, is_admin, email_verified_at FROM users WHERE id = $1", [id])).rows[0];

// The signed-in account if `currentPassword` is right, else renders the
// 401 page (counted by the limiter) and returns null.
async function checkPassword(req, res) {
  const { rows } = await pool.query(
    "SELECT id, email, display_name, lang, is_admin, email_verified_at, password_hash FROM users WHERE id = $1",
    [req.session.user.id]
  );
  const user = rows[0];
  // Unverified: refused before the password is even looked at, so the page
  // can't be used to test passwords either.
  if (user && !user.email_verified_at) {
    refuseUnverified(req, res, user);
    return null;
  }
  const ok = user && (await bcrypt.compare(String(req.body.currentPassword || ""), user.password_hash));
  if (!ok) {
    page(req, res, {
      status: 401,
      error: req.tr("Current password is incorrect.", "Le mot de passe actuel est incorrect."),
      isAdmin: Boolean(user && user.is_admin),
    });
    return null;
  }
  return user;
}

router.get("/account/privacy", requireAuth, async (req, res) => {
  const user = await accountRow(req.session.user.id);
  const notice =
    req.query.sent === "1"
      ? req.tr(
          "We sent a new confirmation link. Check your inbox (and spam folder).",
          "Nous avons envoyé un nouveau lien de confirmation. Vérifiez votre boîte de réception (et vos courriers indésirables)."
        )
      : req.query.sent === "wait"
        ? req.tr(
            "A confirmation link was sent a moment ago. Please check your inbox (and spam folder), or try again in a couple of minutes.",
            "Un lien de confirmation vient d'être envoyé. Vérifiez votre boîte de réception (et vos courriers indésirables), ou réessayez dans quelques minutes."
          )
        : null;
  page(req, res, {
    notice,
    isAdmin: Boolean(user && user.is_admin),
    emailVerified: Boolean(user && user.email_verified_at),
    email: user ? user.email : "",
  });
});

// Sends a fresh confirmation link to the address on the account (never to an
// address from the request). One at a time: a link sent in the last 2 minutes
// is not repeated, so the button can't be used to mail-bomb someone.
router.post("/account/privacy/resend-verification", requireAuth, resendLimiter, async (req, res) => {
  const user = await accountRow(req.session.user.id);
  if (!user || user.email_verified_at) return res.redirect(303, "/account/privacy");
  const { rows } = await pool.query(
    `SELECT 1 FROM email_verification_tokens
     WHERE user_id = $1 AND created_at > now() - make_interval(mins => $2)`,
    [user.id, RESEND_COOLDOWN_MINUTES]
  );
  if (rows.length) return res.redirect(303, "/account/privacy?sent=wait");
  try {
    await sendVerificationEmail(user, baseUrl(req));
  } catch (err) {
    console.error(`Verification email failed for account ${user.id}:`, err.message);
    return page(req, res, {
      status: 500,
      isAdmin: Boolean(user.is_admin),
      emailVerified: false,
      email: user.email,
      error: req.tr("Something went wrong. Please try again.", "Une erreur est survenue. Veuillez réessayer."),
    });
  }
  res.redirect(303, "/account/privacy?sent=1");
});

router.post("/account/privacy/export", requireAuth, privacyLimiter, async (req, res) => {
  const user = await checkPassword(req, res);
  if (!user) return;
  const data = await buildMemberExport(pool, user.id);
  await selfAudit(req, "member.self_export", user.id);
  console.log(`Member ${user.id} downloaded their own data.`);
  res.set("Cache-Control", "no-store");
  res.set("Content-Disposition", 'attachment; filename="umasbooks-my-data.json"');
  res.type("application/json").send(JSON.stringify(data, null, 2));
});

function goodbyeEmail(user) {
  const tr = emailTr(user.lang);
  return {
    to: user.email,
    subject: tr("Your Uma's Books account has been deleted", "Votre compte Uma's Books a été supprimé"),
    text:
      tr(`Hi ${emailSafeName(user.display_name)},`, `Bonjour ${emailSafeName(user.display_name)},`) +
      "\n\n" +
      tr(
        "As you asked, your Uma's Books account has been deleted, along with your sign-ups and your login sessions.",
        "Comme vous l'avez demandé, votre compte Uma's Books a été supprimé, ainsi que vos inscriptions et vos sessions de connexion."
      ) +
      "\n\n" +
      tr(
        "As French law requires, accounting records of past paid orders and payments (amounts, dates and items) are kept, but anonymised: they no longer carry your name or email.",
        "Comme l'exige la loi française, les pièces comptables des commandes et paiements déjà réglés (montants, dates et articles) sont conservées, mais anonymisées : elles ne portent plus votre nom ni votre adresse e-mail."
      ) +
      "\n\n" +
      tr(
        "If you did not ask for this, please write to admin@umasbooks.org right away.",
        "Si vous n'êtes pas à l'origine de cette demande, écrivez immédiatement à admin@umasbooks.org."
      ),
  };
}

router.post("/account/privacy/delete", requireAuth, privacyLimiter, async (req, res) => {
  const user = await checkPassword(req, res);
  if (!user) return;

  if (user.is_admin) {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE is_admin");
    return page(req, res, {
      status: 403,
      isAdmin: true,
      error:
        rows[0].n <= 1
          ? req.tr(
              "This is the last administrator account, so it can't be deleted.",
              "C'est le dernier compte administrateur : il ne peut pas être supprimé."
            )
          : req.tr(
              "Administrators can't delete their own account here: ask another administrator.",
              "Les administrateurs ne peuvent pas supprimer leur propre compte ici : demandez à un autre administrateur."
            ),
    });
  }

  const word = String(req.body.confirmation || "").trim().toLowerCase();
  if (!CONFIRM_WORDS.includes(word)) {
    return page(req, res, {
      status: 400,
      error: req.tr(
        "Type DELETE in the confirmation box to delete your account.",
        "Saisissez SUPPRIMER dans la case de confirmation pour supprimer votre compte."
      ),
    });
  }

  // The email goes first: afterwards the address is gone. A failed send must
  // not stop the deletion.
  try {
    await mailer.sendMail(goodbyeEmail(user));
  } catch (err) {
    console.error(`Account deletion email failed for account ${user.id}:`, err.message);
  }

  await eraseMember(pool, user.id);
  await selfAudit(req, "member.self_erase", user.id);
  console.log(`Member ${user.id} deleted their own account.`);

  req.session.destroy(() => {
    res.clearCookie(SESSION_COOKIE);
    res.redirect(303, "/account/deleted");
  });
});

router.get("/account/deleted", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.render("account_deleted");
});

module.exports = router;
