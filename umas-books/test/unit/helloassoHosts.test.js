const { test } = require("node:test");
const assert = require("node:assert/strict");
const { helloassoPaymentOrigins } = require("../../src/lib/helloassoHosts");

const PROD = ["https://www.helloasso.com", "https://checkout.helloasso.com"];
const SANDBOX = ["https://www.helloasso-sandbox.com", "https://checkout.helloasso-sandbox.com"];

test("production API base (or unset) allows only the production hosts", () => {
  assert.deepEqual(helloassoPaymentOrigins("https://api.helloasso.com/v5"), PROD);
  assert.deepEqual(helloassoPaymentOrigins(""), PROD);
  assert.deepEqual(helloassoPaymentOrigins(undefined), PROD);
});

test("sandbox API base adds the sandbox hosts", () => {
  assert.deepEqual(helloassoPaymentOrigins("https://api.helloasso-sandbox.com/v5"), [...PROD, ...SANDBOX]);
});

test("garbage or look-alike bases never enable the sandbox hosts", () => {
  assert.deepEqual(helloassoPaymentOrigins("not a url"), PROD);
  assert.deepEqual(helloassoPaymentOrigins("https://evil.com/helloasso-sandbox.com"), PROD);
  assert.deepEqual(helloassoPaymentOrigins("https://helloasso-sandbox.com.evil.com/v5"), PROD);
});

test("no wildcards in the allowlist", () => {
  for (const o of helloassoPaymentOrigins("https://api.helloasso-sandbox.com/v5")) assert.ok(!o.includes("*"), o);
});
