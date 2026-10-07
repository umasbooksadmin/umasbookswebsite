// One-shot page state carried across a redirect (Post/Redirect/Get) for admin
// forms: the POST stores what its page needs, redirects to a GET, and that GET
// takes it (once). A POST that renders a page itself leaves a POST in the
// browser history, and Back then shows "Confirm form resubmission".
//
// Kept in the session, keyed by page so one page's state never shows on
// another, and dropped after a few minutes if it was never picked up. Only
// display state goes in (typed values, messages); nothing in it is trusted.
const { saveSession } = require("./session");

const MAX_AGE_MS = 10 * 60 * 1000;

// Awaited before the redirect goes out: express-session answers a request that
// changed the session BEFORE its store write finishes, and a browser follows a
// redirect at once, so without the save the next page could read the old session
// (see lib/session.js).
async function setFlash(req, key, data) {
  if (!req.session) return;
  req.session.pageFlash = { ...(req.session.pageFlash || {}), [key]: { at: Date.now(), data } };
  await saveSession(req);
}

function takeFlash(req, key) {
  const all = req.session && req.session.pageFlash;
  if (!all || !all[key]) return null;
  const { at, data } = all[key];
  delete all[key];
  if (!Object.keys(all).length) delete req.session.pageFlash;
  return Date.now() - at <= MAX_AGE_MS ? data : null;
}

module.exports = { setFlash, takeFlash };
