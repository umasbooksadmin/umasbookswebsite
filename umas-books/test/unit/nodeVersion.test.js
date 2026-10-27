const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { MINIMUM_NODE, compareVersions, checkNodeVersion } = require("../../src/lib/nodeVersion");

test("compareVersions compares numerically, not as text", () => {
  assert.equal(compareVersions("v22.23.4", "22.23.4"), 0);
  assert.equal(compareVersions("22.9.0", "22.23.4"), -1);
  assert.equal(compareVersions("22.23.10", "22.23.4"), 1);
  assert.equal(compareVersions("v23.0.0", "22.23.4"), 1);
  assert.equal(compareVersions("junk", "22.23.4"), null);
});

test("checkNodeVersion warns only for an older version of a known major", () => {
  assert.deepEqual(checkNodeVersion("v22.23.4"), { version: "v22.23.4", major: 22, minimum: "22.23.4", ok: true, known: true });
  assert.equal(checkNodeVersion("v22.23.3").ok, false);
  assert.equal(checkNodeVersion("v22.12.0").ok, false);
  assert.equal(checkNodeVersion("v22.24.0").ok, true);
  assert.equal(checkNodeVersion("v24.22.0").ok, false);
  assert.equal(checkNodeVersion("v24.22.1").ok, true);
  assert.equal(checkNodeVersion("v26.12.0").ok, false);
  assert.equal(checkNodeVersion("v26.12.1").ok, true);
  const unknown = checkNodeVersion("v28.0.0");
  assert.equal(unknown.ok, true);
  assert.equal(unknown.known, false);
  assert.equal(checkNodeVersion("nonsense").known, false);
});

test("the running Node meets the minimum, and .node-version pins an exact version at or above it", () => {
  assert.equal(checkNodeVersion().ok, true, `running ${process.version}`);
  const pinned = fs.readFileSync(path.join(__dirname, "../../.node-version"), "utf8").trim();
  assert.match(pinned, /^\d+\.\d+\.\d+$/, ".node-version is an exact version");
  assert.ok(compareVersions(pinned, MINIMUM_NODE[pinned.split(".")[0]]) >= 0, "pinned version >= minimum");
});
