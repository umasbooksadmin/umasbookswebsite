// Pages rendered for a logged-in visitor carry their name, orders, admin
// data... With no Cache-Control a browser or shared proxy is free to
// heuristically cache them, and the Back button after logout can show the
// previous user's page. So everything answered to a logged-in visitor is
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

module.exports = { noStoreForUsers };
