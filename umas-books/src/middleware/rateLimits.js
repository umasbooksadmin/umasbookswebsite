const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = rateLimit;

// IPv6 clients are bucketed by their /56, not the raw address: one
// subscriber is routinely handed a whole /64 (or /56), so a raw-address key
// lets a script rotate through billions of addresses and never hit a cap.
// IPv4 is untouched (the full address is the key).
const IPV6_SUBNET = 56;
const ipKey = (req) => ipKeyGenerator(req.ip, IPV6_SUBNET);

// Per-IP cap for a public write endpoint. In-memory (one instance, resets
// on restart) — a speed bump against scripts hammering these routes, not
// a hard guarantee. express's `trust proxy` is set to the number of proxy
// hops (TRUST_PROXY_HOPS, lib/trustProxy.js), so req.ip is the real client
// behind Cloudflare + Render and a spoofed X-Forwarded-For prefix is ignored.
function limit({ windowMs, max, ...options }) {
  return rateLimit({
    keyGenerator: ipKey,
    handler: (req, res) =>
      res
        .status(429)
        .type("text/plain")
        .send(
          req.tr
            ? req.tr(
                "Too many requests from this connection — please wait a while and try again, or email admin@umasbooks.org.",
                "Trop de requêtes depuis cette connexion : veuillez patienter un moment puis réessayer, ou écrire à admin@umasbooks.org."
              )
            : "Too many requests from this connection — please wait a while and try again, or email admin@umasbooks.org."
        ),
    ...options,
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
  });
}

const HOUR = 60 * 60 * 1000;

// The admin endpoints that call the paid AI service (cover photo reading, "Generate description"): 10 a minute per
// admin account, whatever the IP. `handler` answers the refusal (a JSON 429 for the pages' scripts); `skip` lets a
// route count only the requests that really call the AI.
const AI_PER_MINUTE = 10;
const { AI_LIMIT_MESSAGE } = require("../lib/aiLimits");
function aiAdminLimiter({ handler, skip, max = AI_PER_MINUTE } = {}) {
  return limit({
    windowMs: 60 * 1000,
    max,
    keyGenerator: (req) => `ai-user-${req.session && req.session.user ? req.session.user.id : "anon"}`,
    handler: handler || ((req, res) => res.status(429).json({ error: AI_LIMIT_MESSAGE })),
    ...(skip ? { skip } : {}),
    validate: { keyGeneratorIpFallback: false },
  });
}

// For limiters that only count failed attempts (skipSuccessfulRequests). A
// refused form now answers 303 (Post/Redirect/Get, lib/postRedirect.js), so the
// status code no longer says "failed": the handler marks it in
// res.locals.failedAttempt. A 4xx/5xx status still counts, as before.
const failureCounts = (req, res) => !res.locals.failedAttempt && res.statusCode < 400;
// Same, for limiters that count ONLY the explicit mark (a wrong password, a
// wrong code), not every other refusal.
const onlyMarkedFailures = (req, res) => !res.locals.failedAttempt;

module.exports = {
  failureCounts,
  onlyMarkedFailures,
  // A reservation holds copies for two weeks (and seats until the session), so it is limited per IP.
  checkoutLimiter: limit({ windowMs: HOUR, max: 10 }),
  // Browsing users add a handful of items; this only stops scripted loops.
  cartEditLimiter: limit({ windowMs: 15 * 60 * 1000, max: 60 }),
  eventSignupLimiter: limit({ windowMs: HOUR, max: 10 }),
  // Member-only writes that land in front of other members.
  forumPostLimiter: limit({ windowMs: HOUR, max: 10 }),
  forumReplyLimiter: limit({ windowMs: HOUR, max: 30 }),
  charityIdeaLimiter: limit({ windowMs: HOUR, max: 10 }),
  // /api/csrf-token creates a session row for every guest that has no
  // token yet. Guests that already hold one are not counted, so normal
  // browsing (forms fetch the token once per page) never gets near this.
  csrfTokenLimiter: limit({
    windowMs: 10 * 60 * 1000,
    max: 60,
    skip: (req) => Boolean(req.session && req.session.csrfToken),
  }),
  // GET /api/books/search runs ILIKE over the whole catalogue. Per IP, per minute; a person typing searches by
  // hand never gets near 60. Answers JSON (the Books page script shows a "wait a moment" line), never cached.
  bookSearchLimiter: limit({
    windowMs: 60 * 1000,
    max: 60,
    handler: (req, res) => {
      res.set("Cache-Control", "no-store");
      res.set("Access-Control-Allow-Origin", "*");
      res.status(429).json({ error: "rate_limited" });
    },
  }),
  limit,
  aiAdminLimiter,
  AI_LIMIT_MESSAGE,
  ipKey,
  IPV6_SUBNET,
};
