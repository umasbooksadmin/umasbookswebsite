// Post/Redirect/Get for the customer-facing forms. A POST that renders a page
// itself (a refused form, a "thanks" page) leaves a POST in the browser's
// history, and Back then shows "Confirm form resubmission" (a reload would send
// the form again). These handlers answer 303 to a fixed GET path instead; the
// message and what was typed travel once in the session (lib/flash.js, saved
// before the redirect goes out).
//
// What may travel: messages and typed values. NEVER a password, a token, a
// recovery code or a two-step code: those fields come back empty, and the
// views that need a token already have it in their own URL.
//
// `path` is always a fixed internal path chosen by the route (a few add a
// returnTo that safeReturnTo has already reduced to a local path, or a token
// run through encodeURIComponent). Nothing from the request is used as is.
const { setFlash, takeFlash } = require("./flash");

// counted: this refusal is a failed attempt that a limiter should count
// (wrong password, wrong code...). The limiters that only count failures used
// to look at the 400/401 status, which a 303 no longer carries: they read
// res.locals.failedAttempt instead (see failureCounts in middleware/rateLimits.js).
async function redirectWithFlash(req, res, path, key, data, { counted = false } = {}) {
  if (counted) res.locals.failedAttempt = true;
  if (data) await setFlash(req, key, data);
  res.redirect(303, path);
}

// The page's side of it: what a POST left for this page (or null), once. Pages
// that show one are never cached.
function takePageFlash(req, res, key) {
  const data = takeFlash(req, key);
  if (data) res.set("Cache-Control", "private, no-store");
  return data;
}

// "/path" or "/path?returnTo=<local path>" for pages that carry a returnTo.
function withReturnTo(path, returnTo) {
  return returnTo ? `${path}?returnTo=${encodeURIComponent(returnTo)}` : path;
}

module.exports = { redirectWithFlash, takePageFlash, withReturnTo };
