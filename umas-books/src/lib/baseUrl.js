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
// about), and the request itself is the last-resort fallback.
function baseUrl(req) {
  return process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get("host")}`;
}

module.exports = { baseUrl };
