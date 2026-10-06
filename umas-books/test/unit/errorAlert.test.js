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

const { alertOnError, sendAdminAlert, setAlertRetryDelay } = require("../../src/lib/errorAlert");

const THROTTLE = 15 * 60 * 1000;
// The module's clock is process-wide and starts at 0, so the first real
// call is always outside the window. Each test jumps far ahead of the last.
let clock = 1_000_000_000_000;
const advance = (ms) => { clock += ms; };

beforeEach(() => {
  sent.length = 0;
  sendImpl = async () => {};
  setAlertRetryDelay(0); // the real pause between the two tries would only slow the tests
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
  await alertOnError("a", new Error("same failure"));
  advance(THROTTLE - 1);
  await alertOnError("b", new Error("same failure"));
  assert.equal(sent.length, 1, "still throttled 1ms before the window ends");
  advance(1);
  await alertOnError("c", new Error("same failure"));
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
  await alertOnError("still throttled", new Error("n"));
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
  assert.equal(sent.length, 4, "each alert is tried twice");
  assert.equal(console.error.mock.callCount(), 4);
  assert.match(String(console.error.mock.calls[0].arguments[1]), /smtp down/);
});

test("a failed send still consumes the throttle slot (no retry storm)", async () => {
  sendImpl = async () => { throw new Error("smtp down"); };
  await alertOnError("x", new Error("e"));
  sendImpl = async () => {};
  await alertOnError("y", new Error("e"));
  assert.equal(sent.length, 2, "two tries for the first alert, none for the throttled second");
});

test("an alert that fails once is retried once and then delivered", async () => {
  let calls = 0;
  sendImpl = async () => { if (++calls === 1) throw new Error("blip"); };
  assert.equal(await sendAdminAlert({ subject: "s", text: "t" }), true);
  assert.equal(sent.length, 2);
});

test("sendAdminAlert resolves false (never throws) when both tries fail", async () => {
  sendImpl = async () => { throw new Error("down"); };
  assert.equal(await sendAdminAlert({ subject: "s", text: "t" }), false);
  assert.equal(sent.length, 2);
});

test("scrubs email addresses and long digit runs from subject and body, keeps stack frames", async () => {
  const err = new Error("could not email jane.doe@example.org about 0612345678 / +33 6 12 34 56 78\nsecond line bob@x.fr");
  await alertOnError("Error on POST /contact for jane.doe@example.org", err);
  const { subject, text } = sent[0];
  assert.doesNotMatch(subject, /jane|example\.org/);
  assert.doesNotMatch(text, /@|0612345678|34 56 78/);
  assert.match(text, /\[email\]/);
  assert.match(text, /\[number\]/);
  assert.match(text, /\n\s+at .*errorAlert\.test\.js:\d+:\d+/, "stack frames survive");
});

test("short numbers (order ids, line numbers) are not scrubbed", async () => {
  await alertOnError("Paid order 12345678 failed", new Error("order 42 broke"), { force: true });
  assert.equal(sent[0].subject, "[umas-books] Paid order 12345678 failed");
  assert.match(sent[0].text, /order 42 broke/);
});

test("non-forced alerts are scrubbed; forced (money) alerts keep the buyer email and long ids", async () => {
  const msg = "Order 7 PAID. Buyer: Jane <jane@example.org>, intent 123456789012";
  await alertOnError("Error on POST /x for jane@example.org", new Error(msg));
  assert.doesNotMatch(sent[0].subject + sent[0].text, /jane@example|123456789012/);
  await alertOnError("Paid order 7 could not be fulfilled", msg, { force: true });
  assert.equal(sent[1].subject, "[umas-books] Paid order 7 could not be fulfilled");
  assert.equal(sent[1].text, msg);
});

test("one repeated error cannot swallow a different error, and the cap still holds", async () => {
  await alertOnError("Error on GET /a", new Error("harmless repeated failure"));
  await alertOnError("Error on GET /a", new Error("harmless repeated failure"));
  await alertOnError("Error on GET /b", new Error("a different, real failure"));
  assert.equal(sent.length, 2, "the repeat was swallowed, the different error was not");
  assert.match(sent[1].text, /a different, real failure/);
  assert.match(sent[1].text, /1 further error\(s\) suppressed/);

  for (let i = 0; i < 20; i++) await alertOnError("flood", new Error(`distinct failure ${"x".repeat(i + 1)}`));
  assert.equal(sent.length, 6, "never more than 6 per window");
  advance(THROTTLE);
  await alertOnError("flood", new Error("distinct failure after the window"));
  assert.equal(sent.length, 7, "released after the window");
});
