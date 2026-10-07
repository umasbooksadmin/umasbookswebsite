const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

process.env.HELLOASSO_CLIENT_ID = "test-client-id";
process.env.HELLOASSO_CLIENT_SECRET = "test-client-secret";
process.env.HELLOASSO_ORG_SLUG = "test-org";

const { reconcileRecentMemberships } = require("../../src/lib/membership");

let originalFetch;
before(() => { originalFetch = global.fetch; });
after(() => { global.fetch = originalFetch; });

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

// Fake pool: users lookup returns nothing, so sync stops after the
// HelloAsso lookup — we only count which emails got looked up.
function run(orders) {
  const looked = [];
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/oauth2/token")) {
      return { ok: true, json: async () => ({ access_token: "t", expires_in: 1800 }) };
    }
    if (u.includes("userSearchKey=")) {
      looked.push(decodeURIComponent(new URL(u).searchParams.get("userSearchKey")));
      return { ok: true, json: async () => ({ data: [] }) };
    }
    return { ok: true, json: async () => ({ data: orders }) };
  };
  return reconcileRecentMemberships({ query: async () => ({ rows: [] }) }).then(() => looked);
}

test("syncs each distinct recent payer once, skips old orders", async () => {
  const looked = await run([
    { id: 1, date: daysAgo(1), payer: { email: "A@example.com" } },
    { id: 2, date: daysAgo(2), payer: { email: "a@example.com" } },
    { id: 3, date: daysAgo(30), payer: { email: "old@example.com" } },
    { id: 4, date: daysAgo(1), payer: null },
  ]);
  assert.deepEqual(looked, ["a@example.com"]);
});

test("a payer whose check fails does not stop the others, but the run fails (so the job tracker sees it)", async () => {
  const looked = [];
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/oauth2/token")) return { ok: true, json: async () => ({ access_token: "t", expires_in: 1800 }) };
    if (u.includes("userSearchKey=")) {
      looked.push(decodeURIComponent(new URL(u).searchParams.get("userSearchKey")));
      return { ok: false, status: 500, text: async () => "boom", json: async () => ({}) };
    }
    return { ok: true, json: async () => ({ data: [
      { id: 1, date: daysAgo(1), payer: { email: "one@example.com" } },
      { id: 2, date: daysAgo(1), payer: { email: "two@example.com" } },
    ] }) };
  };
  const realError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(() => reconcileRecentMemberships({ query: async () => ({ rows: [] }) }), /2 of 2 membership check\(s\) failed/);
  } finally {
    console.error = realError;
  }
  assert.deepEqual(looked.sort(), ["one@example.com", "two@example.com"], "every payer was still tried");
});
