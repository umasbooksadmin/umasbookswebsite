// "Where to go after logging in": a same-origin, path-only destination.
// Anything else (absolute URLs, "//host", "/\host", control characters,
// non-strings, very long values) is rejected so it can never become an open
// redirect. Used by the login/signup/confirm/choose-password flow.
const SAFE_RE = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#]*$/;

function safeReturnTo(value) {
  if (typeof value !== "string" || value.length > 200) return null;
  if (!SAFE_RE.test(value)) return null;
  if (value.startsWith("//") || value.includes("\\") || /%5c/i.test(value)) return null;
  return value;
}

// The cart is the one destination the site itself sends people to.
const CART_RETURN = "/cart";

module.exports = { safeReturnTo, CART_RETURN };
