// HelloAsso client: a 401 invalidates the cached access token and retries
// once; failures carry a `kind` so the reconcile sweep can tell an outage
// from one bad request. fetch is stubbed (offline).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

process.env.HELLOASSO_CLIENT_ID = "test-client-id";
process.env.HELLOASSO_CLIENT_SECRET = "test-client-secret";
process.env.HELLOASSO_ORG_SLUG = "test-org";

const { listRecentMembershipOrders } = require("../../src/lib/helloasso");

let originalFetch;
before(() => { originalFetch = global.fetch; });
after(() => { global.fetch = originalFetch; });

test("a 401 clears the cached token and retries once with a fresh one", async () => {
  let tokenN = 0;
  const bearers = [];
  global.fetch = async (url, opts) => {
    if (String(url).includes("/oauth2/token")) {
      tokenN++;
      return { ok: true, json: async () => ({ access_token: `tok-${tokenN}`, expires_in: 1800 }) };
    }
    bearers.push(opts.headers.Authorization);
    // Only tokens issued after the first work (rotated secret / revoked token).
    if (opts.headers.Authorization === "Bearer tok-1") {
      return { ok: false, status: 401, text: async () => "expired", json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  };
  assert.deepEqual(await listRecentMembershipOrders(), []);
  assert.deepEqual(bearers, ["Bearer tok-1", "Bearer tok-2"]);
  assert.equal(tokenN, 2);
  // The fresh token is cached: no further token request.
  await listRecentMembershipOrders();
  assert.equal(tokenN, 2);
});

test("a persistent 401 gives up after one retry, tagged as an auth error", async () => {
  let calls = 0;
  global.fetch = async (url) => {
    if (String(url).includes("/oauth2/token")) {
      return { ok: true, json: async () => ({ access_token: "t", expires_in: 1800 }) };
    }
    calls++;
    return { ok: false, status: 401, text: async () => "no", json: async () => ({}) };
  };
  await assert.rejects(listRecentMembershipOrders(), (err) => err.kind === "auth" && err.status === 401);
  assert.equal(calls, 2);
});

test("a fetch rejection is tagged as a network error", async () => {
  global.fetch = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(listRecentMembershipOrders(), (err) => err.kind === "network");
});
