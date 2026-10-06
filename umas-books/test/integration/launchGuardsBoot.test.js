// Launch safety, part 2 (real server booted as NODE_ENV=production with
// preview OFF): the host redirect (the boot alerts are unit-tested in env.test.js).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { startTestApp } = require("../helpers/testApp");

const PORT = 4102;
let app;

before(async () => {
  app = await startTestApp({
    port: PORT,
    isolated: true,
    env: {
      NODE_ENV: "production",
      PREVIEW_MODE: "",
      TOTP_ENCRYPTION_KEY: "test-totp-key-not-for-production-0123456789",
      APP_BASE_URL: "https://umasbooks.example",
      HELLOASSO_API_BASE: "https://api.helloasso-sandbox.com/v5",
      HELLOASSO_CLIENT_ID: "", HELLOASSO_CLIENT_SECRET: "", HELLOASSO_ORG_SLUG: "",
      GMAIL_USER: "", GMAIL_APP_PASSWORD: "", CONTACT_TO: "",
    },
  });
});
after(() => app.stop());

const request = (method, path, host) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port: PORT, method, path, headers: { host } }, (res) => {
    res.resume();
    res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location }));
  });
  r.on("error", reject);
  r.end();
});

test("the *.onrender.com host is redirected for GET, /healthz and POST are not", async () => {
  const onrender = "umas-books-cmvv.onrender.com";
  const r = await request("GET", "/books.html?x=1", onrender);
  assert.equal(r.status, 301);
  assert.equal(r.location, "https://umasbooks.example/books.html?x=1");
  assert.equal((await request("GET", "/healthz", onrender)).status, 200);
  assert.notEqual((await request("POST", "/webhooks/helloasso", onrender)).status, 301);
  assert.notEqual((await request("POST", "/login", onrender)).status, 301);
  assert.equal((await request("GET", "/healthz", "umasbooks.example")).status, 200);
});
