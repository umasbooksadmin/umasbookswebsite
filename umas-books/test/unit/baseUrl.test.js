const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { baseUrl, configuredBaseUrl } = require("../../src/lib/baseUrl");

const KEYS = ["NODE_ENV", "PREVIEW_MODE", "APP_BASE_URL", "RENDER_EXTERNAL_URL"];
let saved;
beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); KEYS.forEach((k) => delete process.env[k]); });
afterEach(() => { KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))); });
const req = { protocol: "http", get: () => "localhost:3000" };

test("live site: only APP_BASE_URL; never RENDER_EXTERNAL_URL", () => {
  process.env.NODE_ENV = "production";
  process.env.RENDER_EXTERNAL_URL = "https://x.onrender.com";
  assert.throws(() => baseUrl(req), /APP_BASE_URL must be set/);
  assert.equal(configuredBaseUrl(), "");
  process.env.APP_BASE_URL = "https://umasbooks.org/";
  assert.equal(baseUrl(req), "https://umasbooks.org");
  assert.equal(configuredBaseUrl(), "https://umasbooks.org");
});

test("preview in production keeps the RENDER_EXTERNAL_URL fallback", () => {
  process.env.NODE_ENV = "production";
  process.env.PREVIEW_MODE = "true";
  process.env.RENDER_EXTERNAL_URL = "https://x.onrender.com";
  assert.equal(baseUrl(req), "https://x.onrender.com");
});

test("development falls back to the request host", () => {
  assert.equal(baseUrl(req), "http://localhost:3000");
});
