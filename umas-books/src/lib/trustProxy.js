// How many reverse-proxy hops sit in front of the app, for Express's
// `trust proxy` setting (which decides what req.ip / req.ips are).
//
// Production umasbooks.org is: visitor -> Render's edge (Cloudflare-based: that
// is where the "cloudflare" response header comes from; DNS at Squarespace points
// straight at Render and the association has no Cloudflare account) -> Render's
// internal proxy -> this app. That is TWO trusted hops (measured with
// /admin/diagnostics/client-ip). If a real CDN is ever put in front of Render the
// chain changes: re-check this number then. with the
// "N trusted hops" setting Express takes the Nth address counting from the
// RIGHT of the chain (socket peer first, then X-Forwarded-For right to left),
// so anything a visitor puts at the left of X-Forwarded-For is ignored and
// cannot spoof req.ip. Trusting too few hops makes req.ip a shared edge
// address (one rate-limit bucket for everybody); trusting too many lets a
// client choose its own IP. Verify after a deploy on /admin/diagnostics/client-ip.
const config = require("./config");

const DEFAULT_PRODUCTION_HOPS = 2;
const DEFAULT_OTHER_HOPS = 1;

// Pure. Returns { hops, error } - error is a message when the env value is
// invalid (the caller logs it and uses the default, it never crashes boot).
function resolveTrustProxyHops(env = process.env) {
  const r = config.read("TRUST_PROXY_HOPS", env); // the rule and the defaults: configRegistry.js
  return { hops: r.value, error: r.state === "invalid" ? r.message : null };
}

module.exports = { resolveTrustProxyHops, DEFAULT_PRODUCTION_HOPS, DEFAULT_OTHER_HOPS };
