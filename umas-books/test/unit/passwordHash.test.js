const test = require("node:test");
const assert = require("node:assert/strict");
const bcryptjs = require("bcryptjs");
const bcrypt = require("bcrypt");
const ph = require("../../src/lib/passwordHash");

const PASSWORD = "Correct-Horse-1";

test("a hash made by bcryptjs verifies with the module (existing stored hashes keep working)", async () => {
  for (const stored of [
    "$2a$12$hQzgVK3VeEwqyleGoSBDrek0x7FY49kALikGOLxSWKpJTraieESnu", // bcryptjs 2, as in production
    bcryptjs.hashSync(PASSWORD, 12),
  ]) {
    assert.equal(await ph.compare(PASSWORD, stored), true);
    assert.equal(await ph.compare("wrong-password", stored), false);
  }
  assert.equal(await ph.compare("pässwörd-ünï", bcryptjs.hashSync("pässwörd-ünï", 4)), true);
});

test("a hash made by the module verifies with bcryptjs, at cost 12", async () => {
  const h = await ph.hash(PASSWORD);
  assert.equal(bcryptjs.getRounds(h), 12);
  assert.equal(await bcryptjs.compare(PASSWORD, h), true);
  assert.equal(await bcryptjs.compare("nope", h), false);
});

test("the 72-byte limit behaves as it did with bcryptjs (extra bytes ignored)", async () => {
  const long = "a".repeat(80);
  const old = bcryptjs.hashSync(long, 4);
  assert.equal(await ph.compare("a".repeat(72), old), true);
  assert.equal(await ph.compare(long, old), true);
  const h = await ph.hash(long, 4);
  assert.equal(await bcryptjs.compare("a".repeat(72), h), true);
});

test("the dummy hash is cost 12 and compareDummy still does a real compare, then answers false", async () => {
  assert.equal(bcryptjs.getRounds(ph.DUMMY_HASH), ph.COST);
  assert.equal(ph.COST, 12);
  const t = performance.now();
  assert.equal(await ph.compareDummy("no-such-account-timing-equalizer"), false);
  assert.ok(performance.now() - t > 20, "a cost-12 compare takes real time");
});

test("needsRehash flags other costs and malformed hashes", () => {
  assert.equal(ph.needsRehash(bcryptjs.hashSync("x", 12)), false);
  assert.equal(ph.needsRehash(bcryptjs.hashSync("x", 10)), true);
  assert.equal(ph.needsRehash(bcryptjs.hashSync("x", 4), 4), false);
  assert.equal(ph.needsRehash("not-a-hash"), true);
});

test("unusableHash is made once, cost 10, and matches nothing guessable", async () => {
  const [a, b] = await Promise.all([ph.unusableHash(), ph.unusableHash()]);
  assert.equal(a, b);
  assert.equal(bcryptjs.getRounds(a), 10);
  assert.equal(await ph.compare("password", a), false);
});

test("bcrypt work runs off the event loop: timers keep firing during a hash", async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  await Promise.all([ph.hash(PASSWORD), ph.hash(PASSWORD)]);
  clearInterval(timer);
  assert.ok(ticks >= 10, `event loop was starved (only ${ticks} ticks)`);
});

test("at most MAX_CONCURRENT run at once, extra ones wait, and everything finishes", async () => {
  const h = bcrypt.hashSync(PASSWORD, 12);
  const n = ph.MAX_CONCURRENT + 5;
  const jobs = Array.from({ length: n }, () => ph.compare(PASSWORD, h));
  assert.deepEqual(ph.stats(), { running: ph.MAX_CONCURRENT, waiting: 5 });
  assert.deepEqual(await Promise.all(jobs), Array(n).fill(true));
  assert.deepEqual(ph.stats(), { running: 0, waiting: 0 });
});

test("beyond MAX_WAITING the caller gets PasswordBusyError, and the queue recovers", async () => {
  const h = bcrypt.hashSync(PASSWORD, 4);
  const jobs = Array.from({ length: ph.MAX_CONCURRENT + ph.MAX_WAITING }, () => ph.compare(PASSWORD, h));
  let err;
  try {
    await ph.compare(PASSWORD, h);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ph.PasswordBusyError);
  assert.equal(err.status, 503);
  assert.equal(ph.isBusy(err), true);
  assert.equal(ph.isBusy(new Error("x")), false);
  assert.ok((await Promise.all(jobs)).every(Boolean), "the queued ones still complete");
  assert.equal(await ph.compare(PASSWORD, h), true, "and new work is accepted again");
  assert.deepEqual(ph.stats(), { running: 0, waiting: 0 });
});

test("a failing hash releases its slot", async () => {
  await assert.rejects(() => ph.hash(PASSWORD, "abc"));
  assert.deepEqual(ph.stats(), { running: 0, waiting: 0 });
});

test("sendBusy answers 503 with Retry-After", () => {
  const headers = {};
  let status;
  let body;
  const res = {
    locals: {},
    set: (k, v) => { headers[k] = v; },
    status: (s) => { status = s; return res; },
    type: () => res,
    send: (b) => { body = b; },
    render: (view, data, cb) => cb(new Error("no views here"), null),
  };
  ph.sendBusy({ tr: (en) => en }, res);
  assert.equal(status, 503);
  assert.equal(headers["Retry-After"], String(ph.RETRY_AFTER_SECONDS));
  assert.match(body, /busy/i);
});
