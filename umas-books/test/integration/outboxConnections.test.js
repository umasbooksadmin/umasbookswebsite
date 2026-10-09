// The outbox worker must not hold a database connection while it talks to
// SMTP (it used to keep one dedicated client for the whole batch), and the
// claim must still guarantee one sender per row. Also: the admin dashboard
// runs its queries at most three at a time.

const { test, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");

const h = adminHarness("outbox_conn", ["dashboard"], { isolated: true });
const mailer = require("../../src/mailer");
const outbox = require("../../src/lib/outbox");

let sent = [];
let gate = null; // a promise the stub transport waits on, when set
let started = 0;
mailer.sendMail = async (opts) => {
  started++;
  if (gate) await gate.promise;
  sent.push(opts.to);
};
const gates = [];
const newGate = () => {
  let release;
  const promise = new Promise((r) => { release = r; });
  const g = { promise, release };
  gates.push(g);
  return g;
};
const busy = () => h.pool.totalCount - h.pool.idleCount; // connections checked out right now
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enqueue = (to) => outbox.enqueueEmail(h.pool, { to, subject: "S", text: "T", kind: "contact" });
const row = async (id) => (await h.q("SELECT * FROM email_outbox WHERE id = $1", [id]))[0];

before(() => h.start());
after(() => h.stop());
afterEach(() => { for (const g of gates.splice(0)) g.release(); });
beforeEach(async () => {
  sent = [];
  started = 0;
  gate = null;
  await h.q("UPDATE email_outbox SET status = 'handled' WHERE status = 'pending'");
});

test("no database connection is held while the mail is being sent", { timeout: 8000 }, async () => {
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(await enqueue(`held-${i}@example.test`));
  gate = newGate();
  const run = outbox.processOutbox(h.pool);
  while (started === 0) await sleep(5);
  // SMTP is "slow" right now; the worker is inside sendMail.
  assert.equal(busy(), 0, "every connection is back in the pool during the send");
  // ...and the claim is visible: leased, still pending, not yet sent.
  const mid = await row(ids[0]);
  assert.equal(mid.status, "pending");
  assert.ok(new Date(mid.next_try_at) > new Date(Date.now() + 60_000), "leased several minutes ahead");
  gate.release();
  const r = await run;
  assert.equal(r.sent, 3);
  assert.equal(busy(), 0);
  assert.equal((await row(ids[2])).status, "sent");
});

test("while the worker is mid-send the whole pool is available to other work", { timeout: 8000 }, async () => {
  await enqueue("pool-free@example.test");
  gate = newGate();
  const run = outbox.processOutbox(h.pool);
  while (started === 0) await sleep(5);
  const max = h.pool.options.max;
  // Check out every connection in the pool: if the worker still held one this would wait for it.
  const clients = await Promise.all(Array.from({ length: max }, () => h.pool.connect()));
  assert.equal(h.pool.totalCount, max);
  clients.forEach((c) => c.release());
  gate.release();
  await run;
});

test("crash recovery: a row claimed by a process that died is claimed again when the lease ends", async () => {
  const id = await enqueue("crash@example.test");
  const dyingGate = newGate();
  gate = dyingGate;
  const dying = outbox.processOutbox(h.pool); // claims, then "dies" inside SMTP
  while (started === 0) await sleep(5);

  // Lease still running: another tick leaves the row alone.
  const during = await outbox.processOutbox(h.pool);
  assert.equal(during.sent, 0);
  assert.equal((await row(id)).status, "pending");

  // The lease ends (the process never came back).
  await h.q("UPDATE email_outbox SET next_try_at = now() - interval '1 second' WHERE id = $1", [id]);
  gate = null;
  const after = await outbox.processOutbox(h.pool);
  assert.equal(after.sent, 1);
  assert.equal((await row(id)).status, "sent");
  assert.equal(sent.filter((t) => t === "crash@example.test").length, 1);

  // Let the simulated dead worker finish so the test process can end cleanly.
  dyingGate.release();
  await dying.catch(() => {});
});

test("two workers at once never send the same row twice", async () => {
  const to = Array.from({ length: 12 }, (_, i) => `twice-${i}@example.test`);
  for (const t of to) await enqueue(t);
  const results = await Promise.all([outbox.processOutbox(h.pool), outbox.processOutbox(h.pool), outbox.processOutbox(h.pool)]);
  const mine = sent.filter((t) => t.startsWith("twice-"));
  assert.equal(mine.length, 12);
  assert.equal(new Set(mine).size, 12, "each address mailed exactly once");
  assert.equal(results.reduce((a, r) => a + r.sent, 0), 12);
});

test("results are recorded after the send: failures back off, and three in a row hand the rest back", async () => {
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await enqueue(`fail-${i}@example.test`));
  mailer.sendMail = async () => { throw new Error("smtp down"); };
  const realError = console.error;
  console.error = () => {};
  let r;
  try { r = await outbox.processOutbox(h.pool); } finally { console.error = realError; }
  mailer.sendMail = async (opts) => { started++; if (gate) await gate.promise; sent.push(opts.to); };
  assert.equal(r.failed, 3);
  const rows = await Promise.all(ids.map(row));
  assert.deepEqual(rows.map((x) => x.attempts), [1, 1, 1, 0, 0]);
  assert.ok(rows.slice(0, 3).every((x) => new Date(x.next_try_at) > new Date()), "tried rows back off");
  assert.ok(rows.slice(3).every((x) => new Date(x.next_try_at) <= new Date()), "unattempted rows are due again at once");
});

test("the admin dashboard renders with at most three queries in flight", async () => {
  let inFlight = 0;
  let peak = 0;
  const realQuery = h.pool.query.bind(h.pool);
  h.pool.query = (...args) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    const p = realQuery(...args);
    const done = () => { inFlight--; };
    p.then(done, done);
    return p;
  };
  try {
    const responses = await Promise.all([h.get("/admin")]);
    const { res, text } = responses[0];
    assert.equal(res.status, 200);
    assert.doesNotMatch(text, /NaN|undefined|\[object Object\]/, "every figure is a number");
    assert.match(text, /Members/);
  } finally {
    h.pool.query = realQuery;
  }
  assert.ok(peak >= 2, `queries did overlap (peak ${peak})`);
  assert.ok(peak <= 3, `one dashboard request used ${peak} connections at once`);
});

test("dashboard book/account/member counts: shared for the TTL when caching is on, fresh when it is off", async () => {
  const page = async () => (await h.get("/admin")).text;
  const addAccount = () => h.q("INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'New Person')", [`cache-${h.uniq()}@example.test`]);
  try {
    process.env.DASHBOARD_COUNTS_CACHE_SECONDS = "60";
    const first = await page();
    await addAccount();
    assert.equal(await page(), first, "cached: the new account is not counted yet");
    process.env.DASHBOARD_COUNTS_CACHE_SECONDS = "0";
    assert.notEqual(await page(), first, "caching off: the new account shows at once");
  } finally {
    delete process.env.DASHBOARD_COUNTS_CACHE_SECONDS;
  }
});
