// The CSV download sink waits for a full buffer to drain without piling up
// listeners (MaxListenersExceededWarning), also behind the compression middleware.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const compression = require("compression");
const { EventEmitter } = require("node:events");
const { drainingSink } = require("../../src/lib/streamSink");

function warningsDuring() {
  const seen = [];
  const onWarning = (w) => seen.push(w.name);
  process.on("warning", onWarning);
  return { seen, stop: () => process.off("warning", onWarning) };
}

async function download(makeSink) {
  const app = express();
  app.use(compression({ threshold: 0 }));
  app.get("/big.csv", async (req, res) => {
    res.type("text/csv");
    const sink = makeSink(res);
    for (let i = 0; i < 200; i++) await sink(crypto.randomBytes(48 * 1024).toString("hex"));
    res.end();
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/big.csv`);
    const body = await r.text();
    return body.length;
  } finally {
    server.close();
  }
}

test("a big compressed download completes without a MaxListenersExceededWarning", async () => {
  const w = warningsDuring();
  const length = await download(drainingSink);
  await new Promise((resolve) => setImmediate(resolve));
  w.stop();
  assert.equal(length, 200 * 96 * 1024);
  assert.deepEqual(w.seen.filter((n) => n === "MaxListenersExceededWarning"), []);
});

test("the old per-write res.once('drain') did pile up listeners (this guards the test itself)", async () => {
  const w = warningsDuring();
  await download((res) => (text) => (res.write(text) ? undefined : new Promise((resolve) => res.once("drain", resolve))));
  await new Promise((resolve) => setImmediate(resolve));
  w.stop();
  assert.ok(w.seen.includes("MaxListenersExceededWarning"));
});

test("a client that goes away releases a waiting write instead of hanging", async () => {
  const res = new EventEmitter();
  res.destroyed = false;
  res.write = () => false;
  const sink = drainingSink(res);
  const pending = sink("x");
  res.emit("close");
  await pending; // would hang forever if close were ignored
  res.destroyed = true;
  assert.equal(sink("y"), undefined);
  assert.equal(res.listenerCount("drain"), 1, "one drain listener for the whole download");
});
