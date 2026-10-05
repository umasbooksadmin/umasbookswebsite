const crypto = require("crypto");
const { saveSession } = require("../lib/session");

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

// The token is created LAZILY: only when a view actually prints it, or
// /api/csrf-token reads it. Creating it eagerly meant every request —
// including every guest and bot hitting a form-less marketing
// page — modified req.session, so express-session INSERTed a `session`
// row and issued a 30-day cookie for each of them.
//
// res.locals.csrfToken is a small object rather than a plain string (or a
// getter) because Express copies res.locals into the view's data before
// every render; a getter would fire during that copy, form or not. The
// object is copied by reference, and its toString/valueOf only run when
// a template actually outputs it (`<%= csrfToken %>`).
function ensureToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }
  return req.session.csrfToken;
}

function csrfProtection(req, res, next) {
  res.locals.csrfToken = {
    toString: () => ensureToken(req),
    valueOf: () => ensureToken(req),
    toJSON: () => ensureToken(req),
  };

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

// GET /api/csrf-token. The token is created lazily and lives in the session,
// but express-session sends response headers BEFORE its store write finishes
// (see lib/session.js) — so a client that fetches the token and POSTs with
// it straight away could reach the server before the session holding that
// token was saved, and be rejected with a 403. Save first, then respond.
async function csrfTokenEndpoint(req, res) {
  res.set("Cache-Control", "no-store");
  const token = ensureToken(req);
  await saveSession(req);
  res.json({ token });
}

module.exports = { csrfProtection, isValidCsrfToken, ensureToken, csrfTokenEndpoint };
