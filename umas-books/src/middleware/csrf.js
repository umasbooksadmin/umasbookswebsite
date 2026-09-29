const crypto = require("crypto");

// A plain !== comparison short-circuits at the first differing byte, so it
// takes measurably longer the more of the real token a guess happens to
// match — a timing side channel against a 32-byte random secret.
// timingSafeEqual compares in constant time but throws if the two buffers
// aren't the same length, so that (non-secret) length check has to happen
// before it, not instead of it.
function isValidCsrfToken(token, expected) {
  if (typeof token !== "string" || typeof expected !== "string") return false;
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expected);
  if (tokenBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(tokenBuf, expectedBuf);
}

function csrfProtection(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (req.method === "POST") {
    const token = req.body && req.body._csrf;
    if (!isValidCsrfToken(token, req.session.csrfToken)) {
      // A double-click (or any near-simultaneous double submit) on the
      // Log Out button races two POSTs against the same token: the first
      // destroys the session, so the second always looks like a stale
      // token here. That's harmless for this one route — the user
      // already got what they wanted — so treat it as "already logged
      // out" instead of showing a dead-end error for a request that
      // succeeded a moment earlier.
      if (req.path === "/logout") {
        return req.session.destroy(() => res.redirect("/"));
      }
      return res.status(403).send("Your session expired or this form is out of date. Please go back and try again.");
    }
  }
  next();
}

module.exports = { csrfProtection };
