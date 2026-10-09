// Test system ("staging"): a second Render service with its own empty database,
// same code. One variable switches it on: APP_ENV=staging. Unset (production,
// local, tests) nothing in this file changes any behaviour.
//
// What staging does differently (see docs/runbook.md "Test system (staging)"):
//   - NO email reaches a real recipient: every message is redirected to the
//     single STAGING_MAIL_TO address (the original recipient is written in the
//     subject and at the top of the body), or, with STAGING_MAIL_TO unset, is
//     not sent at all (mailer.js).
//   - refuses to boot with live HelloAsso credentials (sandbox only), when
//     PRODUCTION_DATABASE_HOST is not set, or when DATABASE_URL points at the
//     production database host.
//   - banner on every page, noindex, robots.txt Disallow, empty sitemap.

function isStaging(env = process.env) {
  return String((env && env.APP_ENV) || "").trim().toLowerCase() === "staging";
}

const isSet = (env, name) => typeof env[name] === "string" && env[name].trim() !== "";

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// A message when DATABASE_URL points at the PRODUCTION database host
// (PRODUCTION_DATABASE_HOST, when set), else null. Shared by the boot guard
// above and the demo-data script (lib/demoData.js).
function productionHostProblem(env = process.env) {
  const prodHost = String(env.PRODUCTION_DATABASE_HOST || "").trim().toLowerCase();
  if (!prodHost) return null;
  const dbHost = hostOf(env.DATABASE_URL);
  // Compare on the first label too: Render shows the same database as
  // "dpg-xxxx-a" (internal) and "dpg-xxxx-a.frankfurt-postgres.render.com" (external).
  const first = (h) => h.split(".")[0];
  if (dbHost && (dbHost === prodHost || first(dbHost) === first(prodHost))) {
    return `DATABASE_URL points at the PRODUCTION database host (${prodHost}). Staging must have its own database.`;
  }
  return null;
}

// Pure: what makes a staging boot unsafe. Empty list = fine (always empty
// outside staging).
function stagingBootProblems(env = process.env) {
  if (!isStaging(env)) return [];
  const { usesSandbox } = require("./helloassoHosts");
  const problems = [];
  const hasHelloAssoCredentials = ["HELLOASSO_CLIENT_ID", "HELLOASSO_CLIENT_SECRET", "HELLOASSO_ORG_SLUG"].some((n) => isSet(env, n));
  if (hasHelloAssoCredentials && !usesSandbox(env.HELLOASSO_API_BASE)) {
    problems.push(
      "HelloAsso credentials are set but HELLOASSO_API_BASE is not the HelloAsso SANDBOX address (https://api.helloasso-sandbox.com/v5). " +
      "A staging site must never hold live HelloAsso credentials: use sandbox credentials with HELLOASSO_API_BASE=https://api.helloasso-sandbox.com/v5, or remove the HELLOASSO_* variables."
    );
  }
  // The protection against a staging site pointing at the production database
  // only works if the production host is known: make it mandatory here.
  if (!isSet(env, "PRODUCTION_DATABASE_HOST")) {
    problems.push(
      "PRODUCTION_DATABASE_HOST is not set. It is REQUIRED on a staging site: it is how the service knows DATABASE_URL must never be the production database. " +
      "Set it to the production database host name (Render > umas-books-db > Info > Hostname, the \"dpg-...\" part)."
    );
  }
  const prodProblem = productionHostProblem(env);
  if (prodProblem) problems.push(prodProblem);
  return problems;
}

// Called at the very start of index.js, migrate.js and seed.js. Fails fast with
// one clear message (injectable log/exit for tests).
function enforceStagingBoot({ env = process.env, log = console, exit = process.exit } = {}) {
  const problems = stagingBootProblems(env);
  if (problems.length === 0) return problems;
  for (const p of problems) log.error(`[staging] FATAL: ${p}`);
  log.error("[staging] Refusing to start. Fix the setting in Render > the staging service > Environment.");
  exit(1);
  return problems;
}

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The message that may actually be sent from a staging site, or null when
// nothing may be sent (STAGING_MAIL_TO unset). Pure.
function stagingMail(mail, env = process.env) {
  const to = String(env.STAGING_MAIL_TO || "").trim();
  if (!to) return null;
  const original = Array.isArray(mail.to) ? mail.to.join(", ") : String(mail.to || "");
  const header = `[TEST SITE] This email was addressed to: ${original}${mail.replyTo ? ` (reply-to: ${mail.replyTo})` : ""}`;
  return {
    to,
    subject: `[STAGING] ${mail.subject || ""} (to: ${original})`,
    text: `${header}\n----------------------------------------\n\n${mail.text || ""}`,
    ...(mail.html ? { html: `<p style="background:#fff3cd;padding:8px;border:1px solid #e0c36a"><strong>${escapeHtml(header)}</strong></p>${mail.html}` } : {}),
    // Reply-To is dropped on purpose: a reply must never reach a real person.
    ...(mail.headers && Object.keys(mail.headers).length ? { headers: mail.headers } : {}),
  };
}

module.exports = { isStaging, hostOf, productionHostProblem, stagingBootProblems, enforceStagingBoot, stagingMail };
