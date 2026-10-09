// Per-IP cap on GUEST sessions that actually get stored.
//
// A session row is only written when a guest's request puts something in the
// session (the CSRF token of a form page, an empty cart, a flash message), so
// the cost is invisible on marketing pages and crawlers never trigger it, but
// /login, /signup, /forgot-password, /contact, /cart, /request-a-book... each
// answer a cookie-less GET with a new row. Rather than list those pages (and
// forget the next one), this counts the thing itself: a response that creates a
// new guest session with content in it. Once one address has done that
// `max` times within `windowMs`, its further cookie-less GET/HEAD requests are
// refused with 429 BEFORE any handler runs, so no session, token or row is
// created. Logged-in sessions are not counted (a login is a new session too).
//
// Static files, /healthz, robots.txt and the image store are mounted before the
// session and never get here. In memory, one instance: resets on restart, like
// the other limiters in middleware/rateLimits.js, and uses the same client key
// (req.ip behind the configured trusted proxy hops, IPv6 bucketed by /56).
const crypto = require("crypto");
const { ipKey } = require("../middleware/rateLimits");

const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX = 60;
const MAX_TRACKED = 20000;

// express-session calls genid only when it makes a NEW id (no cookie, an
// unsigned/unknown one, or regenerate at login), with the request: flag it.
function genid(req) {
  req.sessionIsNew = true;
  return crypto.randomBytes(24).toString("base64url");
}

// ANON_SESSION_LIMIT: optional whole number 1 to 1,000,000, stored guest sessions per IP per 10 minutes.
// Only for tests that act as hundreds of visitors from one address (the local end-to-end run); leave it
// unset on the live site.
function limitFromEnv(env = process.env) {
  const n = Number(String(env.ANON_SESSION_LIMIT || "").trim());
  return Number.isInteger(n) && n >= 1 && n <= 1000000 ? n : DEFAULT_MAX;
}

function createAnonSessionGuard({ windowMs = DEFAULT_WINDOW_MS, max = limitFromEnv(), now = Date.now, keyOf } = {}) {
  const hits = new Map(); // key -> { start, count }
  const key = keyOf || ipKey;

  function current(k) {
    const h = hits.get(k);
    if (!h) return 0;
    if (now() - h.start >= windowMs) {
      hits.delete(k);
      return 0;
    }
    return h.count;
  }
  function record(k) {
    if (hits.size >= MAX_TRACKED) {
      const t = now();
      for (const [kk, h] of hits) if (t - h.start >= windowMs) hits.delete(kk);
      if (hits.size >= MAX_TRACKED) hits.clear(); // under a huge spread attack, forget rather than grow
    }
    const h = hits.get(k);
    if (h && now() - h.start < windowMs) h.count += 1;
    else hits.set(k, { start: now(), count: 1 });
  }

  function middleware(req, res, next) {
    const k = key(req);
    const isRead = req.method === "GET" || req.method === "HEAD";
    if (isRead && req.sessionIsNew && req.path !== "/api/session" && current(k) >= max) {
      const h = hits.get(k);
      const retryAfter = Math.max(1, Math.ceil((h.start + windowMs - now()) / 1000));
      res.set("Retry-After", String(retryAfter));
      res.set("Cache-Control", "no-store");
      const en = "Too many requests from this connection — please wait a few minutes and try again, or email admin@umasbooks.org.";
      const fr = "Trop de requêtes depuis cette connexion : veuillez patienter quelques minutes puis réessayer, ou écrire à admin@umasbooks.org.";
      res.status(429);
      if (req.path.startsWith("/api/")) return res.json({ error: "rate_limited" });
      return res.type("text/plain").send(req.tr ? req.tr(en, fr) : `${en}\n${fr}`);
    }
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      const s = req.session;
      if (req.sessionIsNew && s && !s.user && Object.keys(s).some((f) => f !== "cookie")) record(k);
      return writeHead.apply(this, args);
    };
    next();
  }
  middleware.count = (req) => current(key(req));
  middleware.reset = () => hits.clear();
  return middleware;
}

module.exports = { genid, createAnonSessionGuard, limitFromEnv, DEFAULT_WINDOW_MS, DEFAULT_MAX };
