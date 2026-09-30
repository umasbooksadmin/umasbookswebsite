const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

// findMembershipOrdersByEmail talks to HelloAsso's real API via the
// global fetch — mocked here so this stays a fast, offline unit test of
// just the exact-match filtering, not a live-credentials integration
// test. HELLOASSO_* env vars only need to be non-empty to pass
// isConfigured()'s check; their values are never used since fetch itself
// is mocked.
process.env.HELLOASSO_CLIENT_ID = "test-client-id";
process.env.HELLOASSO_CLIENT_SECRET = "test-client-secret";
process.env.HELLOASSO_ORG_SLUG = "test-org";

const { findMembershipOrdersByEmail } = require("../../src/lib/helloasso");

let originalFetch;
before(() => {
  originalFetch = global.fetch;
});
after(() => {
  global.fetch = originalFetch;
});

function mockOrdersResponse(orders) {
  global.fetch = async (url) => {
    if (String(url).includes("/oauth2/token")) {
      return { ok: true, json: async () => ({ access_token: "fake-token", expires_in: 1800 }) };
    }
    return { ok: true, json: async () => ({ data: orders }) };
  };
}

test("keeps only orders whose payer email exactly matches (case-insensitively)", async () => {
  mockOrdersResponse([
    { id: 1, payer: { email: "sam@example.com" } },
    { id: 2, payer: { email: "SAM@EXAMPLE.COM" } },
    { id: 3, payer: { email: "samantha@example.com" } }, // HelloAsso's fuzzy userSearchKey could return this
    { id: 4, payer: { firstName: "Sam" } }, // matched on name, not email at all
  ]);

  const orders = await findMembershipOrdersByEmail("sam@example.com");
  assert.deepEqual(orders.map((o) => o.id).sort(), [1, 2]);
});

test("drops an order with no payer email at all rather than throwing", async () => {
  mockOrdersResponse([{ id: 1, payer: null }, { id: 2 }, { id: 3, payer: { email: "sam@example.com" } }]);

  const orders = await findMembershipOrdersByEmail("sam@example.com");
  assert.deepEqual(orders.map((o) => o.id), [3]);
});

test("returns an empty array when nothing matches exactly", async () => {
  mockOrdersResponse([{ id: 1, payer: { email: "someoneelse@example.com" } }]);

  const orders = await findMembershipOrdersByEmail("sam@example.com");
  assert.deepEqual(orders, []);
});

test("every outbound HelloAsso request carries a timeout signal", async () => {
  const signals = [];
  global.fetch = async (url, opts) => {
    signals.push(opts && opts.signal);
    if (String(url).includes("/oauth2/token")) {
      return { ok: true, json: async () => ({ access_token: "fake-token", expires_in: 1 }) };
    }
    return { ok: true, json: async () => ({ data: [] }) };
  };
  await findMembershipOrdersByEmail("sam@example.com");
  assert.ok(signals.length >= 1);
  for (const s of signals) assert.ok(s instanceof AbortSignal);
});
