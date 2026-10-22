const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { configureServer, KEEP_ALIVE_TIMEOUT_MS, HEADERS_TIMEOUT_MS } = require("../../src/lib/serverConfig");

test("configureServer keeps idle connections open longer than the proxy does", () => {
  const server = http.createServer();
  assert.equal(server.keepAliveTimeout, 5000, "Node's default, which caused the sporadic 502s");
  assert.equal(configureServer(server), server);
  assert.equal(server.keepAliveTimeout, 65000);
  assert.equal(server.headersTimeout, 66000);
  assert.ok(server.headersTimeout > server.keepAliveTimeout, "headersTimeout must exceed keepAliveTimeout");
  assert.equal(KEEP_ALIVE_TIMEOUT_MS, 65000);
  assert.equal(HEADERS_TIMEOUT_MS, 66000);
});

test("the real server in src/index.js is configured with it", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "..", "src", "index.js"), "utf8");
  assert.match(src, /const server = configureServer\(app\.listen\(/);
});
