// Pool resilience: an 'error' event on an idle pg client (DB restart,
// failover) must not become an unhandled 'error' that kills the process, the
// pool has bounded limits/timeouts, and /healthz answers 503 promptly when
// the query hangs instead of hanging with it.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/unused_never_connected";
const { pool } = require("../../src/db");
const { healthzHandler } = require("../../src/lib/health");

test("an 'error' event on the pool is handled, not thrown", () => {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(" "));
  try {
    assert.ok(pool.listenerCount("error") >= 1, "pool has an error listener");
    assert.doesNotThrow(() => pool.emit("error", new Error("terminating connection due to administrator command")));
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /administrator command/);
});

test("pool has bounded size and timeouts", () => {
  const o = pool.options;
  assert.equal(o.max, 20, "default DB_POOL_MAX");
  assert.equal(o.connectionTimeoutMillis, 10000);
  assert.equal(o.idleTimeoutMillis, 30000);
  assert.equal(o.statement_timeout, 30000);
  assert.equal(o.idle_in_transaction_session_timeout, 30000);
});

async function withHealthApp(stubPool, timeoutMs, fn) {
  const app = express();
  app.get("/healthz", healthzHandler(stubPool, timeoutMs));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => { server.close(r); server.closeAllConnections(); });
  }
}

test("/healthz returns 200 when the query succeeds", async () => {
  await withHealthApp({ query: async () => ({ rows: [{}] }) }, 3000, async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test("/healthz returns 503 quickly when the query hangs", async () => {
  const original = console.error;
  console.error = () => {};
  try {
    await withHealthApp({ query: () => new Promise(() => {}) }, 200, async (base) => {
      const started = Date.now();
      const res = await fetch(`${base}/healthz`);
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { ok: false });
      assert.ok(Date.now() - started < 2000, "failed fast");
    });
  } finally {
    console.error = original;
  }
});

test("the production default timeout is about 3 seconds", () => {
  assert.equal(require("../../src/lib/health").HEALTH_TIMEOUT_MS, 3000);
});

test.after(() => pool.end());
