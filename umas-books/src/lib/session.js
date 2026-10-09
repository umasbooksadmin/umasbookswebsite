const { applyLifetime } = require("./sessionLifetime");

// express-session responds BEFORE its store write finishes: when a request
// modifies the session, its end() hook calls writeHead early (so the
// Set-Cookie/redirect headers go out) and saves in parallel. A browser that
// follows a redirect immediately can therefore read the *old* session — at
// login that looks like "still logged out", and after a password change
// (which re-stamps this session's own passwordChangedAt so it isn't logged
// out by attachUser) it looks like being logged out by your own change.
// Calling saveSession() and awaiting it before responding closes that
// window for the transitions where it matters (login, password change).
//
// It also brings the session's lifetime in line with what it holds (30 days once
// logged in, 24 h with a guest cart, 2 h otherwise: lib/sessionLifetime.js)
// BEFORE the save, because the stored row expires when cookie.expires says.
function saveSession(req) {
  applyLifetime(req.session);
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

module.exports = { saveSession };
