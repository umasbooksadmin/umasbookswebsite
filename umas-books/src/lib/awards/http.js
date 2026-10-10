// Tiny shared helper for the award lookups: a GET/POST with a timeout that
// never throws. Returns { ok, status, json } where ok=false covers network
// errors, timeouts, non-2xx and unparseable bodies. `fetch` is injectable so
// tests never touch the network. Secrets (API keys) are scrubbed from any
// error text before it can reach a log.

const { readBoundedJson } = require("../boundedBody");

const DEFAULT_TIMEOUT_MS = 8000;

function scrub(text, secrets = []) {
  let out = String(text || "");
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  return out.slice(0, 300);
}

async function requestJson(url, { fetch: fetchFn, method = "GET", headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, secrets = [] } = {}) {
  const doFetch = fetchFn || global.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { method, headers, body, signal: controller.signal });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const json = await readBoundedJson(res); // over 1 MB: the source failed (caught below)
    return { ok: true, status: res.status, json };
  } catch (err) {
    const msg = err && err.name === "AbortError" ? "timed out" : err && err.name === "BodyTooLargeError" ? "response too large" : scrub(err && err.message, secrets);
    return { ok: false, status: 0, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { requestJson, scrub, DEFAULT_TIMEOUT_MS };
