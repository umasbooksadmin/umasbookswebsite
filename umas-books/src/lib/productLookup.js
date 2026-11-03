// The NAME of a product from its barcode (UPC / EAN, not a book), for Admin > Educational items (routes/admin/eduItems.js
// GET /admin/edu-items/lookup). Owner-approved 2026-11-02. Only a name suggestion comes back: never a price, never a
// picture (UPCitemdb's images belong to other sites; the admin adds her own photo, like the covers decision for books).
//
// Two free, keyless sources, asked one after the other, at FIXED addresses (only the digits of a validated barcode are
// put in them, so nothing can be sent anywhere else):
//   1. Open Products Facts  https://world.openproductsfacts.org/api/v2/product/<code>.json   (open data, no limit)
//   2. UPCitemdb trial      https://api.upcitemdb.com/prod/trial/lookup?upc=<code>           (about 100 lookups a day
//      per IP address; over that it answers 429). It is asked only when Open Products Facts has no name, so the
//      daily allowance goes further.
// Each request has a deadline and a size cap (lib/bookSources.js getJson: lib/boundedBody.js, 1 MB). Answers are cached
// in memory (lib/bookLookup.js createTtlCache): a name found for a day, "not found" for 6 hours; a failure is never
// cached. After a 429 from UPCitemdb it is not asked again for 15 minutes (or what Retry-After says, 1 minute to 1 hour).
// Never throws.
//
// WHY IT FAILS is kept in memory (productLookupStatus(), shown on Admin > Diagnostics > Lookup sources, and turned into
// a specific sentence by the lookup route): per source a count per outcome kind, the last failure, the last success and
// UPCitemdb's own X-RateLimit-* numbers. Never the address asked (no key in it) nor a response body.
//
// Optional paid plan: with UPCITEMDB_USER_KEY set (Render env var), UPCitemdb is asked at its keyed address
// https://api.upcitemdb.com/prod/v1/lookup with the headers `user_key` and `key_type: 3scale` (UPCitemdb's
// "Getting Started" documentation). Unset = the free trial address, as always.
//
// -> { state: "found", name, source: "Open Products Facts" | "UPCitemdb", cached? }
//  | { state: "missing" }                       (both sources answered: no such product)
//  | { state: "unavailable", reason, failure }  (timeout, network, 429, an odd answer: nobody knows)
//    failure: "limit" (429 / paused) | "refused" (401, 403) | "timeout" | "network" | "server" (5xx) | "unreadable" | "other"

const { createTtlCache } = require("./bookLookup");
const { getJson } = require("./bookSources");
const { readBoundedJson } = require("./boundedBody");
const config = require("./config");
const { createInflight } = require("./inflight");

const NAME_MAX = 120; // edu_items.name
// A server in a data centre can need longer than a desk to reach these hosts, and a wrong "unavailable" is worse than a
// short wait: 6 s per source (two sources: 12 s at the very most; the page waits 15 s and shows "Looking up...").
let TIMEOUT_MS = 6000;
const FOUND_TTL_MS = 24 * 60 * 60 * 1000;
const MISSING_TTL_MS = 6 * 60 * 60 * 1000;
const PAUSE_AFTER_429_MS = 15 * 60 * 1000;
const PAUSE_MIN_MS = 60 * 1000;
const PAUSE_MAX_MS = 60 * 60 * 1000;
const UPC_PAID_URL = (code) => `https://api.upcitemdb.com/prod/v1/lookup?upc=${code}`;

const cache = createTtlCache({ max: 500, ttlMs: FOUND_TTL_MS });
const inflight = createInflight();
const upcPause = { until: 0 };

// ---- why it fails (in memory; starts again at zero when the app restarts) ----
const newSource = () => ({ counts: {}, lastKind: null, lastAt: null, lastReason: null, lastOkAt: null, quota: null });
const state = { opf: newSource(), upc: newSource() };
function record(src, kind, now, reason) {
  const st = state[src];
  st.counts[kind] = (st.counts[kind] || 0) + 1;
  if (kind === "found") st.lastOkAt = now();
  if (kind === "found" || kind === "not found" || kind === "paused") return; // a pause must not hide the failure that caused it
  st.lastKind = kind;
  st.lastAt = now();
  st.lastReason = reason || null;
}
// A short, harmless word from the service's JSON error ({"code":"EXCEED_LIMIT",...}); never a long text or a URL.
function safeReason(data) {
  const v = data && typeof data === "object" ? (typeof data.code === "string" ? data.code : typeof data.message === "string" ? data.message : null) : null;
  return v ? v.replace(/[^A-Za-z0-9 _.,:-]/g, "").replace(/\s+/g, " ").trim().slice(0, 60) || null : null;
}
function readQuota(headers, now) {
  const num = (n) => { const v = headers && typeof headers.get === "function" ? headers.get(n) : null; return v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null; };
  const limit = num("x-ratelimit-limit");
  const remaining = num("x-ratelimit-remaining");
  const reset = num("x-ratelimit-reset");
  if (limit == null && remaining == null && reset == null) return;
  state.upc.quota = { limit, remaining, resetAt: reset == null ? null : reset * 1000, seenAt: now() };
}
function failureOf(kind) {
  if (kind === "timeout" || kind === "network") return kind;
  if (kind === "parse" || kind === "too large") return "unreadable";
  const m = /^http (\d+)$/.exec(kind || "");
  if (!m) return "other";
  const n = Number(m[1]);
  return n === 429 ? "limit" : n === 401 || n === 403 ? "refused" : n >= 500 ? "server" : "other";
}
function productLookupStatus(now = Date.now()) {
  const view = (key, name) => {
    const st = state[key];
    const total = Object.entries(st.counts).filter(([k]) => k !== "found" && k !== "not found" && k !== "paused").reduce((a, [, n]) => a + n, 0);
    return { key, name, counts: { ...st.counts }, failures: total, calls: Object.values(st.counts).reduce((a, b) => a + b, 0), lastKind: st.lastKind, lastAt: st.lastAt, lastReason: st.lastReason, lastOkAt: st.lastOkAt, quota: st.quota ? { ...st.quota } : null };
  };
  return { sources: [view("opf", "Open Products Facts"), view("upc", "UPCitemdb")], pausedUntil: upcPause.until > now ? upcPause.until : 0, keyed: Boolean(userKey()) };
}
const userKey = (env = process.env) => String(config.get("UPCITEMDB_USER_KEY", env) || "").trim();


const OPF_URL = (code) => `https://world.openproductsfacts.org/api/v2/product/${code}.json?fields=product_name,product_name_en,brands`;
const UPC_URL = (code) => `https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`;

const tidy = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();

// "Brand" + "Title" -> one name, the brand only when the title does not already carry it. At most NAME_MAX characters.
function nameFrom(title, brand) {
  const t = tidy(title);
  if (!t) return null;
  const b = tidy(String(brand || "").split(",")[0]);
  const full = b && !t.toLowerCase().includes(b.toLowerCase()) ? `${b} ${t}` : t;
  return full.length > NAME_MAX ? full.slice(0, NAME_MAX).replace(/\s+\S*$/, "") || full.slice(0, NAME_MAX) : full;
}

async function withDeadline(fn, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fn(controller.signal); } finally { clearTimeout(timer); }
}

// One request, with a spy on it: UPCitemdb's quota headers are read from every answer, and `extraHeaders` (the paid key)
// are added to the request. The failure kind is told by getJson's `watch`.
async function ask(src, url, { fetchImpl, timeoutMs, now, extraHeaders }) {
  const spy = async (u, init = {}) => {
    const res = await fetchImpl(u, extraHeaders ? { ...init, headers: { ...(init.headers || {}), ...extraHeaders } } : init);
    if (src === "upc" && res && res.headers) readQuota(res.headers, now);
    return res;
  };
  let failed = null;
  const watch = async (kind, res) => {
    let reason = null;
    let retryAfter = null;
    if (res) {
      try { retryAfter = Number(res.headers.get("retry-after")); } catch { /* no header */ }
      try { reason = safeReason(await readBoundedJson(res)); } catch { /* no usable body */ }
    }
    failed = { kind, reason, retryAfter };
    record(src, kind, now, reason);
  };
  const r = await withDeadline((signal) => getJson(spy, url, signal, watch), timeoutMs);
  return { r, failed };
}

async function openProductsFacts(code, ctx) {
  const { r, failed } = await ask("opf", OPF_URL(code), ctx);
  if (r.state === "missing") { record("opf", "not found", ctx.now); return { state: "missing" }; }
  if (r.state !== "ok") return { state: "unavailable", reason: failed ? failed.kind : "error", failure: failureOf(failed && failed.kind) };
  const p = r.data && r.data.product;
  const name = p && nameFrom(p.product_name_en || p.product_name, p.brands);
  if (name) { record("opf", "found", ctx.now); return { state: "found", name }; }
  record("opf", "not found", ctx.now);
  return { state: "missing" };
}

async function upcItemDb(code, ctx) {
  const { now } = ctx;
  if (upcPause.until > now()) {
    record("upc", "paused", now, "after a 429");
    return { state: "unavailable", reason: "paused after 429", failure: "limit" };
  }
  const key = userKey(ctx.env);
  const { r, failed } = await ask("upc", key ? UPC_PAID_URL(code) : UPC_URL(code), { ...ctx, extraHeaders: key ? { user_key: key, key_type: "3scale" } : null });
  if (r.state === "error" && r.status === 429) {
    const ra = failed && Number.isFinite(failed.retryAfter) && failed.retryAfter > 0 ? failed.retryAfter * 1000 : PAUSE_AFTER_429_MS;
    upcPause.until = now() + Math.min(PAUSE_MAX_MS, Math.max(PAUSE_MIN_MS, ra));
    return { state: "unavailable", reason: "429", failure: "limit" };
  }
  if (r.state === "missing") { record("upc", "not found", now); return { state: "missing" }; }
  if (r.state === "error" && r.status === 400) return { state: "missing" }; // INVALID_UPC (already counted as http 400)
  if (r.state !== "ok") return { state: "unavailable", reason: failed ? failed.kind : "error", failure: failureOf(failed && failed.kind) };
  const d = r.data || {};
  if (d.code && d.code !== "OK") {
    record("upc", "odd answer", now, safeReason(d));
    return { state: "unavailable", reason: String(d.code).slice(0, 40), failure: "other" };
  }
  const item = Array.isArray(d.items) ? d.items.find((i) => i && tidy(i.title)) : null;
  if (!item) { record("upc", "not found", now); return { state: "missing" }; }
  record("upc", "found", now);
  return { state: "found", name: nameFrom(item.title, item.brand) };
}

// code: a barcode already validated by lib/barcode.js parseBarcode (digits only). opts: fetchImpl, timeoutMs, now (tests).
async function lookupProductName(code, opts = {}) {
  const c = String(code || "");
  if (!/^(\d{8}|\d{12,14})$/.test(c)) return { state: "missing" };
  const hit = cache.get(c);
  if (hit) return { ...hit, cached: true };
  return inflight.run(c, async () => {
    const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
    const ctx = { fetchImpl, timeoutMs: opts.timeoutMs || TIMEOUT_MS, now: opts.now || Date.now, env: opts.env || process.env };
    try {
      const opf = await openProductsFacts(c, ctx);
      if (opf.state === "found") {
        const out = { state: "found", name: opf.name, source: "Open Products Facts" };
        cache.set(c, out);
        return { ...out };
      }
      const upc = await upcItemDb(c, ctx);
      if (upc.state === "found") {
        const out = { state: "found", name: upc.name, source: "UPCitemdb" };
        cache.set(c, out);
        return { ...out };
      }
      if (upc.state === "missing" && opf.state === "missing") {
        cache.set(c, { state: "missing" }, MISSING_TTL_MS);
        return { state: "missing" };
      }
      const bad = upc.state === "unavailable" ? upc : opf;
      return { state: "unavailable", reason: bad.reason, failure: bad.failure || "other" };
    } catch (err) {
      return { state: "unavailable", reason: (err && err.message) || "error", failure: "other" };
    }
  });
}

// Tests: forget the cache and the pause.
function setProductTimeoutForTests(ms) { TIMEOUT_MS = ms || 6000; }
function resetProductLookup() { cache.clear(); upcPause.until = 0; state.opf = newSource(); state.upc = newSource(); }

module.exports = { lookupProductName, resetProductLookup, setProductTimeoutForTests, productLookupStatus, UPC_PAID_URL, nameFrom, OPF_URL, UPC_URL, PAUSE_AFTER_429_MS };
