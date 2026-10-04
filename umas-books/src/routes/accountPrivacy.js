// Members download or delete their own data (GDPR art. 15, 17 and 20):
//   GET  /account/privacy          explanation + the two forms
//   POST /account/privacy/export   JSON download of everything held about them
//   POST /account/privacy/delete   erase the account (accounting records stay, anonymised)
//   GET  /account/deleted          public goodbye page
//
// Both actions need the CURRENT password (a hijacked session must not be able
// to take the data or wipe the account). Wrong passwords count toward ONE
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

const selfAudit = (req, action, userId) =>
  audit(pool, { action, targetType: "user", targetId: userId, actorUserId: userId, actorLabel: "self", ip: req.ip });

function page(req, res, { status = 200, error = null, isAdmin = false } = {}) {
  res.set("Cache-Control", "no-store");
  return res.status(status).render("account_privacy", { error, isAdmin });
}

// The signed-in account if `currentPassword` is right, else renders the
// 401 page (counted by the limiter) and returns null.
async function checkPassword(req, res) {
  const { rows } = await pool.query(
    "SELECT id, email, display_name, lang, is_admin, password_hash FROM users WHERE id = $1",
    [req.session.user.id]
  );
  const user = rows[0];
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
  const { rows } = await pool.query("SELECT is_admin FROM users WHERE id = $1", [req.session.user.id]);
  page(req, res, { isAdmin: Boolean(rows[0] && rows[0].is_admin) });
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
