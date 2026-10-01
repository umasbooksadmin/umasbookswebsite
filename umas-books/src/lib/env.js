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
const REQUIRED = ["DATABASE_URL", "SESSION_SECRET"];

const OPTIONAL_GROUPS = [
  {
    vars: ["GMAIL_USER", "GMAIL_APP_PASSWORD"],
    consequence:
      "ALL outgoing email is disabled (password resets, email verification, contact form, pickup reminders and the admin error alerts themselves)",
  },
  {
    vars: ["HELLOASSO_CLIENT_ID", "HELLOASSO_CLIENT_SECRET", "HELLOASSO_ORG_SLUG"],
    consequence: "online payment is disabled (checkout shows \"not set up yet\" and memberships cannot be reconciled)",
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
  if (!isSet(env, "APP_BASE_URL") && !isSet(env, "RENDER_EXTERNAL_URL")) {
    warnings.push("APP_BASE_URL / RENDER_EXTERNAL_URL not set - emailed links and payment return URLs will fail in production.");
  }
  return { missing, warnings };
}

// Production only. Logs warnings; on missing required vars logs one clear
// error and exits 1 (via the injectable `exit`, so it is unit-testable).
function checkEnv({ env = process.env, log = console, exit = process.exit } = {}) {
  if (env.NODE_ENV !== "production") return { missing: [], warnings: [] };
  const result = validateEnv(env);
  for (const w of result.warnings) log.warn(`[env] WARNING: ${w}`);
  if (result.missing.length > 0) {
    log.error(`[env] FATAL: missing required environment variable(s): ${result.missing.join(", ")}. Set them (Render: service > Environment) and restart.`);
    exit(1);
  }
  return result;
}

module.exports = { validateEnv, checkEnv, REQUIRED, OPTIONAL_GROUPS };
