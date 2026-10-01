const nodemailer = require("nodemailer");

const MAIL_TIMEOUT_MS = 10 * 1000;

let transporter;

function getTransporter() {
  if (transporter !== undefined) return transporter;

  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.warn("GMAIL_USER/GMAIL_APP_PASSWORD not set — email sending is disabled.");
    transporter = null;
    return transporter;
  }

  transporter = nodemailer.createTransport({
    service: "gmail",
    // Without these a stalled SMTP server holds the request (and its DB
    // connection/handler) open indefinitely.
    connectionTimeout: MAIL_TIMEOUT_MS,
    greetingTimeout: MAIL_TIMEOUT_MS,
    socketTimeout: MAIL_TIMEOUT_MS,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
  return transporter;
}

async function sendMail({ to, subject, text, replyTo }) {
  const t = getTransporter();
  if (!t) {
    console.warn("Email not configured — skipping send. Would have sent:\n", { to, subject }, "\n" + text);
    return;
  }
  await t.sendMail({
    from: `"Uma's Books" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    text,
    ...(replyTo ? { replyTo } : {}),
  });
}

module.exports = { sendMail, MAIL_TIMEOUT_MS };
