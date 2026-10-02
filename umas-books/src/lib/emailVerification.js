const { pool } = require("../db");
const { generateToken, hashToken } = require("./resetTokens");
const { sendMail } = require("../mailer");
const { emailSafeName } = require("./validation");

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function sendVerificationEmail(user, baseUrl) {
  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await pool.query(
    "INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
    [user.id, tokenHash, expiresAt]
  );

  const link = `${baseUrl}/verify-email/${rawToken}`;
  await sendMail({
    to: user.email,
    subject: "Confirm your email for Uma's Books",
    text: `Hi ${emailSafeName(user.display_name)},\n\nConfirm this is your email address (this link expires in 24 hours):\n${link}\n\nIf you didn't create an account at Uma's Books, you can safely ignore this email.`,
  });
}

// Sent instead of a verification link when someone signs up with an
// address that already has an account, so signup's HTTP response can be
// identical either way while the real owner still learns about it.
async function sendSignupAttemptEmail(user, baseUrl) {
  await sendMail({
    to: user.email,
    subject: "Someone tried to sign up with your email at Uma's Books",
    text: `Hi ${emailSafeName(user.display_name)},\n\nSomeone just tried to create a new Uma's Books account with this email address, but you already have one.\n\nIf it was you, log in at ${baseUrl}/login, or reset your password at ${baseUrl}/forgot-password.\n\nIf it wasn't you, you can safely ignore this email.`,
  });
}

module.exports = { sendVerificationEmail, sendSignupAttemptEmail };
