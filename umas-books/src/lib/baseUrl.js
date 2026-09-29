// The app's own public base URL — needed only where an *absolute* URL is
// unavoidable (HelloAsso return/webhook URLs, and JSON API responses meant
// to be usable by a consumer on a different origin than this app, e.g. a
// marketing site fetching /api/books/latest-arrivals cross-origin). Never
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
function baseUrl(req) {
  const configured = process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("APP_BASE_URL or RENDER_EXTERNAL_URL must be set in production — refusing to build an absolute URL from the request's Host header.");
  }
  return `${req.protocol}://${req.get("host")}`;
}

module.exports = { baseUrl };
