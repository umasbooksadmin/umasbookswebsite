// Real client IP behind Cloudflare -> Render edge -> app. Express's numeric
// `trust proxy` takes the Nth address from the RIGHT, so anything a visitor
// writes at the left of X-Forwarded-For can never become req.ip.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { resolveTrustProxyHops } = require("../../src/lib/trustProxy");
const { ipKey } = require("../../src/middleware/rateLimits");

test("hops: default 2 in production, 1 elsewhere; valid override; invalid falls back with an error", () => {
  assert.deepEqual(resolveTrustProxyHops({ NODE_ENV: "production" }), { hops: 2, error: null });
  assert.deepEqual(resolveTrustProxyHops({ NODE_ENV: "test" }), { hops: 1, error: null });
  assert.deepEqual(resolveTrustProxyHops({}), { hops: 1, error: null });
  assert.equal(resolveTrustProxyHops({ NODE_ENV: "production", TRUST_PROXY_HOPS: "3" }).hops, 3);
  assert.equal(resolveTrustProxyHops({ TRUST_PROXY_HOPS: " 5 " }).hops, 5);
  for (const bad of ["0", "6", "-1", "1.5", "abc", "2 hops", "true"]) {
    const r = resolveTrustProxyHops({ NODE_ENV: "production", TRUST_PROXY_HOPS: bad });
    assert.equal(r.hops, 2, `${bad} falls back`);
    assert.match(r.error, /TRUST_PROXY_HOPS/);
  }
  assert.equal(resolveTrustProxyHops({ NODE_ENV: "production", TRUST_PROXY_HOPS: "" }).error, null, "blank = unset");
});

async function keyFor(hops, xff) {
  const app = express();
  app.set("trust proxy", hops);
  app.get("/", (req, res) => res.json({ ip: req.ip, key: ipKey(req) }));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: xff ? { "x-forwarded-for": xff } : {} });
    return await res.json();
  } finally { server.close(); server.closeAllConnections(); }
}

test("hops 1: the last X-Forwarded-For entry; spoofed prefix ignored", async () => {
  assert.equal((await keyFor(1, "203.0.113.5")).key, "203.0.113.5");
  assert.equal((await keyFor(1, "6.6.6.6, 203.0.113.5")).key, "203.0.113.5");
});

test("hops 2: Nth from the right (client, edge); spoofed prefix ignored", async () => {
  assert.equal((await keyFor(2, "203.0.113.5, 172.70.1.1")).key, "203.0.113.5");
  assert.equal((await keyFor(2, "6.6.6.6, 203.0.113.5, 172.70.1.1")).key, "203.0.113.5");
  assert.equal((await keyFor(2, "9.9.9.9, 6.6.6.6, 203.0.113.5, 172.70.1.1")).key, "203.0.113.5");
});

test("hops 3: three trusted hops; spoofed prefix ignored", async () => {
  assert.equal((await keyFor(3, "203.0.113.5, 172.70.1.1, 10.0.0.9")).key, "203.0.113.5");
  assert.equal((await keyFor(3, "6.6.6.6, 203.0.113.5, 172.70.1.1, 10.0.0.9")).key, "203.0.113.5");
});

test("with hops 2 a chain that is too short degrades to the edge address, never to a spoofable one", async () => {
  // Only one XFF entry although 2 hops are trusted: the leftmost real address is used.
  assert.equal((await keyFor(2, "203.0.113.5")).key, "203.0.113.5");
  assert.equal((await keyFor(2, null)).key, "127.0.0.1");
});

test("IPv6 client in the chain is bucketed by /56", async () => {
  assert.equal((await keyFor(2, "2001:db8:abcd:12::77, 172.70.1.1")).key, "2001:db8:abcd::/56");
});
