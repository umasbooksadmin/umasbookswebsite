const { test } = require("node:test");
const assert = require("node:assert/strict");
const hosts = require("../../src/lib/helloassoHosts");
const { usesSandbox } = hosts;

test("only usesSandbox is exported: no payment-origin allowlist exists any more (nothing posts to HelloAsso)", () => {
  assert.deepEqual(Object.keys(hosts), ["usesSandbox"]);
});

test("a sandbox API base is recognised, production, unset and empty ones are not", () => {
  assert.equal(usesSandbox("https://api.helloasso-sandbox.com/v5"), true);
  assert.equal(usesSandbox("https://helloasso-sandbox.com"), true);
  assert.equal(usesSandbox("https://api.helloasso.com/v5"), false);
  assert.equal(usesSandbox(""), false);
  assert.equal(usesSandbox(undefined), false);
});

test("garbage or look-alike bases are never taken for the sandbox", () => {
  assert.equal(usesSandbox("not a url"), false);
  assert.equal(usesSandbox("https://evil.com/helloasso-sandbox.com"), false);
  assert.equal(usesSandbox("https://helloasso-sandbox.com.evil.com/v5"), false);
  assert.equal(usesSandbox("https://nothelloasso-sandbox.com/v5"), false);
});
