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
const { isNonLive } = require("./preview");
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
  if (!isNonLive(env) && (!isSet(env, "GMAIL_USER") || !isSet(env, "GMAIL_APP_PASSWORD"))) {
    warnings.push("Gmail is not configured and preview mode is off - error alerts to the admin are DISABLED on a live site. Set GMAIL_USER and GMAIL_APP_PASSWORD.");
  }
  // Launch guards (preview OFF = the site is live): things that are harmless
  // while the site is a preview but wrong for real members and real payments.
  // None of them stops the boot (a crash would take the whole site down);
  // each is a loud log line plus, for the serious ones, ONE alert email per
  // boot (src/index.js sends `alerts` once the server is listening).
  const alerts = [];
  if (isNonLive(env)) {
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
      alerts.push({ label: "HelloAsso is still in SANDBOX mode: real membership payments will not work", message: msg, code: "sandbox" });
    }
    const missingHa = OPTIONAL_GROUPS[1].vars.filter((name) => !isSet(env, name));
    if (missingHa.length > 0) {
      const msg = `${missingHa.join(", ")} not set and preview mode is off - online membership payment and its reconciliation do not work on the live site.`;
      alerts.push({ label: "HelloAsso credentials missing: membership payments are disabled", message: msg });
    }
    if (!isSet(env, "ALERT_TO")) {
      warnings.push("ALERT_TO is not set and preview mode is off - error alerts go to CONTACT_TO or the built-in default address (admin@umasbooks.org). Set ALERT_TO to one or more addresses (comma separated), ideally one on a different mail provider than the Gmail account that sends the alerts.");
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

// Sends each launch-guard alert (`send` is alertOnError in production, with
// force: never swallowed by the error-alert throttle; injectable for tests).
// With a `pool`, each alert is emailed at most once per 24 hours (lib/alertFlags.js,
// table alert_flags): without that, every deploy or restart of a misconfigured
// live site sent up to three emails again. The problem stays visible meanwhile as
// a persistent red banner on every admin page (launchBannerAlerts below).
// Without a pool (unit tests) every alert is sent, once.
const LAUNCH_ALERT_EVERY_MINUTES = 24 * 60;
async function sendLaunchAlerts(alerts, send, pool) {
  for (const a of alerts || []) {
    if (!pool) {
      send(a.label, a.message, { force: true });
      continue;
    }
    const { claimAlertSlot, releaseAlertSlot } = require("./alertFlags");
    const key = `launch:${a.label}`.slice(0, 120);
    let claimed;
    try {
      claimed = await claimAlertSlot(pool, key, LAUNCH_ALERT_EVERY_MINUTES);
    } catch (err) {
      console.error("Launch alert throttle unavailable (sending anyway):", err.message);
      claimed = true; // a duplicate email beats a silent misconfiguration
    }
    if (!claimed) continue;
    const ok = await send(a.label, a.message, { force: true });
    if (ok === false) await releaseAlertSlot(pool, key).catch(() => {});
  }
}

// What the red banner on every admin page lists: the live-site misconfigurations
// that also raise a launch alert, as they are RIGHT NOW (re-read from the
// environment, so the banner disappears once it is fixed and the service
// restarted). Production only. The HelloAsso sandbox problem has its own banner.
function launchBannerAlerts(env = process.env) {
  if (env.NODE_ENV !== "production") return [];
  return validateEnv(env).alerts.filter((a) => a.code !== "sandbox").map((a) => ({ label: a.label, message: a.message }));
}

module.exports = { sendLaunchAlerts, launchBannerAlerts, LAUNCH_ALERT_EVERY_MINUTES, validateEnv, checkEnv, REQUIRED, OPTIONAL_GROUPS };
