const config = require("./config");
const { isNonLive } = require("./preview");

// The app's own public base URL — needed only where an *absolute* URL is
// unavoidable (HelloAsso return/webhook URLs, and JSON API responses meant
// to be usable by a consumer on a different origin than this app, e.g. a
// marketing site fetching /api/books/new-in cross-origin). Never
// hardcode the hostname instead of using this — that's exactly what broke
// when this app moved to a new Render service with a different URL.
//
// RENDER_EXTERNAL_URL is set automatically by Render on every service, so
// this needs no configuration there; APP_BASE_URL is an escape hatch for
// running outside Render (or behind a custom domain Render doesn't know
// about). The request's own Host header is a last-resort fallback for
// local dev only — trusting it in production would let a spoofed Host
// header (nothing here verifies it came through Render's own proxy)
// steer an absolute URL, including a password-reset link, at an
// attacker's domain instead of this app's real one.
//
// Once the site is live (production, preview mode off) ONLY APP_BASE_URL
// counts: RENDER_EXTERNAL_URL is the *.onrender.com address, which must never
// end up in a member's email or a payment return URL. Missing = loud error
// (and checkEnv already warned and emailed the admin at boot).
function isLive(env = process.env) {
  return config.isProduction(env) && !isNonLive(env);
}

// The configured public base URL without a trailing slash, or "" when there
// is none (never throws): for emails and other places that can degrade.
function configuredBaseUrl(env = process.env) {
  const configured = isLive(env) ? config.get("APP_BASE_URL", env) : config.get("APP_BASE_URL", env) || config.get("RENDER_EXTERNAL_URL", env);
  return String(configured || "").trim().replace(/\/+$/, "");
}

function baseUrl(req) {
  if (isLive()) {
    if (config.get("APP_BASE_URL")) return configuredBaseUrl();
    console.error("[baseUrl] APP_BASE_URL is not set on a live site - refusing to fall back to RENDER_EXTERNAL_URL or the Host header.");
    throw new Error("APP_BASE_URL must be set on a live site (preview mode off) - refusing to build an absolute URL from RENDER_EXTERNAL_URL or the request's Host header.");
  }
  const configured = config.get("APP_BASE_URL") || config.get("RENDER_EXTERNAL_URL");
  if (configured) return configured;
  if (config.isProduction()) {
    throw new Error("APP_BASE_URL or RENDER_EXTERNAL_URL must be set in production — refusing to build an absolute URL from the request's Host header.");
  }
  return `${req.protocol}://${req.get("host")}`;
}

// APP_BASE_URL, else RENDER_EXTERNAL_URL, else "", without one trailing slash: what the emails, sweeps and
// alerts print. Looser than configuredBaseUrl on purpose (it also accepts RENDER_EXTERNAL_URL on a live site).
function looseBaseUrl(env = process.env) {
  return (config.get("APP_BASE_URL", env) || config.get("RENDER_EXTERNAL_URL", env) || "").replace(/\/$/, "");
}

module.exports = { baseUrl, configuredBaseUrl, isLive, looseBaseUrl };
