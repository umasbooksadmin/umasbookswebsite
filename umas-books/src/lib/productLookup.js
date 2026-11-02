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
// cached. After a 429 from UPCitemdb it is not asked again for 15 minutes (the page then says "Lookup unavailable right
// now: type the details in"). Never throws.
//
// -> { state: "found", name, source: "Open Products Facts" | "UPCitemdb", cached? }
//  | { state: "missing" }                       (both sources answered: no such product)
//  | { state: "unavailable", reason }           (timeout, network, 429, an odd answer: nobody knows)

const { createTtlCache } = require("./bookLookup");
const { getJson } = require("./bookSources");
const { createInflight } = require("./inflight");

const NAME_MAX = 120; // edu_items.name
const TIMEOUT_MS = 3500;
const FOUND_TTL_MS = 24 * 60 * 60 * 1000;
const MISSING_TTL_MS = 6 * 60 * 60 * 1000;
const PAUSE_AFTER_429_MS = 15 * 60 * 1000;

const cache = createTtlCache({ max: 500, ttlMs: FOUND_TTL_MS });
const inflight = createInflight();
const upcPause = { until: 0 };

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

async function openProductsFacts(code, fetchImpl, timeoutMs) {
  const r = await withDeadline((signal) => getJson(fetchImpl, OPF_URL(code), signal), timeoutMs);
  if (r.state === "missing") return { state: "missing" };
  if (r.state !== "ok") return { state: "unavailable", reason: r.status ? `http ${r.status}` : "network" };
  const p = r.data && r.data.product;
  const name = p && nameFrom(p.product_name_en || p.product_name, p.brands);
  if (name) return { state: "found", name };
  return { state: "missing" };
}

async function upcItemDb(code, fetchImpl, timeoutMs, now) {
  if (upcPause.until > now()) return { state: "unavailable", reason: "paused after 429" };
  const r = await withDeadline((signal) => getJson(fetchImpl, UPC_URL(code), signal), timeoutMs);
  if (r.state === "error" && r.status === 429) {
    upcPause.until = now() + PAUSE_AFTER_429_MS;
    return { state: "unavailable", reason: "429" };
  }
  if (r.state === "missing") return { state: "missing" };
  if (r.state === "error" && r.status === 400) return { state: "missing" }; // INVALID_UPC
  if (r.state !== "ok") return { state: "unavailable", reason: r.status ? `http ${r.status}` : "network" };
  const d = r.data || {};
  if (d.code && d.code !== "OK") return { state: "unavailable", reason: String(d.code).slice(0, 40) };
  const item = Array.isArray(d.items) ? d.items.find((i) => i && tidy(i.title)) : null;
  if (!item) return { state: "missing" };
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
    const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
    const now = opts.now || Date.now;
    try {
      const opf = await openProductsFacts(c, fetchImpl, timeoutMs);
      if (opf.state === "found") {
        const out = { state: "found", name: opf.name, source: "Open Products Facts" };
        cache.set(c, out);
        return { ...out };
      }
      const upc = await upcItemDb(c, fetchImpl, timeoutMs, now);
      if (upc.state === "found") {
        const out = { state: "found", name: upc.name, source: "UPCitemdb" };
        cache.set(c, out);
        return { ...out };
      }
      if (upc.state === "missing" && opf.state === "missing") {
        cache.set(c, { state: "missing" }, MISSING_TTL_MS);
        return { state: "missing" };
      }
      return { state: "unavailable", reason: upc.state === "unavailable" ? upc.reason : opf.reason };
    } catch (err) {
      return { state: "unavailable", reason: (err && err.message) || "error" };
    }
  });
}

// Tests: forget the cache and the pause.
function resetProductLookup() { cache.clear(); upcPause.until = 0; }

module.exports = { lookupProductName, resetProductLookup, nameFrom, OPF_URL, UPC_URL, PAUSE_AFTER_429_MS };
