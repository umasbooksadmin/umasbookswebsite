// Responses to a logged-in user are no-store (even when the route sets
// its own public Cache-Control); anonymous responses and /img/ keep theirs.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { noStoreForUsers } = require("../../src/middleware/noStoreForUsers");

let server;
let base;
before(async () => {
  const app = express();
  app.use((req, res, next) => { res.locals.user = req.get("x-user") ? { id: 1 } : null; next(); });
  app.use(noStoreForUsers);
  app.get("/page", (req, res) => res.send("hi"));
  app.get("/api/public", (req, res) => { res.set("Cache-Control", "public, max-age=300"); res.json({}); });
  app.get("/img/x", (req, res) => { res.set("Cache-Control", "public, max-age=86400"); res.send("bytes"); });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); server.closeAllConnections(); });

const get = async (p, user) => {
  const res = await fetch(base + p, { headers: user ? { "x-user": "1" } : {} });
  await res.text();
  return res.headers;
};

test("logged-in HTML and JSON are no-store with Pragma: no-cache", async () => {
  for (const p of ["/page", "/api/public"]) {
    const h = await get(p, true);
    assert.equal(h.get("cache-control"), "no-store", p);
    assert.equal(h.get("pragma"), "no-cache", p);
  }
});

test("anonymous responses keep the route's own caching", async () => {
  assert.equal((await get("/api/public", false)).get("cache-control"), "public, max-age=300");
  assert.equal((await get("/page", false)).get("cache-control"), null);
});

test("/img/ is left cacheable even when logged in", async () => {
  assert.equal((await get("/img/x", true)).get("cache-control"), "public, max-age=86400");
});
