// A non-numeric or out-of-range id in a public URL is a normal 404 page,
// not a 500 (which would also email the admin an alert and use up the
// alert throttle window). The id check lives in middleware/idParams.js;
// this walks the public routes that take an :id.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");

const PORT = 3851;
let app;
before(async () => { app = await startTestApp({ port: PORT, isolated: true }); });
after(async () => { await app.stop(); });

const BAD = ["abc", "1.5", "-1", "0", "99999999999", "1e3", "%20"];

test("GET /books/<bad id> is a 404 for every kind of bad id", async () => {
  for (const id of BAD) {
    const res = await fetch(`${app.base}/books/${id}`);
    assert.equal(res.status, 404, `/books/${id}`);
    assert.match(await res.text(), /<html/i);
  }
});

test("other public id routes also 404 instead of 500", async () => {
  for (const url of ["/events/abc/ics", "/forum/abc", "/books/abc/reserve"]) {
    const res = await fetch(`${app.base}${url}`, { redirect: "manual" });
    assert.ok(res.status < 500, `${url} must not be a 5xx, got ${res.status}`);
  }
});

test("a valid id for a book that does not exist is still a 404", async () => {
  assert.equal((await fetch(`${app.base}/books/2147483647`)).status, 404);
});
