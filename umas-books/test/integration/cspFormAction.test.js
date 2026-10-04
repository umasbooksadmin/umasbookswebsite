// Chromium applies form-action to the redirect after a form POST, so the
// checkout's 302 to the HelloAsso payment page is blocked unless those
// origins are in form-action. Checked on an app page (/cart) and a
// marketing page, for a production-configured and a sandbox-configured app.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");

let prod;
let sandbox;
before(async () => {
  prod = await startTestApp({ port: 3990, env: { HELLOASSO_API_BASE: "" } });
  sandbox = await startTestApp({ port: 3991, env: { HELLOASSO_API_BASE: "https://api.helloasso-sandbox.com/v5" } });
});
after(() => {
  prod.stop();
  sandbox.stop();
});

function formAction(csp) {
  const d = csp.split(";").map((x) => x.trim()).find((x) => x.startsWith("form-action"));
  assert.ok(d, `no form-action in: ${csp}`);
  return d.split(/\s+/).slice(1);
}

async function check(app, path, expected) {
  const res = await fetch(`${app.base}${path}`);
  assert.equal(res.status, 200, path);
  assert.deepEqual(formAction(res.headers.get("content-security-policy")), expected, path);
}

const PROD = ["'self'", "https://www.helloasso.com", "https://checkout.helloasso.com"];
const SANDBOX = ["https://www.helloasso-sandbox.com", "https://checkout.helloasso-sandbox.com"];

test("cart page and marketing page allow 'self' + production HelloAsso hosts only", async () => {
  await check(prod, "/cart", PROD);
  await check(prod, "/membership.html", PROD);
});

test("sandbox hosts appear only when HELLOASSO_API_BASE is the sandbox", async () => {
  await check(sandbox, "/cart", [...PROD, ...SANDBOX]);
  await check(sandbox, "/membership.html", [...PROD, ...SANDBOX]);
});
