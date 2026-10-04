// Regression coverage: the multer upload middleware for /admin/inventory,
// /admin/announcements, /admin/charities and /admin/blog used to be
// mounted ahead of any auth check, so an anonymous request could make
// the server buffer an upload (up to 8MB) into memory before requireAdmin
// ever ran. requireAdmin is now mounted ahead of multer itself
// (src/index.js) — this just confirms an unauthenticated request is
// turned away and never reaches the upload-handling logic at all.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");

const PORT = 3415; // distinct from other integration test files
let app;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
});

after(() => {
  app.stop();
});

const GATED_PATHS = ["/admin/inventory", "/admin/announcements", "/admin/charities", "/admin/blog"];

for (const path of GATED_PATHS) {
  test(`an anonymous multipart POST to ${path} is turned away before reaching the form`, async () => {
    const body = new FormData();
    body.append("title", "Anonymous upload attempt");
    body.append("coverPhoto", new Blob([new Uint8Array(1024)], { type: "image/jpeg" }), "cover.jpg");

    const res = await fetch(`${app.base}${path}`, { method: "POST", redirect: "manual", body });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/login");
  });
}
