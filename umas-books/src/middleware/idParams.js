const { parseId } = require("../lib/validation");

// Registers a router.param() check for each named route parameter so a
// non-numeric or out-of-range value ("/books/abc") gets the normal 404 page
// instead of reaching Postgres, which rejects it and turns the request
// into a 500. A 500 also consumes the alertOnError throttle window, which
// can then suppress the alert for a real incident.
function validateIdParams(router, ...names) {
  for (const name of names) {
    router.param(name, (req, res, next, value) => {
      if (parseId(value) === null) return res.status(404).render("404");
      next();
    });
  }
}

module.exports = { validateIdParams };
