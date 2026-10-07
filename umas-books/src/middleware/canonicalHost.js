// Once the site is live (production, preview mode off), the app must be
// reachable under ONE address: the host of APP_BASE_URL (umasbooks.org).
// Render also answers on the service's own *.onrender.com address, which would
// otherwise serve a second, duplicate copy of the site (split sessions,
// duplicate content in search engines). GET/HEAD requests for any other Host
// are redirected (301) to the same path on APP_BASE_URL.
//
// Every OTHER method (POST/PUT/DELETE...) on a foreign Host is answered 421
// Misdirected Request, with no redirect (a redirect would drop the body, and
// serving it would leave a second, unprotected front door): a POST straight to
// the onrender.com address skips Cloudflare, so its proxy chain is shorter than
// TRUST_PROXY_HOPS expects and a client-supplied X-Forwarded-For could become
// req.ip, defeating every per-IP limit. Never touched, on any host and method:
//   - /healthz (Render's own health check and the uptime monitor call it by
//     the onrender.com address),
//   - /webhooks/helloasso (HelloAsso may be configured with either address;
//     it must never move or fail, and it has its own limiter).
// Off in preview, in tests and in dev (NODE_ENV !== production).
const { isPreviewMode } = require("../lib/preview");

const WEBHOOK_PATH = "/webhooks/helloasso";

function parseOrigin(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    if (u.protocol !== "https:") return null;
    return { host: u.host.toLowerCase(), origin: u.origin };
  } catch {
    return null;
  }
}

function canonicalHost({ env = process.env } = {}) {
  return (req, res, next) => {
    if (env.NODE_ENV !== "production" || isPreviewMode(env)) return next();
    if (req.path === "/healthz" || req.path === WEBHOOK_PATH) return next();
    const target = parseOrigin(env.APP_BASE_URL);
    if (!target) return next(); // misconfigured: env.js already warned; do not redirect to nowhere
    const host = String(req.headers.host || "").toLowerCase();
    if (!host || host === target.host) return next();
    if (req.method !== "GET" && req.method !== "HEAD") {
      return res.status(421).set("Cache-Control", "no-store").type("text/plain").send("Misdirected request: use " + target.origin);
    }
    return res.redirect(301, target.origin + req.originalUrl);
  };
}

module.exports = { canonicalHost, parseOrigin };
