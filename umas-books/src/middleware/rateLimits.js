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
// a hard guarantee. express's `trust proxy` is set, so the IP is the real
// client's behind Render's proxy.
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

module.exports = {
  // Locks copies for an hour and calls HelloAsso.
  checkoutLimiter: limit({ windowMs: HOUR, max: 10 }),
  // Browsing users add a handful of items; this only stops scripted loops.
  cartEditLimiter: limit({ windowMs: 15 * 60 * 1000, max: 60 }),
  eventSignupLimiter: limit({ windowMs: HOUR, max: 10 }),
  // Member-only writes that land in front of other members.
  forumPostLimiter: limit({ windowMs: HOUR, max: 10 }),
  forumReplyLimiter: limit({ windowMs: HOUR, max: 30 }),
  charityIdeaLimiter: limit({ windowMs: HOUR, max: 10 }),
  // /api/csrf-token creates a session row for every visitor that has no
  // token yet. Visitors that already hold one are not counted, so normal
  // browsing (forms fetch the token once per page) never gets near this.
  csrfTokenLimiter: limit({
    windowMs: 10 * 60 * 1000,
    max: 60,
    skip: (req) => Boolean(req.session && req.session.csrfToken),
  }),
  limit,
  ipKey,
  IPV6_SUBNET,
};
