// Pages rendered for a logged-in user carry their name, orders, admin
// data... With no Cache-Control a browser or shared proxy is free to
// heuristically cache them, and the Back button after logout can show the
// previous user's page. So everything answered to a logged-in user is
// `no-store`, except /img/ (cover/photo bytes, identical for everyone and
// meant to be cached). Static assets are mounted before the session and
// never reach this middleware; anonymous marketing pages keep whatever
// caching their routes set.
//
// The header is applied in writeHead (overriding a route's own
// `public, max-age=...`) because those routes would otherwise win: they
// set their header after this middleware has run.
//
// Must run after attachUser, which is what sets res.locals.user.
function noStoreForUsers(req, res, next) {
  if (res.locals.user && !req.path.startsWith("/img/")) {
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      this.setHeader("Cache-Control", "no-store");
      this.setHeader("Pragma", "no-cache");
      return writeHead.apply(this, args);
    };
  }
  next();
}

// Pages reached through a secret link in the URL show (or act on) one person's
// data to whoever holds the link, logged in or not: the reservation page
// (/cart/return?order=<token>: name and email), the book-request pages
// (/my-requests/..., /request-a-book/confirm/<token>), password reset and email
// verification. They must never sit in a shared cache or the browser's back/forward
// cache, so they are `private, no-store` for every visitor. Set before the route runs,
// so a route's own stricter header (some already send `no-store`) still wins.
const TOKEN_PAGE = /^\/(cart\/return|my-requests|request-a-book\/confirm|reset-password|verify-email)(\/|$)/;
function noStoreForTokenPages(req, res, next) {
  if (TOKEN_PAGE.test(req.path)) res.set("Cache-Control", "private, no-store");
  next();
}

module.exports = { noStoreForUsers, noStoreForTokenPages, TOKEN_PAGE };
