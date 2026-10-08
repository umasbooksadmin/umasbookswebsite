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

async function sendMail(mail) {
  // Staging (APP_ENV=staging, lib/staging.js): never reaches a real recipient.
  // This is the single choke point: the outbox, the sweeps, the alerts and the
  // privacy mails all send through here.
  const staging = require("./lib/staging");
  if (staging.isStaging()) {
    const redirected = staging.stagingMail(mail);
    if (!redirected) {
      console.warn("[staging] STAGING_MAIL_TO is not set - email NOT sent:", { to: mail.to, subject: mail.subject });
      return;
    }
    mail = redirected;
  }
  const { to, subject, text, html, replyTo, headers } = mail;
  const t = getTransporter();
  if (!t) {
    // PRODUCTION: refuse. Returning quietly here made the email outbox mark the
    // row "sent" (and blank a login link's body) although nothing left the
    // server. Throwing makes the outbox keep and retry the message, and the
    // dashboard / failure alert show it. Only the recipient and subject are
    // logged: the body of a reset or verification mail is a live login link.
    if (process.env.NODE_ENV === "production") {
      console.error("Email not configured (GMAIL_USER / GMAIL_APP_PASSWORD) - NOT sent:", { to, subject });
      throw new Error("Email is not configured on this server (GMAIL_USER / GMAIL_APP_PASSWORD are not set).");
    }
    // Tests and local development: log only, so nothing needs credentials.
    console.warn("Email not configured — skipping send. Would have sent:\n", { to, subject }, "\n" + text);
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

const isMailConfigured = () => Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);

module.exports = { sendMail, isMailConfigured, MAIL_TIMEOUT_MS };
