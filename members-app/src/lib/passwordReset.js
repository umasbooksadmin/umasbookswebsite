const { pool } = require("../db");
const { generateToken, hashToken } = require("./resetTokens");
const { sendMail } = require("../mailer");

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

async function sendResetLink(user, baseUrl) {
  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await pool.query(
    "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
    [user.id, tokenHash, expiresAt]
  );

  const link = `${baseUrl}/reset-password/${rawToken}`;
  await sendMail({
    to: user.email,
    subject: "Reset your Uma's Books members password",
    text: `Hi ${user.display_name},\n\nSet a new password for your Uma's Books members account here (this link expires in 1 hour):\n${link}\n\nIf you didn't request this, you can safely ignore this email.`,
  });
}

module.exports = { sendResetLink };
