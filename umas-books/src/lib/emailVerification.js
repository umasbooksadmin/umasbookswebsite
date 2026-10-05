const { pool } = require("../db");
const { generateToken, hashToken } = require("./resetTokens");
const { sendMail } = require("../mailer");
const { emailSafeName } = require("./validation");
const { emailTr } = require("./lang");
const { safeReturnTo } = require("./returnTo");

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// choosePassword: true for a new signup, whose link leads to "choose your
// password" (it has none yet); false for a plain address confirmation.
async function sendVerificationEmail(user, baseUrl, { choosePassword = false, returnTo = null, membership = false } = {}) {
  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await pool.query(
    "INSERT INTO email_verification_tokens (user_id, token_hash, expires_at, return_to) VALUES ($1, $2, $3, $4)",
    [user.id, tokenHash, expiresAt, safeReturnTo(returnTo)]
  );

  const link = `${baseUrl}/verify-email/${rawToken}`;
  // The account's stored language (users.lang; set from the person's choice
  // at signup), English when unknown.
  // Callers that only have id/email/name (admin email change) don't carry the
  // language: look it up.
  let lang = user.lang;
  if (lang === undefined) {
    const { rows } = await pool.query("SELECT lang FROM users WHERE id = $1", [user.id]);
    lang = rows[0] && rows[0].lang;
  }
  const tr = emailTr(lang);
  const name = emailSafeName(user.display_name);
  // A membership sign-up pays first and confirms after: say what the link is for.
  const memberLine = membership
    ? tr(
        "You started becoming a member: your membership is attached to your account as soon as you confirm, once your payment has gone through.\n\n",
        "Vous avez commencé votre adhésion : elle est rattachée à votre compte dès que vous confirmez, une fois votre paiement effectué.\n\n"
      )
    : "";
  const text = choosePassword
    ? tr(
        `Hi ${name},\n\n${memberLine}Click the link below to confirm your email address and choose your password (this link expires in 24 hours):\n${link}\n\nIf you didn't create an account at Uma's Books, you can safely ignore this email.`,
        `Bonjour ${name},\n\n${memberLine}Cliquez sur le lien ci-dessous pour confirmer votre adresse e-mail et choisir votre mot de passe (ce lien expire dans 24 heures) :\n${link}\n\nSi vous n'avez pas créé de compte sur Uma's Books, vous pouvez ignorer ce message.`
      )
    : tr(
        `Hi ${name},\n\nConfirm this is your email address (this link expires in 24 hours):\n${link}\n\nIf you didn't create an account at Uma's Books, you can safely ignore this email.`,
        `Bonjour ${name},\n\nVeuillez confirmer qu'il s'agit bien de votre adresse e-mail (ce lien expire dans 24 heures) :\n${link}\n\nSi vous n'avez pas créé de compte sur Uma's Books, vous pouvez ignorer ce message.`
      );
  await sendMail({
    to: user.email,
    subject: membership
      ? tr("Confirm your email to finish becoming a member of Uma's Books", "Confirmez votre adresse e-mail pour finaliser votre adhésion à Uma's Books")
      : choosePassword
      ? tr("Confirm your email and choose your password for Uma's Books", "Confirmez votre adresse e-mail et choisissez votre mot de passe pour Uma's Books")
      : tr("Confirm your email for Uma's Books", "Confirmez votre adresse e-mail pour Uma's Books"),
    text,
  });
}

// Sent instead of a verification link when someone signs up with an
// address that already has an account, so signup's HTTP response can be
// identical either way while the real owner still learns about it.
async function sendSignupAttemptEmail(user, baseUrl) {
  const tr = emailTr(user.lang);
  const name = emailSafeName(user.display_name);
  await sendMail({
    to: user.email,
    subject: tr("Someone tried to sign up with your email at Uma's Books", "Quelqu'un a tenté de s'inscrire avec votre adresse e-mail sur Uma's Books"),
    text: tr(
      `Hi ${name},\n\nSomeone just tried to create a new Uma's Books account with this email address, but you already have one.\n\nIf it was you, log in at ${baseUrl}/login, or reset your password at ${baseUrl}/forgot-password.\n\nIf it wasn't you, you can safely ignore this email.`,
      `Bonjour ${name},\n\nQuelqu'un vient d'essayer de créer un compte Uma's Books avec cette adresse e-mail, mais vous en avez déjà un.\n\nSi c'était vous, connectez-vous sur ${baseUrl}/login ou réinitialisez votre mot de passe sur ${baseUrl}/forgot-password.\n\nSi ce n'était pas vous, vous pouvez ignorer ce message.`
    ),
  });
}

module.exports = { sendVerificationEmail, sendSignupAttemptEmail };
