// The HelloAsso payment-page origins the browser is sent to after a
// checkout form POST. POST /cart/checkout answers 302 to the checkout
// intent's redirectUrl, and Chromium browsers apply the CSP form-action
// directive to that redirect too — so form-action must list these origins
// or the redirect is blocked and nobody can pay.
//
// An explicit allowlist, not a wildcard: production hosts always, sandbox
// hosts only when HELLOASSO_API_BASE points at the sandbox API.

const PRODUCTION_ORIGINS = ["https://www.helloasso.com", "https://checkout.helloasso.com"];
const SANDBOX_ORIGINS = ["https://www.helloasso-sandbox.com", "https://checkout.helloasso-sandbox.com"];

function usesSandbox(apiBase) {
  if (!apiBase) return false;
  try {
    const host = new URL(apiBase).hostname.toLowerCase();
    return host === "helloasso-sandbox.com" || host.endsWith(".helloasso-sandbox.com");
  } catch {
    return false;
  }
}

function helloassoPaymentOrigins(apiBase = process.env.HELLOASSO_API_BASE) {
  return usesSandbox(apiBase) ? [...PRODUCTION_ORIGINS, ...SANDBOX_ORIGINS] : [...PRODUCTION_ORIGINS];
}

module.exports = { helloassoPaymentOrigins, usesSandbox, PRODUCTION_ORIGINS, SANDBOX_ORIGINS };
