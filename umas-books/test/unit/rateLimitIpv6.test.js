// IPv6 clients are limited per /56, not per raw address, so rotating
// addresses inside one subscriber's prefix cannot dodge a cap. IPv4 keeps
// per-address buckets.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { limit } = require("../../src/middleware/rateLimits");

async function boot(max) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(limit({ windowMs: 60 * 1000, max }));
  app.get("/", (req, res) => res.send("ok"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    hit: async (ip) => (await fetch(base, { headers: { "x-forwarded-for": ip } })).status,
    close: () => { server.close(); server.closeAllConnections(); },
  };
}

test("addresses in the same /64 (and /56) share one bucket; unrelated ones do not", async () => {
  const s = await boot(2);
  try {
    assert.equal(await s.hit("2001:db8:abcd:12::1"), 200);
    assert.equal(await s.hit("2001:db8:abcd:12:ffff:1:2:3"), 200);
    assert.equal(await s.hit("2001:db8:abcd:12:aaaa::9"), 429, "same /64 is one bucket");
    assert.equal(await s.hit("2001:db8:abcd:34::1"), 429, "same /56, different /64, still one bucket");
    assert.equal(await s.hit("2001:db8:ffff:12::1"), 200, "different /56 has its own bucket");
  } finally { s.close(); }
});

test("IPv4 addresses keep separate buckets", async () => {
  const s = await boot(1);
  try {
    assert.equal(await s.hit("203.0.113.1"), 200);
    assert.equal(await s.hit("203.0.113.1"), 429);
    assert.equal(await s.hit("203.0.113.2"), 200);
  } finally { s.close(); }
});
