// The safety guard. The end-to-end tests drive a real browser against a real
// URL, so they refuse to run unless the target is one of these (checked in
// this order; the first that applies is printed as the reason):
//
//   1. "local"      the host is exactly localhost, 127.0.0.1 or [::1]
//   2. "preview"    the site says it is in preview mode: it answers with the
//                   X-Robots-Tag: noindex header AND shows the "coming soon"
//                   banner (what PREVIEW_MODE=true makes the app emit, see
//                   src/lib/preview.js and views/partials/preview_banner.ejs).
//                   Both are required, so one stray header cannot unlock it.
//   3. "allow-live" E2E_ALLOW_LIVE=1 was set on purpose.
//
// Anything else is refused. Pure functions + an injectable fetch, so
// test/unit/e2eSafetyGuard.test.js covers every rule without a network.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseTarget(raw) {
  let url;
  try {
    url = new URL(String(raw || "").trim());
  } catch {
    return { ok: false, reason: "E2E_BASE_URL is missing or is not a web address (example: https://umasbooks.org)." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `E2E_BASE_URL must start with http:// or https:// (got ${url.protocol}).` };
  }
  return { ok: true, url };
}

const isLocalHost = (url) => LOCAL_HOSTS.has(url.hostname.toLowerCase());

// headers: a fetch Headers (or anything with .get); html: the home page.
function looksLikePreview({ headers, html }) {
  const robots = String((headers && headers.get && headers.get("x-robots-tag")) || "").toLowerCase();
  const noindexHeader = robots.includes("noindex");
  const banner = /class="preview-banner"/.test(String(html || ""));
  return { noindexHeader, banner, preview: noindexHeader && banner };
}

async function probe(base, fetchFn) {
  const res = await fetchFn(`${base}/`, { redirect: "follow", headers: { "user-agent": "umasbooks-e2e-guard" } });
  const html = await res.text();
  return { status: res.status, ...looksLikePreview({ headers: res.headers, html }) };
}

// -> { allowed, rule, reason, preview, local }
async function evaluateTarget(rawUrl, { env = process.env, fetchFn = fetch } = {}) {
  const parsed = parseTarget(rawUrl);
  if (!parsed.ok) return { allowed: false, rule: null, reason: parsed.reason, preview: false, local: false };
  const base = parsed.url.origin;
  const local = isLocalHost(parsed.url);
  const allowLive = String(env.E2E_ALLOW_LIVE || "") === "1";

  let seen = null;
  let probeError = null;
  try {
    seen = await probe(base, fetchFn);
  } catch (err) {
    probeError = err;
  }
  const preview = Boolean(seen && seen.preview);

  if (local) return { allowed: true, rule: "local", reason: `${parsed.url.hostname} is a local address`, preview, local };
  if (preview) return { allowed: true, rule: "preview", reason: "the site is in preview mode (noindex header and the coming-soon banner)", preview, local };
  if (allowLive) return { allowed: true, rule: "allow-live", reason: "E2E_ALLOW_LIVE=1 is set", preview, local };

  const why = probeError
    ? `could not reach ${base} to check whether it is in preview mode (${probeError.message})`
    : `${base} is not in preview mode (noindex header: ${seen.noindexHeader ? "yes" : "no"}, coming-soon banner: ${seen.banner ? "yes" : "no"})`;
  return {
    allowed: false, rule: null, preview, local,
    reason: `Refusing to run: ${why}. The tests only run against localhost, a site in preview mode, or when E2E_ALLOW_LIVE=1 is set on purpose.`,
  };
}

module.exports = { evaluateTarget, parseTarget, isLocalHost, looksLikePreview, LOCAL_HOSTS };
