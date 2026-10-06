// The Content-Security-Policy for the marketing pages (views/marketing/*.ejs).
// These pages share an origin with /admin, so a script injected into one of them
// would run with an admin's session: script-src therefore has NO 'unsafe-inline'.
// The pages carry no inline scripts: their strings are a JSON data block
// (<script type="application/json">, never executed) read by public/page-i18n.js,
// and the per-page code lives in public/page-*.js. script-src-attr 'none' also
// forbids onclick="" style attributes. Style stays 'unsafe-inline' (style
// attributes in the markup). Kept here so a test can read the exact string.
//
// img-src: only our own origin (and data: URIs). Book covers are copied to our
// server (lib/coverStore.js), so no page loads an image from Open Library or
// the Internet Archive and those hosts never see a visitor's IP address.
//
// frame-src: the HelloAsso membership form, which is only created after the
// visitor clicks "Show the HelloAsso form" (assets/membership-widget.js).
// The payment hub loads inside that frame, not in our page.

function buildMarketingCsp(formActionSources) {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    `form-action ${formActionSources.join(" ")}`,
    "frame-ancestors 'none'",
    "frame-src https://www.helloasso.com",
  ].join("; ");
}

// The same policy the marketing GET routes in src/index.js send, for the
// responses of the marketing forms' POST routes (routes/marketingForms.js).
function marketingCsp() {
  return buildMarketingCsp(["'self'", ...require("./helloassoHosts").helloassoPaymentOrigins()]);
}

module.exports = { buildMarketingCsp, marketingCsp };
