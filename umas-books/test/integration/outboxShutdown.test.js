// Graceful shutdown (src/index.js) waits for mails being sent right now, so the
// database is not closed under a mail that already left (its row would stay
// pending and go out a second time when the lease ran out). Bounded, and the
// worker starts no new send once a shutdown has begun.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");

const h = adminHarness("outbox_shutdown", ["dashboard"], { isolated: true });
const mailer = require("../../src/mailer");
const outbox = require("../../src/lib/outbox");

let release;
let started = 0;
const sentTo = [];
mailer.sendMail = async (opts) => {
  started++;
  if (release) await release.promise;
  sentTo.push(opts.to);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enqueue = (to) => outbox.enqueueEmail(h.pool, { to, subject: "S", text: "T", kind: "contact" });
const row = async (id) => (await h.q("SELECT * FROM email_outbox WHERE id = $1", [id]))[0];

before(() => h.start());
after(() => h.stop());

test("nothing to wait for when no mail is being sent", async () => {
  assert.equal(await outbox.waitForInFlightSends(50), true);
});

test("the shutdown wait is bounded: a send that never ends does not hold the process", { timeout: 8000 }, async () => {
  const id = await enqueue("stuck@example.test");
  let open;
  release = { promise: new Promise((r) => { open = r; }) };
  const run = outbox.processOutbox(h.pool);
  while (started === 0) await sleep(5);
  const t0 = Date.now();
  assert.equal(await outbox.waitForInFlightSends(150), false, "gave up after the limit");
  assert.ok(Date.now() - t0 < 2000);
  open();
  await run;
  assert.equal((await row(id)).status, "sent");
});

test("the shutdown wait lets a running send finish and mark its row sent", { timeout: 8000 }, async () => {
  const id = await enqueue("finishing@example.test");
  let open;
  release = { promise: new Promise((r) => { open = r; }) };
  const before = started;
  const run = outbox.processOutbox(h.pool);
  while (started === before) await sleep(5);
  const waiting = outbox.waitForInFlightSends(5000);
  assert.equal((await row(id)).status, "pending", "still being sent");
  setTimeout(open, 50);
  assert.equal(await waiting, true);
  // The wait returned only after the bookkeeping: the row is already 'sent' (the pool is still open at this point).
  assert.equal((await row(id)).status, "sent");
  await run;
  release = null;
});

test("after stopSending the worker starts no new send and hands its unsent rows back", { timeout: 8000 }, async () => {
  const ids = [await enqueue("a@example.test"), await enqueue("b@example.test"), await enqueue("c@example.test")];
  let open;
  release = { promise: new Promise((r) => { open = r; }) };
  const before = started;
  const run = outbox.processOutbox(h.pool, { limit: 3 });
  while (started === before) await sleep(5);
  outbox.stopSending();
  open();
  const summary = await run;
  release = null;
  assert.equal(summary.sent, 1, "only the send already running finished");
  const statuses = [];
  for (const id of ids) statuses.push(await row(id));
  assert.equal(statuses.filter((r) => r.status === "sent").length, 1);
  for (const r of statuses.filter((x) => x.status !== "sent")) {
    assert.equal(r.status, "pending");
    assert.ok(new Date(r.next_try_at) <= new Date(Date.now() + 1000), "due again at once, not leased for minutes");
  }
});
