// createApp() must be importable and callable by a test: requiring src/app.js and calling it
// starts nothing (no listening server, no interval, no job timer, no process handler).
const { test } = require("node:test");
const assert = require("node:assert/strict");

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/never_connected_createapp_test";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-not-for-production";

const SIGNALS = ["SIGTERM", "SIGINT", "uncaughtException", "unhandledRejection"];

function watchTimers() {
  const made = { intervals: [], timeouts: [] };
  const realSetInterval = global.setInterval;
  const realSetTimeout = global.setTimeout;
  global.setInterval = (...a) => { const t = realSetInterval(...a); made.intervals.push(t); return t; };
  global.setTimeout = (...a) => { const t = realSetTimeout(...a); made.timeouts.push(t); return t; };
  made.stop = () => { global.setInterval = realSetInterval; global.setTimeout = realSetTimeout; };
  return made;
}
const quiet = () => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; return () => { console.log = l; console.warn = w; }; };
const tcpServers = () => process.getActiveResourcesInfo().filter((r) => r === "TCPServerWrap").length;

test("requiring src/app.js starts nothing that keeps the process alive and listens on nothing", () => {
  const timers = watchTimers();
  const serversBefore = tcpServers();
  const restore = quiet();
  try { require("../../src/app"); } finally { restore(); timers.stop(); }
  // Library-level housekeeping timers (rate-limit stores...) are allowed only if unref'd.
  assert.deepEqual([...timers.intervals, ...timers.timeouts].filter((t) => t.hasRef()), []);
  assert.equal(tcpServers(), serversBefore);
});

test("createApp() builds an app and starts no timer, no listener and no process handler", () => {
  const { createApp } = require("../../src/app");
  const listeners = SIGNALS.map((n) => process.listenerCount(n));
  const serversBefore = tcpServers();
  const timers = watchTimers();
  const restore = quiet();
  let app;
  try { app = createApp(); } finally { restore(); timers.stop(); }
  assert.equal(typeof app, "function", "an Express app (a request listener)");
  assert.equal(typeof app.listen, "function");
  // The rate-limit stores (express-rate-limit) each keep one unref'd 60 s sweep; a background job's interval is ref'd
  // and 6 min or more, and those are started by src/index.js (jobs.js), never here.
  assert.deepEqual([...timers.intervals, ...timers.timeouts].filter((t) => t.hasRef()), [], "no timer that could keep the process alive");
  assert.deepEqual(timers.intervals.filter((t) => t._repeat !== 60000), [], "no interval other than the rate-limit stores' 60 s sweep");
  assert.equal(tcpServers(), serversBefore, "nothing is listening");
  assert.deepEqual(SIGNALS.map((n) => process.listenerCount(n)), listeners, "no process handler registered");
  timers.timeouts.forEach(clearTimeout);
});

test("two createApp() calls give two independent apps", () => {
  const { createApp } = require("../../src/app");
  const quiet = console.log; console.log = () => {};
  try {
    assert.notEqual(createApp(), createApp());
  } finally { console.log = quiet; }
});
