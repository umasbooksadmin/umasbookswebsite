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

async function sendMail({ to, subject, text, html, replyTo, headers }) {
  const t = getTransporter();
  if (!t) {
    // The body of a reset or verification mail is a live login link, so in
    // production (where this only happens by misconfiguration) the logs get
    // the recipient and subject only.
    if (process.env.NODE_ENV === "production") {
      console.warn("Email not configured — skipping send. Would have sent:", { to, subject });
    } else {
      console.warn("Email not configured — skipping send. Would have sent:\n", { to, subject }, "\n" + text);
    }
    return;
  }
  await t.sendMail({
    from: `"Uma's Books" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    text,
    ...(html ? { html } : {}),
    ...(headers && Object.keys(headers).length ? { headers } : {}),
    ...(replyTo ? { replyTo } : {}),
  });
}

module.exports = { sendMail, MAIL_TIMEOUT_MS };
