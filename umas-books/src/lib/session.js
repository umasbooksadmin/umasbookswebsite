// express-session responds BEFORE its store write finishes: when a request
// modifies the session, its end() hook calls writeHead early (so the
// Set-Cookie/redirect headers go out) and saves in parallel. A browser that
// follows a redirect immediately can therefore read the *old* session — at
// login that looks like "still logged out", and after a password change
// (which re-stamps this session's own passwordChangedAt so it isn't logged
// out by attachUser) it looks like being logged out by your own change.
// Calling saveSession() and awaiting it before responding closes that
// window for the transitions where it matters (login, password change).
function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

module.exports = { saveSession };
