const rateLimit = require("express-rate-limit");

// Per-IP cap for a public write endpoint. In-memory (one instance, resets
// on restart) — a speed bump against scripts hammering these routes, not
// a hard guarantee. express's `trust proxy` is set, so the IP is the real
// client's behind Render's proxy.
function limit({ windowMs, max }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) =>
      res
        .status(429)
        .type("text/plain")
        .send("Too many requests from this connection — please wait a while and try again, or email admin@umasbooks.org."),
  });
}

const HOUR = 60 * 60 * 1000;

module.exports = {
  // Holds a physical copy for 2 weeks and sends an email.
  reserveLimiter: limit({ windowMs: HOUR, max: 5 }),
  // Locks copies for an hour and calls HelloAsso.
  checkoutLimiter: limit({ windowMs: HOUR, max: 10 }),
  // Browsing users add a handful of items; this only stops scripted loops.
  cartEditLimiter: limit({ windowMs: 15 * 60 * 1000, max: 60 }),
  eventSignupLimiter: limit({ windowMs: HOUR, max: 10 }),
};
