// Graceful shutdown (SIGTERM/SIGINT) and the server `error` handler.
// Ports 3460 (helper-managed app, also used to provoke EADDRINUSE),
// 3461 (SIGTERM-with-in-flight-request), 3462 (SIGINT).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { startTestApp } = require("../helpers/testApp");

const ROOT = path.join(__dirname, "..", "..");
let app;

before(async () => {
  app = await startTestApp({ port: 3460, isolated: true });
});
after(() => app.stop());

function spawnApp(port) {
  const child = spawn("node", ["src/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: app.databaseUrl,
      PGSSLMODE: "disable",
      PORT: String(port),
      SESSION_SECRET: "test-session-secret-not-for-production",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = { text: "" };
  child.stdout.on("data", (d) => (out.text += d));
  child.stderr.on("data", (d) => (out.text += d));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, out, exited };
}

async function waitHealthy(port) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server never healthy");
}

const portIsFree = (port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });

test("SIGTERM lets an in-flight request finish, then exits 0 and frees the port", async () => {
  const port = 3461;
  const { child, out, exited } = spawnApp(port);
  await waitHealthy(port);

  // Open a request whose body is deliberately incomplete: it is "in flight"
  // from the server's point of view until we send the last bytes.
  const sock = net.connect(port, "127.0.0.1");
  let response = "";
  sock.on("data", (d) => (response += d));
  await new Promise((r) => sock.once("connect", r));
  sock.write("POST /login HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 5\r\n\r\na=");
  await new Promise((r) => setTimeout(r, 300));

  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 700));

  // Still draining: process alive, no new connections accepted.
  assert.equal(child.exitCode, null, "process must wait for the in-flight request");
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`), "new connections must be refused while draining");

  // Finish the request: it must get a real HTTP response (not a reset).
  sock.write("b&c");
  const result = await exited;
  sock.destroy();
  assert.match(response, /^HTTP\/1\.1 \d{3}/, "in-flight request received a response");
  assert.equal(result.code, 0, `expected exit 0, got ${JSON.stringify(result)}\n${out.text}`);
  assert.match(out.text, /shutting down gracefully/);
  assert.doesNotMatch(out.text, /Unhandled|Uncaught|Error closing/);
  assert.equal(await portIsFree(port), true, "port released");
});

test("SIGINT with no traffic exits 0 promptly", async () => {
  const port = 3462;
  const { child, out, exited } = spawnApp(port);
  await waitHealthy(port);
  const started = Date.now();
  child.kill("SIGINT");
  const result = await exited;
  assert.equal(result.code, 0, out.text);
  assert.ok(Date.now() - started < 5000, "exits well before the 10s hard-exit fallback");
  assert.doesNotMatch(out.text, /Unhandled|Uncaught/);
});

test("port already in use: clear message and exit 1 (not an uncaught-exception stack)", async () => {
  const { out, exited } = spawnApp(3460); // 3460 is held by the helper-managed app
  const result = await exited;
  assert.equal(result.code, 1, out.text);
  assert.match(out.text, /Port 3460 is already in use/);
  assert.doesNotMatch(out.text, /Uncaught exception/);
});
