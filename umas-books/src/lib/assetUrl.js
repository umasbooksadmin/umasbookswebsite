// assetUrl("/assets/img/hero-left.png") -> "/assets/img/hero-left.png?v=3fa9c1d2e0"
//
// The static mounts in src/index.js answer a request that carries ?v= with a
// one-year "immutable" Cache-Control; one without it gets 7 days. The version
// is a short hash of the file's CONTENT (read once per path, cached), so
// editing a stylesheet, script or image changes its URL and visitors get the
// new file straight away instead of after the 7-day window. A path that is not
// a file we serve is returned unchanged.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const APP_ROOT = path.join(__dirname, "..", "..");
const MARKETING_ROOT = path.join(APP_ROOT, "..");

const cache = new Map();

function resolveFile(urlPath) {
  const clean = urlPath.split("?")[0];
  if (clean.includes("..")) return null;
  if (clean === "/logo.png") return path.join(MARKETING_ROOT, "logo.png");
  if (clean.startsWith("/assets/")) return path.join(MARKETING_ROOT, clean);
  return path.join(APP_ROOT, "public", clean);
}

function assetUrl(urlPath) {
  if (typeof urlPath !== "string" || !urlPath.startsWith("/")) return urlPath;
  if (cache.has(urlPath)) return cache.get(urlPath);
  let out = urlPath;
  try {
    const file = resolveFile(urlPath);
    if (file) {
      const hash = crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex").slice(0, 10);
      out = `${urlPath}?v=${hash}`;
    }
  } catch {
    out = urlPath; // missing file: leave the URL alone
  }
  cache.set(urlPath, out);
  return out;
}

// express.static setHeaders hook: a file served for a ?v=<hash> URL is
// immutable for a year (it only runs for files that exist, never for a 404).
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const SHORT_CACHE = "public, max-age=604800";
function isVersioned(req) {
  const v = req && req.query && req.query.v;
  return typeof v === "string" && /^[0-9a-f]{6,}$/.test(v);
}
function versionedHeaders(res) {
  if (isVersioned(res.req)) res.setHeader("Cache-Control", IMMUTABLE_CACHE);
}

// The static mounts sit before helmet in index.js, so they set the headers
// helmet would otherwise add. "cross-origin" resource policy: these files are
// public and may be embedded by the shop's own other hostnames.
const STATIC_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

function staticHeaders(res) {
  for (const [k, v] of Object.entries(STATIC_SECURITY_HEADERS)) res.setHeader(k, v);
  versionedHeaders(res);
}

module.exports = { assetUrl, versionedHeaders, isVersioned, IMMUTABLE_CACHE, SHORT_CACHE, staticHeaders, STATIC_SECURITY_HEADERS };
