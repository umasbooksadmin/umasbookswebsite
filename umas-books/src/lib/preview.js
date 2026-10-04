// Preview mode: the site is shown to outsiders for feedback before it opens.
// One environment variable switches it on: PREVIEW_MODE=true (or 1). While on,
// every customer page shows a "coming soon" banner, online checkout and the
// membership payment widget are switched off, and search engines are told to
// stay away. Unset (the default) means the site behaves normally.

function isPreviewMode(env = process.env) {
  const v = String((env && env.PREVIEW_MODE) || "").trim().toLowerCase();
  return v === "1" || v === "true";
}

// Sets res.locals.preview for the views and, in preview mode, asks crawlers
// not to index anything (including static files and error pages).
function previewMiddleware(req, res, next) {
  const on = isPreviewMode();
  res.locals.preview = on;
  if (on) res.set("X-Robots-Tag", "noindex, nofollow");
  next();
}

module.exports = { isPreviewMode, previewMiddleware };
