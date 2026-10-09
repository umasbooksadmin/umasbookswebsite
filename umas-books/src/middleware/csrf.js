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

// The "Please try again" / confirm page for /logout. Nothing is destroyed here. The session is saved
// before the page goes out so the token printed on its button is already stored when it is pressed.
async function renderLogoutConfirm(req, res, status = 200) {
  try {
    ensureToken(req);
    await saveSession(req);
  } catch (err) {
    console.error("Logout confirmation could not save the session:", err.message);
  }
  res.set("Cache-Control", "no-store");
  res.status(status);
  const message = "Please try again";
  res.render("logout_confirm", {}, (err, html) => (err ? res.send(message) : res.send(html)));
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
      // /logout never destroys a session without a valid token. A double-click (or any
      // near-simultaneous double submit) races two POSTs against the same token: the first
      // destroys the session, so the second finds no one logged in: the person already got
      // what they wanted, so just send them home. A request that IS still logged in but has a
      // wrong or missing token (a stale page, or a forged cross-site POST) gets a friendly
      // "please try again" page with a confirm button carrying a fresh token.
      if (req.path === "/logout") {
        if (!req.session.user) return res.redirect("/");
        return renderLogoutConfirm(req, res, 403);
      }
      // The site's own error page, in the person's language (req.tr). If the
      // page itself cannot render, fall back to the plain English text.
      const message = req.tr
        ? req.tr(
            "Your session expired or this form is out of date. Please go back and try again.",
            "Votre session a expiré ou ce formulaire n’est plus à jour. Veuillez revenir en arrière et réessayer."
          )
        : "Your session expired or this form is out of date. Please go back and try again.";
      res.status(403);
      return res.render("error", { message }, (err, html) => (err ? res.send(message) : res.send(html)));
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

module.exports = { csrfProtection, renderLogoutConfirm, isValidCsrfToken, ensureToken, csrfTokenEndpoint };
