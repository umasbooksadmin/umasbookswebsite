const { pool } = require("../db");
const { generateToken, hashToken } = require("./resetTokens");
const { sendEmail } = require("./outbox");
const { emailSafeName } = require("./validation");
const { emailTr } = require("./lang");

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// Stores a fresh single-use reset token for the user and returns the raw
// value (only its hash is kept). `db` is a pool or a transaction client.
async function createResetToken(db, userId, returnTo = null) {
  const rawToken = generateToken();
  await db.query(
    "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, return_to) VALUES ($1, $2, $3, $4)",
    [userId, hashToken(rawToken), new Date(Date.now() + TOKEN_TTL_MS), returnTo]
  );
  return rawToken;
}

async function sendResetLink(user, baseUrl) {
  const rawToken = await createResetToken(pool, user.id);

  // user.lang ('en' | 'fr' | null) is the account's language; callers that
  // don't select it (e.g. admin invites) get English.
  const tr = emailTr(user.lang);
  const name = emailSafeName(user.display_name);
  const link = `${baseUrl}/reset-password/${rawToken}`;
  await sendEmail({
    kind: "password_reset",
    lang: user.lang,
    to: user.email,
    subject: tr("Reset your Uma's Books members password", "Réinitialisez votre mot de passe membre Uma's Books"),
    text: tr(
      `Hi ${name},\n\nSet a new password for your Uma's Books members account here (this link expires in 1 hour):\n${link}\n\nIf you didn't request this, you can safely ignore this email.`,
      `Bonjour ${name},\n\nChoisissez un nouveau mot de passe pour votre compte membre Uma's Books ici (ce lien expire dans 1 heure) :\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer ce message.`
    ),
  });
}

module.exports = { sendResetLink, createResetToken };
