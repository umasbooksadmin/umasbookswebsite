// form-action is 'self' ONLY. Nothing posts to HelloAsso (books and drop-in
// seats are reserved on the site and paid in the shop; the membership form is an
// iframe, allowed by frame-src on the marketing pages, plus a plain link), and no
// redirect to a payment page follows a form POST any more. Checked on an app page
// (/cart) and a marketing page, for a production-configured and a
// sandbox-configured app: the sandbox changes nothing here.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");

let prod;
let sandbox;
before(async () => {
  prod = await startTestApp({ port: 3990, isolated: true, env: { HELLOASSO_API_BASE: "" } });
  sandbox = await startTestApp({ port: 3991, isolated: true, env: { HELLOASSO_API_BASE: "https://api.helloasso-sandbox.com/v5" } });
});
after(() => {
  prod.stop();
  sandbox.stop();
});

function directive(csp, name) {
  const d = csp.split(";").map((x) => x.trim()).find((x) => x.startsWith(`${name} `) || x === name);
  return d ? d.split(/\s+/).slice(1) : null;
}

async function check(app, path, expected) {
  const res = await fetch(`${app.base}${path}`);
  assert.equal(res.status, 200, path);
  const csp = res.headers.get("content-security-policy");
  assert.deepEqual(directive(csp, "form-action"), expected, path);
  assert.doesNotMatch(csp, /form-action[^;]*helloasso/i, `${path}: no HelloAsso host in form-action`);
  return csp;
}

test("cart page and marketing page: form-action is 'self' only (production configuration)", async () => {
  await check(prod, "/cart", ["'self'"]);
  await check(prod, "/membership.html", ["'self'"]);
});

test("the same in the sandbox configuration: no sandbox host is added to form-action", async () => {
  await check(sandbox, "/cart", ["'self'"]);
  await check(sandbox, "/membership.html", ["'self'"]);
});

test("the membership page can still frame the HelloAsso membership form (frame-src), in both configurations", async () => {
  for (const app of [prod, sandbox]) {
    const csp = await check(app, "/membership.html", ["'self'"]);
    assert.deepEqual(directive(csp, "frame-src"), ["https://www.helloasso.com"]);
  }
});
