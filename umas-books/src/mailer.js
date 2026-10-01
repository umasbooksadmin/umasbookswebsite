const nodemailer = require("nodemailer");
const { isEmail } = require("./lib/validation");

const MAIL_TIMEOUT_MS = 10 * 1000;
const BRAND = "Uma's Books";

const has = (env, name) => typeof env[name] === "string" && env[name].trim() !== "";

// Without these a stalled SMTP server holds the request (and its DB
// connection/handler) open indefinitely. Applied to every transport.
const TIMEOUTS = {
  connectionTimeout: MAIL_TIMEOUT_MS,
  greetingTimeout: MAIL_TIMEOUT_MS,
  socketTimeout: MAIL_TIMEOUT_MS,
};

// Pure: which transport the environment selects. Precedence:
//   1. SMTP_HOST            -> generic SMTP (Brevo etc.)
//   2. GMAIL_USER + _APP_PASSWORD -> Gmail (the original setup)
//   3. nothing              -> console (mail is logged, not sent)
// Returns { kind, options } where options is the nodemailer config, or null.
// `options` contains credentials, so only describeMailConfig() output is
// safe to print.
function buildTransportConfig(env = process.env) {
  if (has(env, "SMTP_HOST")) {
    const port = parseInt(env.SMTP_PORT, 10);
    const options = {
      host: env.SMTP_HOST.trim(),
      port: Number.isInteger(port) && port > 0 ? port : 587,
      // false => STARTTLS upgrade on 587; true => implicit TLS (port 465).
      secure: String(env.SMTP_SECURE || "").trim().toLowerCase() === "true",
      ...TIMEOUTS,
    };
    if (has(env, "SMTP_USER") || has(env, "SMTP_PASS")) {
      options.auth = { user: env.SMTP_USER || "", pass: env.SMTP_PASS || "" };
    }
    return { kind: "smtp", options };
  }
  if (has(env, "GMAIL_USER") && has(env, "GMAIL_APP_PASSWORD")) {
    return {
      kind: "gmail",
      options: {
        service: "gmail",
        ...TIMEOUTS,
        auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD },
      },
    };
  }
  return { kind: "console", options: null };
}

// Pure: the From header for all outgoing mail. MAIL_FROM wins (ignored if it
// contains line breaks, which would allow header injection); otherwise the
// mailbox we authenticate as.
function resolveFrom(env = process.env) {
  if (has(env, "MAIL_FROM") && !/[\r\n]/.test(env.MAIL_FROM)) return env.MAIL_FROM.trim();
  if (has(env, "SMTP_HOST")) {
    if (has(env, "SMTP_USER") && isEmail(env.SMTP_USER.trim())) return `"${BRAND}" <${env.SMTP_USER.trim()}>`;
  } else if (has(env, "GMAIL_USER") && isEmail(env.GMAIL_USER.trim())) {
    return `"${BRAND}" <${env.GMAIL_USER.trim()}>`;
  }
  return `"${BRAND}" <admin@umasbooks.org>`;
}

// Pure, credential-free summary, safe to log.
function describeMailConfig(env = process.env) {
  const { kind, options } = buildTransportConfig(env);
  const out = { kind, enabled: kind !== "console", from: resolveFrom(env) };
  if (kind === "smtp") Object.assign(out, { host: options.host, port: options.port, secure: options.secure });
  return out;
}

let transporter;

function getTransporter() {
  if (transporter !== undefined) return transporter;
  const { options } = buildTransportConfig(process.env);
  if (!options) {
    console.warn("Neither SMTP_HOST nor GMAIL_USER/GMAIL_APP_PASSWORD set — email sending is disabled.");
    transporter = null;
    return transporter;
  }
  console.log("[mail]", JSON.stringify(describeMailConfig(process.env)));
  transporter = nodemailer.createTransport(options);
  return transporter;
}

// Callers cannot choose `from` (it is never read), and `to` must be exactly
// one plain address, so no caller can turn this into a header-injection or
// multi-recipient relay.
async function sendMail({ to, subject, text, replyTo }) {
  if (!isEmail(to)) throw new Error("sendMail: `to` must be a single email address");
  const t = getTransporter();
  if (!t) {
    console.warn("Email not configured — skipping send. Would have sent:\n", { to, subject }, "\n" + text);
    return;
  }
  await t.sendMail({
    from: resolveFrom(process.env),
    to,
    subject,
    text,
    ...(replyTo ? { replyTo } : {}),
  });
}

// Test hook: forget the cached transport so the next send re-reads env.
function _resetForTests() {
  transporter = undefined;
}

module.exports = { sendMail, MAIL_TIMEOUT_MS, buildTransportConfig, describeMailConfig, resolveFrom, _resetForTests };
