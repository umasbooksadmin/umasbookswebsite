// Startup environment validation. Called once, very early in src/index.js
// (before db.js is required, since db.js throws its own, less helpful,
// one-variable error), and only when NODE_ENV=production — tests and local
// dev are deliberately untouched.
//
// Two tiers:
//   REQUIRED  - the app cannot work without these; boot fails fast and the
//               message lists ALL missing ones at once (so a misconfigured
//               deploy is fixed in one pass, not one variable per restart).
//   OPTIONAL_GROUPS - the app still boots, but a feature silently turns
//               itself off when any variable in the group is missing. That
//               is easy to miss in production (e.g. no Gmail credentials
//               also means no error-alert emails), so it gets a loud log.
//
// TOTP_ENCRYPTION_KEY is required here (production only) because lib/totp.js
// otherwise falls back to deriving the key from SESSION_SECRET, which would
// silently re-key every admin's two-step secret if SESSION_SECRET is ever
// rotated. Outside production that fallback is kept for convenience.
const { isPreviewMode } = require("./preview");
const { usesSandbox } = require("./helloassoHosts");
const REQUIRED = ["DATABASE_URL", "SESSION_SECRET", "TOTP_ENCRYPTION_KEY"];

const OPTIONAL_GROUPS = [
  {
    vars: ["GMAIL_USER", "GMAIL_APP_PASSWORD"],
    consequence:
      "ALL outgoing email is disabled (password resets, email verification, contact form, pickup reminders and the admin error alerts themselves)",
  },
  {
    vars: ["HELLOASSO_CLIENT_ID", "HELLOASSO_CLIENT_SECRET", "HELLOASSO_ORG_SLUG"],
    consequence: "online MEMBERSHIP payment cannot be reconciled (books and drop-in seats are reserved online and paid in the shop, so they are not affected)",
  },
];

const isSet = (env, name) => typeof env[name] === "string" && env[name].trim() !== "";

// Pure: returns what is wrong, does no logging or exiting.
function validateEnv(env = process.env) {
  const missing = REQUIRED.filter((name) => !isSet(env, name));
  const warnings = [];
  for (const { vars, consequence } of OPTIONAL_GROUPS) {
    const unset = vars.filter((name) => !isSet(env, name));
    if (unset.length > 0) warnings.push(`${unset.join(", ")} not set - ${consequence}.`);
  }
  // Error alerts ride on the Gmail credentials; the OPTIONAL_GROUPS warning
  // above already says so. This one is stronger: a live site (not preview)
  // that cannot email anyone about its own failures.
  if (!isPreviewMode(env) && (!isSet(env, "GMAIL_USER") || !isSet(env, "GMAIL_APP_PASSWORD"))) {
    warnings.push("Gmail is not configured and preview mode is off - error alerts to the admin are DISABLED on a live site. Set GMAIL_USER and GMAIL_APP_PASSWORD.");
  }
  // Launch guards (preview OFF = the site is live): things that are harmless
  // while the site is a preview but wrong for real members and real payments.
  // None of them stops the boot (a crash would take the whole site down);
  // each is a loud log line plus, for the serious ones, ONE alert email per
  // boot (src/index.js sends `alerts` once the server is listening).
  const alerts = [];
  if (isPreviewMode(env)) {
    if (!isSet(env, "APP_BASE_URL") && !isSet(env, "RENDER_EXTERNAL_URL")) {
      warnings.push("APP_BASE_URL / RENDER_EXTERNAL_URL not set - emailed links will fail in production.");
    }
  } else {
    const base = isSet(env, "APP_BASE_URL") ? env.APP_BASE_URL.trim() : "";
    if (!base) {
      const msg = "APP_BASE_URL is not set and preview mode is off - emailed links have no canonical address (RENDER_EXTERNAL_URL is deliberately NOT used on a live site). Set APP_BASE_URL=https://umasbooks.org in Render > Environment.";
      warnings.push(msg);
      alerts.push({ label: "APP_BASE_URL missing", message: msg });
    } else if (!/^https:\/\/[^/\s]+/i.test(base)) {
      const msg = `APP_BASE_URL is ${base}, which is not an https:// address - emailed links must be https on a live site.`;
      warnings.push(msg);
      alerts.push({ label: "APP_BASE_URL missing (not https)", message: msg });
    }
    if (usesSandbox(env.HELLOASSO_API_BASE)) {
      const msg = "HelloAsso is still in SANDBOX mode: real membership payments will not work. HELLOASSO_API_BASE points at the HelloAsso sandbox while preview mode is off. Remove it (or set the production API base) and use the production HelloAsso credentials in Render > Environment.";
      warnings.push(msg);
      alerts.push({ label: "HelloAsso is still in SANDBOX mode: real membership payments will not work", message: msg });
    }
    const missingHa = OPTIONAL_GROUPS[1].vars.filter((name) => !isSet(env, name));
    if (missingHa.length > 0) {
      const msg = `${missingHa.join(", ")} not set and preview mode is off - online membership payment and its reconciliation do not work on the live site.`;
      alerts.push({ label: "HelloAsso credentials missing: membership payments are disabled", message: msg });
    }
    if (!isSet(env, "CONTACT_TO")) {
      warnings.push("CONTACT_TO is not set and preview mode is off - contact-form messages and error alerts go to the built-in default address (admin@umasbooks.org). Set CONTACT_TO if that is not the right inbox.");
    }
  }
  return { missing, warnings, alerts };
}

// Production only. Logs warnings; on missing required vars logs one clear
// error and exits 1 (via the injectable `exit`, so it is unit-testable).
function checkEnv({ env = process.env, log = console, exit = process.exit } = {}) {
  if (env.NODE_ENV !== "production") return { missing: [], warnings: [], alerts: [] };
  const result = validateEnv(env);
  for (const w of result.warnings) log.warn(`[env] WARNING: ${w}`);
  if (result.missing.length > 0) {
    log.error(`[env] FATAL: missing required environment variable(s): ${result.missing.join(", ")}. Set them (Render: service > Environment) and restart.`);
    exit(1);
  }
  return result;
}

// Sends each launch-guard alert once. `send` is alertOnError in production
// (force: never swallowed by the error-alert throttle); injectable for tests.
function sendLaunchAlerts(alerts, send) {
  for (const a of alerts || []) send(a.label, a.message, { force: true });
}

module.exports = { sendLaunchAlerts, validateEnv, checkEnv, REQUIRED, OPTIONAL_GROUPS };
