// Preview mode: the site is shown to outsiders for feedback before it opens.
// One environment variable switches it on: PREVIEW_MODE=true (or 1). While on,
// every customer page shows a "coming soon" banner, online checkout and the
// membership payment widget are switched off, and search engines are told to
// stay away. Unset (the default) means the site behaves normally.
// It does NOT touch the blog: admins create, edit, publish and delete posts and
// visitors see published ones as after launch (test/integration/blogPreviewMode.test.js).

const { usesSandbox } = require("./helloassoHosts");
const config = require("./config");
const { isStaging } = require("./staging");

function isPreviewMode(env = process.env) {
  return config.get("PREVIEW_MODE", env);
}

// Sets res.locals.preview for the views and, in preview mode, asks crawlers
// not to index anything (including static files and error pages).
function previewMiddleware(req, res, next) {
  const on = isPreviewMode();
  res.locals.preview = on;
  // Live site (preview off) still pointed at the HelloAsso sandbox: every admin
  // page shows a red banner (partials/admin_header.ejs).
  // Test system (APP_ENV=staging, lib/staging.js): banner, noindex and the
  // admin note; its HelloAsso sandbox is expected, so no "live site" warning.
  const staging = isStaging();
  res.locals.staging = staging;
  res.locals.helloassoSandbox = !on && !staging && usesSandbox(config.get("HELLOASSO_API_BASE"));
  res.locals.stagingHelloasso = staging ? (usesSandbox(config.get("HELLOASSO_API_BASE")) ? "sandbox" : "off") : "";
  res.locals.stagingMailTo = staging ? config.get("STAGING_MAIL_TO") : "";
  // Live site with a wrong setup (APP_BASE_URL missing, HelloAsso credentials
  // missing...): a persistent red banner on every admin page (lib/env.js).
  res.locals.launchAlerts = require("./env").launchBannerAlerts(process.env);
  if (on || staging) res.set("X-Robots-Tag", "noindex, nofollow");
  next();
}

// Not a live site: preview mode, or the test system. Launch guards, the
// canonical-host redirect and the base-URL rules apply to neither.
function isNonLive(env = process.env) {
  return isPreviewMode(env) || isStaging(env);
}

module.exports = { isPreviewMode, isNonLive, previewMiddleware };
