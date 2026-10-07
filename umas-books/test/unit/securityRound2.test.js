// Pure/unit parts of the second security review: /healthz cache (9), cover address
// classes and DNS pinning (6), login throttle (13).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { healthzHandler } = require("../../src/lib/health");
const { isPublicAddress, fetchCoverImage } = require("../../src/lib/coverStore");
const { createLoginThrottle } = require("../../src/lib/loginThrottle");

// ---------- 9 ----------

async function withApp(handler, fn) {
  const app = express();
  app.get("/healthz", handler);
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  try { await fn(`http://127.0.0.1:${server.address().port}/healthz`); }
  finally { await new Promise((r) => { server.close(r); server.closeAllConnections(); }); }
}

test("/healthz: the SELECT 1 result is reused for 3 seconds, a failure is cached too, then it re-checks", async () => {
  let calls = 0; let fail = false; let clock = 1000;
  const pool = { query: async () => { calls++; if (fail) throw new Error("db down"); return {}; } };
  const log = console.error; console.error = () => {};
  try {
    await withApp(healthzHandler(pool, 500, { cacheMs: 3000, now: () => clock }), async (url) => {
      assert.equal((await fetch(url)).status, 200);
      assert.equal((await fetch(url)).status, 200);
      assert.equal(calls, 1, "second request answered from the cache");
      fail = true; clock += 2999;
      assert.equal((await fetch(url)).status, 200, "still inside the 3 s window");
      assert.equal(calls, 1);
      clock += 2;
      assert.equal((await fetch(url)).status, 503, "re-checked, failed");
      assert.equal(calls, 2);
      assert.equal((await fetch(url)).status, 503, "the failure is cached and answers 503");
      assert.equal(calls, 2);
      fail = false; clock += 3001;
      assert.equal((await fetch(url)).status, 200, "recovers");
    });
  } finally { console.error = log; }
});

test("/healthz: parallel requests share one query", async () => {
  let calls = 0;
  const pool = { query: () => new Promise((r) => { calls++; setTimeout(r, 50); }) };
  await withApp(healthzHandler(pool, 1000, { cacheMs: 0 }), async (url) => {
    const rs = await Promise.all(Array.from({ length: 6 }, () => fetch(url)));
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal(calls, 1);
  });
});

test("/healthz: the default cache is 3 seconds", async () => {
  assert.equal(require("../../src/lib/health").HEALTH_CACHE_MS, 3000);
  let calls = 0;
  await withApp(healthzHandler({ query: async () => { calls++; } }), async (url) => {
    await fetch(url); await fetch(url); await fetch(url);
    assert.equal(calls, 1, "production defaults answer repeated requests from the cache");
  });
});

// ---------- 6 ----------

test("cover fetch: every non-public address class is refused", () => {
  const blocked = {
    "IPv4 this-network": ["0.0.0.0", "0.1.2.3"],
    "IPv4 private": ["10.0.0.1", "172.16.5.5", "172.31.255.255", "192.168.0.1"],
    "IPv4 loopback": ["127.0.0.1", "127.255.0.9"],
    "IPv4 link-local / metadata": ["169.254.169.254", "169.254.0.1"],
    "IPv4 CGNAT": ["100.64.0.1", "100.127.255.254"],
    "IPv4 multicast": ["224.0.0.1", "239.255.255.250"],
    "IPv4 reserved / broadcast": ["240.0.0.1", "255.255.255.255", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1"],
    "IPv6 loopback/unspecified": ["::1", "::"],
    "IPv6 unique local": ["fc00::1", "fd12:3456::1"],
    "IPv6 link-local": ["fe80::1", "febf::1"],
    "IPv6 multicast": ["ff02::1", "ff0e::1"],
    "IPv4-mapped dotted": ["::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::FFFF:192.168.1.1"],
    "IPv4-mapped hex": ["::ffff:7f00:1", "::ffff:a00:1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:7f00:1"],
    "NAT64": ["64:ff9b::7f00:1", "64:ff9b::808:808", "64:ff9b::10.0.0.1"],
    "6to4": ["2002:7f00:1::1", "2002:808:808::"],
    "Teredo": ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001::1"],
    "garbage": ["", "not-an-ip", "999.1.1.1", "fe80::1%eth0", null, undefined, 5],
  };
  for (const [name, list] of Object.entries(blocked)) for (const ip of list) assert.equal(isPublicAddress(ip), false, `${name}: ${ip}`);
  // Public addresses stay allowed, including the neighbours of blocked ranges.
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "172.15.255.255", "100.63.255.255", "100.128.0.1", "169.253.0.1", "11.0.0.1", "223.255.255.255", "2606:2800:220:1:248:1893:25c8:1946", "2a00:1450:4007::1", "::ffff:808:808", "::ffff:8.8.8.8"]) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test("cover fetch: the name is resolved ONCE and the connection is pinned to the checked address (no DNS rebinding window)", async () => {
  let lookups = 0;
  const lookup = async () => { lookups++; return [{ address: lookups === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }]; };
  const seen = [];
  const png = Buffer.from("not an image");
  const fetchImpl = async (url, init) => {
    seen.push({ url, pinned: init.pinnedAddress });
    return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
  };
  const out = await fetchCoverImage("https://covers.openlibrary.org/b/id/1-L.jpg", { fetchImpl, lookup });
  assert.equal(out.toString(), "not an image");
  assert.equal(lookups, 1, "one DNS resolution");
  assert.deepEqual(seen, [{ url: "https://covers.openlibrary.org/b/id/1-L.jpg", pinned: "93.184.216.34" }]);
});

test("cover fetch: a redirect to another allowed host is resolved and pinned separately; an internal answer is refused", async () => {
  const answers = { "covers.openlibrary.org": "93.184.216.34", "archive.org": "10.0.0.5" };
  const lookup = async (h) => [{ address: answers[h], family: 4 }];
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: "https://archive.org/x.jpg" } });
  await assert.rejects(() => fetchCoverImage("https://covers.openlibrary.org/a.jpg", { fetchImpl, lookup }), /public address/);
  // One private address among several is enough to refuse the host.
  const mixed = async () => [{ address: "93.184.216.34", family: 4 }, { address: "::ffff:7f00:1", family: 6 }];
  await assert.rejects(() => fetchCoverImage("https://covers.openlibrary.org/a.jpg", { fetchImpl: async () => new Response("x"), lookup: mixed }), /public address/);
});

// ---------- 13 ----------

test("login throttle: 5 failures lock one (account, IP) pair for 15 minutes; other addresses are unaffected", () => {
  let t = 0;
  const lt = createLoginThrottle({ now: () => t });
  for (let i = 0; i < 4; i++) lt.recordFailure(1, "1.1.1.1");
  assert.equal(lt.isBlocked(1, "1.1.1.1"), null);
  lt.recordFailure(1, "1.1.1.1");
  assert.equal(lt.isBlocked(1, "1.1.1.1"), "pair");
  assert.equal(lt.isBlocked(1, "2.2.2.2"), null, "the owner's address is free");
  assert.equal(lt.isBlocked(2, "1.1.1.1"), null, "other accounts are free");
  t += 14 * 60 * 1000;
  assert.equal(lt.isBlocked(1, "1.1.1.1"), "pair");
  t += 61 * 1000;
  assert.equal(lt.isBlocked(1, "1.1.1.1"), null, "lock over");
});

test("login throttle: a success clears the pair and remembers the address", () => {
  const lt = createLoginThrottle({ now: () => 0 });
  for (let i = 0; i < 4; i++) lt.recordFailure(1, "1.1.1.1");
  lt.recordSuccess(1, "1.1.1.1");
  for (let i = 0; i < 4; i++) lt.recordFailure(1, "1.1.1.1");
  assert.equal(lt.isBlocked(1, "1.1.1.1"), null, "counter restarted");
});

test("login throttle: 20 failures from many addresses throttle the account for unknown addresses only", () => {
  let t = 0;
  const lt = createLoginThrottle({ now: () => t });
  lt.recordSuccess(1, "9.9.9.9"); // the owner's usual address
  for (let i = 0; i < 20; i++) lt.recordFailure(1, `3.3.3.${i}`);
  assert.equal(lt.isBlocked(1, "4.4.4.4"), "account", "a new address is refused");
  assert.equal(lt.isBlocked(1, "9.9.9.9"), null, "the owner's usual address is not");
  assert.equal(lt.isBlocked(2, "4.4.4.4"), null);
  t += 15 * 60 * 1000 + 1;
  assert.equal(lt.isBlocked(1, "4.4.4.4"), null, "window over");
});

test("login throttle: an address that failed 5 times does not lock itself out of a DIFFERENT account", () => {
  const lt = createLoginThrottle({ now: () => 0 });
  for (let i = 0; i < 5; i++) lt.recordFailure(1, "1.1.1.1");
  assert.equal(lt.isBlocked(3, "1.1.1.1"), null);
});
