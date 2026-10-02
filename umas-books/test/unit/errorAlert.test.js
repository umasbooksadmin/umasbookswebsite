// lib/errorAlert.js: the 15-minute throttle, suppressed-count note, `force`
// bypass (which must not disturb the throttle clock), and that a mail
// failure never throws. The mailer is stubbed before the module loads
// (errorAlert destructures sendMail at require time).

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

const mailer = require("../../src/mailer");
const sent = [];
let sendImpl;
mailer.sendMail = async (opts) => { sent.push(opts); return sendImpl(opts); };

const { alertOnError } = require("../../src/lib/errorAlert");

const THROTTLE = 15 * 60 * 1000;
// The module's clock is process-wide and starts at 0, so the first real
// call is always outside the window. Each test jumps far ahead of the last.
let clock = 1_000_000_000_000;
const advance = (ms) => { clock += ms; };

beforeEach(() => {
  sent.length = 0;
  sendImpl = async () => {};
  advance(10 * THROTTLE); // clears any throttle left by the previous test
  mock.method(Date, "now", () => clock);
  mock.method(console, "error", () => {});
});
afterEach(() => mock.restoreAll());

test("first alert is sent with the label in the subject and the stack in the body", async () => {
  const err = new Error("db exploded");
  await alertOnError("route error", err);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, "[umas-books] route error");
  assert.equal(sent[0].text, err.stack);
  assert.ok(sent[0].to);
});

test("non-Error values are stringified", async () => {
  await alertOnError("weird", "just a string");
  assert.equal(sent[0].text, "just a string");
  advance(THROTTLE);
  await alertOnError("weird", null);
  assert.equal(sent[1].text, "null");
});

test("a second alert inside 15 minutes is swallowed; one after the window goes out", async () => {
  await alertOnError("a", new Error("1"));
  advance(THROTTLE - 1);
  await alertOnError("b", new Error("2"));
  assert.equal(sent.length, 1, "still throttled 1ms before the window ends");
  advance(1);
  await alertOnError("c", new Error("3"));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].subject, "[umas-books] c");
});

test("suppressed errors are counted and reported in the next alert, then the counter resets", async () => {
  await alertOnError("first", new Error("x"));
  await alertOnError("s1", new Error("x"));
  await alertOnError("s2", new Error("x"));
  await alertOnError("s3", new Error("x"));
  advance(THROTTLE);
  await alertOnError("next", new Error("boom"));
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /\(3 further error\(s\) suppressed in the last 15 minutes/);
  advance(THROTTLE);
  await alertOnError("after", new Error("clean"));
  assert.doesNotMatch(sent[2].text, /suppressed/);
  assert.doesNotMatch(sent[0].text, /suppressed/);
});

test("force bypasses the throttle and leaves its clock and counter alone", async () => {
  await alertOnError("normal", new Error("n"));
  await alertOnError("forced 1", new Error("f"), { force: true });
  await alertOnError("forced 2", new Error("f"), { force: true });
  assert.deepEqual(sent.map((m) => m.subject), ["[umas-books] normal", "[umas-books] forced 1", "[umas-books] forced 2"]);
  // the forced sends did not restart the window: a normal alert is still throttled...
  advance(THROTTLE - 1);
  await alertOnError("still throttled", new Error("t"));
  assert.equal(sent.length, 3);
  // ...and is released exactly 15 minutes after the *normal* one, not after the forced ones
  advance(1);
  await alertOnError("released", new Error("r"));
  assert.equal(sent.length, 4);
});

test("force works even while throttled and does not count as suppressed", async () => {
  await alertOnError("normal", new Error("n"));
  await alertOnError("forced", new Error("f"), { force: true });
  advance(THROTTLE);
  await alertOnError("next", new Error("x"));
  assert.doesNotMatch(sent[sent.length - 1].text, /suppressed/);
});

test("a mail failure never throws or rejects (throttled and forced paths)", async () => {
  sendImpl = async () => { throw new Error("smtp down"); };
  await assert.doesNotReject(alertOnError("x", new Error("e")));
  await assert.doesNotReject(alertOnError("y", new Error("e"), { force: true }));
  assert.equal(sent.length, 2);
  assert.equal(console.error.mock.callCount(), 2);
  assert.match(String(console.error.mock.calls[0].arguments[1]), /smtp down/);
});

test("a failed send still consumes the throttle slot (no retry storm)", async () => {
  sendImpl = async () => { throw new Error("smtp down"); };
  await alertOnError("x", new Error("e"));
  sendImpl = async () => {};
  await alertOnError("y", new Error("e"));
  assert.equal(sent.length, 1);
});
