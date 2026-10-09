"use strict";

// Permissions-Policy header (lib/permissionsPolicy.js) and the marketing CSP's
// upgrade-insecure-requests directive.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PERMISSIONS_POLICY, permissionsPolicy } = require("../../src/lib/permissionsPolicy");
const { marketingCsp, buildMarketingCsp } = require("../../src/lib/marketingCsp");

test("Permissions-Policy switches camera, microphone, geolocation, payment and usb off", () => {
  for (const f of ["camera", "microphone", "geolocation", "payment", "usb"]) {
    assert.ok(PERMISSIONS_POLICY.split(", ").includes(`${f}=()`), f);
  }
  assert.doesNotMatch(PERMISSIONS_POLICY, /\*|self/, "nothing is allowed anywhere");
});

test("the middleware sets the header and calls next", () => {
  const headers = {};
  let called = false;
  permissionsPolicy({}, { setHeader: (k, v) => { headers[k] = v; } }, () => { called = true; });
  assert.equal(headers["Permissions-Policy"], PERMISSIONS_POLICY);
  assert.ok(called);
});

test("no page script uses getUserMedia (so camera=() is safe)", () => {
  const root = path.join(__dirname, "..", "..");
  const dirs = [path.join(root, "public"), path.join(root, "views"), path.join(root, "..", "assets")];
  const walk = (d) => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];
  for (const f of dirs.flatMap(walk).filter((f) => /\.(js|ejs|html)$/.test(f))) {
    assert.doesNotMatch(fs.readFileSync(f, "utf8"), /getUserMedia|mediaDevices/, f);
  }
});

test("marketing CSP includes upgrade-insecure-requests (as the app pages do)", () => {
  assert.ok(marketingCsp().split("; ").includes("upgrade-insecure-requests"));
  assert.ok(buildMarketingCsp(["'self'"]).endsWith("upgrade-insecure-requests"));
});
