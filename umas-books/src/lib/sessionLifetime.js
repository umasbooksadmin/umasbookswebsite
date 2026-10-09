// How long a session (cookie AND the `session` table row) lives.
//
// Before: every session, including the empty ones a cookie-less visitor or bot
// gets just by loading a page with a form (the CSRF token is created while the
// form renders), lived 30 days. A script loading /login 100 times a second
// could therefore add ~2 GB a day of rows nothing pruned for a month.
//
// Now the lifetime depends on what the session holds:
//   logged in (customer, member, volunteer, admin, till)   30 days (unchanged;
//       admins/till additionally have the 8 h idle / 7 day absolute limits of
//       lib/adminSession.js, enforced per request)
//   guest with something in the cart                       24 hours
//   any other guest session (CSRF token, flash message,
//       half-finished login or two-step code)              2 hours
// The cart is the only guest state worth keeping longer: a cart is a list of
// lines in the session (routes/cart.js) and nothing is held in the database
// until the person logs in and reserves. 24 h lets someone fill a cart in the
// evening and finish the next day; a guest cart older than that is rebuilt in
// a minute. Everything else a guest session holds is gone within minutes.
//
// express-session stores `cookie.expires` as the row's expiry (connect-pg-simple
// reads it) and Cookie.touch() resets it from `originalMaxAge`, so both are set.
const HOUR = 60 * 60 * 1000;
const LOGGED_IN_MAX_AGE_MS = 30 * 24 * HOUR;
const GUEST_CART_MAX_AGE_MS = 24 * HOUR;
const GUEST_MAX_AGE_MS = 2 * HOUR;

function lifetimeFor(session) {
  if (session && session.user) return LOGGED_IN_MAX_AGE_MS;
  if (session && Array.isArray(session.cart) && session.cart.length > 0) return GUEST_CART_MAX_AGE_MS;
  return GUEST_MAX_AGE_MS;
}

// Sets the session's cookie lifetime from what it holds right now. Returns the
// lifetime in ms. Does not count as a session modification (express-session
// hashes the session without its cookie), so it never causes a write by itself.
function applyLifetime(session) {
  if (!session || !session.cookie) return null;
  const ms = lifetimeFor(session);
  session.cookie.originalMaxAge = ms;
  session.cookie.maxAge = ms;
  return ms;
}

// Runs right after the session middleware: just before the response headers go
// out (express-session's own Set-Cookie hook is registered earlier, so this
// wrapper runs first) the lifetime is brought in line with the session's content.
function sessionLifetime(req, res, next) {
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    applyLifetime(req.session);
    return writeHead.apply(this, args);
  };
  next();
}

module.exports = {
  lifetimeFor, applyLifetime, sessionLifetime,
  LOGGED_IN_MAX_AGE_MS, GUEST_CART_MAX_AGE_MS, GUEST_MAX_AGE_MS,
};
