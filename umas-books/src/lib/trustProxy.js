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
const DEFAULT_PRODUCTION_HOPS = 2;
const DEFAULT_OTHER_HOPS = 1;

// Pure. Returns { hops, error } - error is a message when the env value is
// invalid (the caller logs it and uses the default, it never crashes boot).
function resolveTrustProxyHops(env = process.env) {
  const fallback = env.NODE_ENV === "production" ? DEFAULT_PRODUCTION_HOPS : DEFAULT_OTHER_HOPS;
  const raw = env.TRUST_PROXY_HOPS;
  if (raw === undefined || String(raw).trim() === "") return { hops: fallback, error: null };
  const text = String(raw).trim();
  const n = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(n) || n < 1 || n > 5) {
    return { hops: fallback, error: `TRUST_PROXY_HOPS=${JSON.stringify(text)} is not an integer from 1 to 5; using ${fallback}.` };
  }
  return { hops: n, error: null };
}

module.exports = { resolveTrustProxyHops, DEFAULT_PRODUCTION_HOPS, DEFAULT_OTHER_HOPS };
