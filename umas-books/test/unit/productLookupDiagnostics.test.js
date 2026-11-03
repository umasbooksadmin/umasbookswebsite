// lib/productLookup.js: why a barcode lookup fails (counts per kind, last failure, UPCitemdb's quota headers, the
// pause) and the optional paid key. The outside world is a stub passed as fetchImpl; nothing leaves the machine.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { lookupProductName, resetProductLookup, productLookupStatus, UPC_PAID_URL } = require("../../src/lib/productLookup");

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const OPF_404 = () => json({ code: "0088231920519", status: 0, status_verbose: "product not found" }, 404);
const UPC_OK = (extra = {}) => json({ code: "OK", total: 1, items: [{ title: "Shapes and Colors Flash Cards", brand: "Teacher Created Resources" }] }, 200, { "X-RateLimit-Limit": "100", "X-RateLimit-Remaining": "92", "X-RateLimit-Reset": "1793713526", ...extra });
const CODE = "088231920519";
const seen = [];
const route = (opf, upc) => async (url, init = {}) => {
  seen.push({ url: String(url), headers: init.headers || {} });
  return String(url).includes("openproductsfacts") ? opf(init) : upc(init);
};
beforeEach(() => { resetProductLookup(); seen.length = 0; });
const upcStatus = () => productLookupStatus().sources.find((s) => s.key === "upc");

test("OPF 404 + UPCitemdb 200 is a find, counted per source, with the quota read from the headers", async () => {
  const r = await lookupProductName(CODE, { fetchImpl: route(OPF_404, () => UPC_OK()) });
  assert.equal(r.state, "found");
  assert.equal(r.name, "Teacher Created Resources Shapes and Colors Flash Cards");
  const st = productLookupStatus();
  assert.deepEqual(st.sources[0].counts, { "not found": 1 });
  assert.deepEqual(st.sources[1].counts, { found: 1 });
  assert.ok(st.sources[1].lastOkAt);
  assert.equal(st.sources[1].lastKind, null);
  assert.equal(st.sources[1].quota.remaining, 92);
  assert.equal(st.sources[1].quota.limit, 100);
  assert.equal(st.sources[1].quota.resetAt, 1793713526000);
});

test("429: failure 'limit', the kind and the service's short word are kept, a pause starts, later scans are 'paused' and keep the cause", async () => {
  const f = route(OPF_404, () => json({ code: "EXCEED_LIMIT", message: "daily limit" }, 429, { "X-RateLimit-Remaining": "0", "X-RateLimit-Limit": "100" }));
  const a = await lookupProductName(CODE, { fetchImpl: f });
  assert.equal(a.state, "unavailable");
  assert.equal(a.failure, "limit");
  assert.equal(upcStatus().lastKind, "http 429");
  assert.equal(upcStatus().lastReason, "EXCEED_LIMIT");
  assert.equal(upcStatus().quota.remaining, 0);
  assert.ok(productLookupStatus().pausedUntil > Date.now());
  const calls = seen.length;
  const b = await lookupProductName(CODE, { fetchImpl: f });
  assert.equal(b.failure, "limit");
  assert.equal(seen.length, calls + 1, "only Open Products Facts was asked again");
  assert.equal(upcStatus().counts.paused, 1);
  assert.equal(upcStatus().lastKind, "http 429", "a pause does not hide the failure behind it");
});

test("Retry-After sets the pause (clamped to 1 minute .. 1 hour)", async () => {
  const t = Date.now();
  await lookupProductName(CODE, { fetchImpl: route(OPF_404, () => json({}, 429, { "Retry-After": "7200" })), now: () => t });
  assert.equal(productLookupStatus(t).pausedUntil, t + 60 * 60 * 1000);
});

test("403, 500, timeout, network, unreadable: each its own kind and failure", async () => {
  const kinds = [];
  const hang = (init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" }))));
  const cases = [
    [() => json({}, 403), "http 403", "refused"],
    [() => json({}, 500), "http 500", "server"],
    [hang, "timeout", "timeout"],
    [() => { throw new TypeError("fetch failed"); }, "network", "network"],
    [() => new Response("<html>", { status: 200 }), "parse", "unreadable"],
  ];
  for (const [upc, kind, failure] of cases) {
    resetProductLookup();
    const r = await lookupProductName(CODE, { fetchImpl: route(OPF_404, upc), timeoutMs: 80 });
    assert.equal(r.state, "unavailable");
    assert.equal(r.failure, failure, kind);
    assert.equal(upcStatus().lastKind, kind);
    kinds.push(kind);
  }
  assert.equal(kinds.length, 5);
});

test("clean not-found at both sources stays 'missing' (no failure recorded)", async () => {
  const r = await lookupProductName(CODE, { fetchImpl: route(OPF_404, () => json({ code: "OK", total: 0, items: [] })) });
  assert.equal(r.state, "missing");
  assert.equal(productLookupStatus().sources[1].failures, 0);
});

test("without UPCITEMDB_USER_KEY: the free trial address and no key header; with it: the keyed address and the two headers, and the key is never in the status", async () => {
  await lookupProductName(CODE, { fetchImpl: route(OPF_404, () => UPC_OK()), env: {} });
  const free = seen.find((s) => s.url.includes("upcitemdb"));
  assert.equal(free.url, `https://api.upcitemdb.com/prod/trial/lookup?upc=${CODE}`);
  assert.equal(free.headers.user_key, undefined);
  resetProductLookup(); seen.length = 0;
  await lookupProductName(CODE, { fetchImpl: route(OPF_404, () => UPC_OK()), env: { UPCITEMDB_USER_KEY: " paid-secret " } });
  const paid = seen.find((s) => s.url.includes("upcitemdb"));
  assert.equal(paid.url, UPC_PAID_URL(CODE));
  assert.equal(paid.url, `https://api.upcitemdb.com/prod/v1/lookup?upc=${CODE}`);
  assert.equal(paid.headers.user_key, "paid-secret");
  assert.equal(paid.headers.key_type, "3scale");
  assert.equal(seen.find((s) => s.url.includes("openproductsfacts")).headers.user_key, undefined, "the key goes to UPCitemdb only");
  assert.doesNotMatch(JSON.stringify(productLookupStatus()), /paid-secret/);
});
