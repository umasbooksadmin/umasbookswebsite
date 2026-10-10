// POST /webhooks/helloasso (src/routes/helloassoWebhook.js): HelloAsso is used
// for MEMBERSHIP payments only, so this route handles the membership-form
// branch (only ever applied to a verified account) and IGNORES everything else
// (old order notifications included) without any HelloAsso call; also
// malformed/empty bodies, the immediate 200, and the rate limit.
//
// In-process (test/helpers/inProcessApp.js) so findMembershipOrdersByEmail
// can be stubbed. The handler acks BEFORE it
// does any work, so effects are awaited with waitFor / by watching the
// console.warn lines the handler emits rather than sleeping blindly.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen, waitFor } = require("../helpers/inProcessApp");

const db = prepareDatabase("ha_webhook", { isolated: true });

const mailer = require("../../src/mailer");
const sentEmails = [];
mailer.sendMail = async (opts) => { sentEmails.push(opts); };

const helloasso = require("../../src/lib/helloasso");
const helloassoCalls = [];
helloasso.getCheckoutIntent = async (id) => { // removed from the module: must never be reached
  helloassoCalls.push(`getCheckoutIntent ${id}`);
  throw new Error("an order lookup must not happen");
};
const membershipLookups = [];
let membershipOrders = [];
let membershipGate = null; // when set, lookups wait on it (slow-HelloAsso simulation)
helloasso.findMembershipOrdersByEmail = async (email) => {
  membershipLookups.push(email);
  if (membershipGate) await membershipGate;
  return membershipOrders;
};

const { pool } = require("../../src/db");

// Capture the handler's console output (it logs instead of throwing).
const warnings = [];
const errors = [];
const realWarn = console.warn;
const realError = console.error;

let server;
before(async () => {
  db.create();
  console.warn = (...a) => { warnings.push(a.join(" ")); };
  console.error = (...a) => { errors.push(a.join(" ")); };
  server = await listen(buildApp([require("../../src/routes/helloassoWebhook")]));
});
after(async () => {
  console.warn = realWarn;
  console.error = realError;
  await server.close();
  await pool.end();
  db.drop();
});

beforeEach(() => {
  sentEmails.length = 0;
  helloassoCalls.length = 0;
  membershipLookups.length = 0;
  membershipOrders = [];
  warnings.length = 0;
  errors.length = 0;
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function post(body, { raw = false, contentType = "application/json" } = {}) {
  return fetch(`${server.base}/webhooks/helloasso`, {
    method: "POST",
    headers: contentType ? { "content-type": contentType } : {},
    body: raw ? body : JSON.stringify(body),
  });
}

async function pendingOrder() { // an old online-checkout order left in 'pending'
  const { rows: b } = await pool.query("INSERT INTO books (title) VALUES ($1) RETURNING id", [`Webhook Book ${uniq()}`]);
  const { rows: c } = await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', 6) RETURNING id", [b[0].id]);
  const { rows } = await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, total_amount, checkout_intent_id)
     VALUES ('Hook Buyer', $1, 6.00, $2) RETURNING *`,
    [`hook-${uniq()}@example.test`, `wh-${uniq()}`]
  );
  const order = rows[0];
  await pool.query("UPDATE book_copies SET status = 'in_cart', cart_order_id = $1, cart_added_at = now() WHERE id = $2", [order.id, c[0].id]);
  await pool.query("INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, 'Hook Book', 6)", [order.id, c[0].id]);
  return { order, copyId: c[0].id, intentId: order.checkout_intent_id };
}
const orderRow = async (id) => (await pool.query("SELECT * FROM orders WHERE id = $1", [id])).rows[0];
const copyStatus = async (id) => (await pool.query("SELECT status FROM book_copies WHERE id = $1", [id])).rows[0].status;
const IGNORED = /not a membership payment, ignored/;

test("an old order notification (metadata.orderId / checkoutIntentId) is ignored: 200, no HelloAsso call, the order and copies untouched, no email", async () => {
  const { order, copyId, intentId } = await pendingOrder();
  const bodies = [
    { eventType: "Order", metadata: { orderId: order.id } },
    { data: { metadata: { orderId: order.id } } },
    { data: { checkoutIntentId: intentId } },
    { eventType: "Payment", data: { order: { formType: "Shop" }, payer: { email: order.buyer_email } }, metadata: { orderId: order.id } },
  ];
  for (const body of bodies) assert.equal((await post(body)).status, 200);
  await waitFor(() => warnings.filter((w) => IGNORED.test(w)).length === bodies.length, { message: "an ignored warning per body" });
  assert.deepEqual(helloassoCalls, [], "no order lookup at HelloAsso");
  assert.equal(membershipLookups.length, 0);
  const after = await orderRow(order.id);
  assert.equal(after.status, "pending");
  assert.equal(after.paid_at, null);
  assert.equal(await copyStatus(copyId), "in_cart");
  assert.equal(sentEmails.length, 0);
  assert.equal(errors.length, 0);
});

test("an unmatched body does nothing except log a warning", async () => {
  const res = await post({ eventType: "Order", data: { id: 1 }, metadata: { orderId: 999999999 } });
  assert.equal(res.status, 200);
  await waitFor(() => warnings.some((w) => IGNORED.test(w)), { message: "ignored warning" });
  assert.deepEqual(helloassoCalls, []);
  assert.equal(membershipLookups.length, 0);
  assert.equal(errors.length, 0);
});

test("the ignored-body log line never contains the payer's email address or phone number", async () => {
  await post({ eventType: "Order", data: { formType: "Shop", payer: { email: "private.person@example.test", phone: "0612345678" } } });
  await waitFor(() => warnings.some((w) => IGNORED.test(w)), { message: "ignored warning" });
  const line = warnings.find((w) => IGNORED.test(w));
  assert.doesNotMatch(line, /private\.person|example\.test|0612345678/);
  assert.match(line, /\[email\]/);
});

// --- Membership-form payloads --------------------------------------------

const membershipBody = (email) => ({ eventType: "Order", data: { formType: "Membership", payer: { email } } });
const authorizedOrder = (id) => ({ id, date: new Date().toISOString(), amount: { total: 2000 }, payments: [{ state: "Authorized" }] });

async function makeUser({ verified }) {
  const email = `member-${uniq()}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at)
     VALUES ($1, 'x', 'Member Test', $2) RETURNING id`,
    [email, verified ? new Date() : null]
  );
  return { id: rows[0].id, email };
}
const userRow = async (id) => (await pool.query("SELECT is_member, member_expires_at FROM users WHERE id = $1", [id])).rows[0];

test("membership-form payload for a VERIFIED account grants membership", async () => {
  const { id, email } = await makeUser({ verified: true });
  membershipOrders = [authorizedOrder(Math.floor(Math.random() * 1e9))];
  assert.equal((await post(membershipBody(email))).status, 200);
  await waitFor(async () => (await userRow(id)).is_member === true, { message: "membership granted" });
  assert.deepEqual(membershipLookups, [email], "HelloAsso's API was asked about this payer email");
  assert.ok((await userRow(id)).member_expires_at);
});

test("membership-form payload for an UNVERIFIED account never grants membership", async () => {
  const { id, email } = await makeUser({ verified: false });
  membershipOrders = [authorizedOrder(Math.floor(Math.random() * 1e9))];
  assert.equal((await post(membershipBody(email))).status, 200);
  await waitFor(() => warnings.some((w) => /unverified email/.test(w)), { message: "unverified-skip warning" });
  assert.deepEqual(membershipLookups, [email]);
  assert.equal((await userRow(id)).is_member, false);
  const { rows } = await pool.query("SELECT 1 FROM membership_payments WHERE user_id = $1", [id]);
  assert.equal(rows.length, 0);
});

test("membership-form payload with no matching account changes nothing", async () => {
  const email = `ghost-${uniq()}@example.test`;
  membershipOrders = [authorizedOrder(Math.floor(Math.random() * 1e9))];
  assert.equal((await post(membershipBody(email))).status, 200);
  await waitFor(() => warnings.some((w) => /no matching site account/.test(w)), { message: "no-account warning" });
});

test("a non-Membership formType, or one without a payer email, never reaches the membership sync", async () => {
  await post({ data: { formType: "Shop", payer: { email: "shop@example.test" } } });
  await post({ data: { formType: "Membership" } });
  await waitFor(() => warnings.filter((w) => IGNORED.test(w)).length === 2, { message: "two unmatched warnings" });
  assert.equal(membershipLookups.length, 0);
});

test("the Payment-event shape (formType under data.order) is also treated as a membership payload", async () => {
  const { id, email } = await makeUser({ verified: true });
  membershipOrders = [authorizedOrder(Math.floor(Math.random() * 1e9))];
  await post({ eventType: "Payment", data: { order: { formType: "Membership" }, payer: { email } } });
  await waitFor(async () => (await userRow(id)).is_member === true, { message: "membership granted" });
});

// --- Robustness ----------------------------------------------------------

test("an empty body and an empty JSON object are acked 200 and just logged", async () => {
  assert.equal((await post("", { raw: true, contentType: null })).status, 200);
  assert.equal((await post("", { raw: true })).status, 200); // JSON content type, zero bytes
  assert.equal((await post({})).status, 200);
  await waitFor(() => warnings.filter((w) => IGNORED.test(w)).length === 3, { message: "three unmatched warnings" });
  assert.equal(errors.length, 0);
});

test("a JSON array body is acked and logged; a bare scalar is acked too — neither crashes the handler", async () => {
  assert.equal((await post([1, 2, 3])).status, 200);
  await waitFor(() => warnings.some((w) => IGNORED.test(w)), { message: "unmatched warning" });
  // express.json (strict mode) rejects a non-object/array root; the webhook still acks it so HelloAsso doesn't retry.
  assert.equal((await post("null", { raw: true })).status, 200);
  assert.equal(errors.filter((e) => /webhook handling failed/.test(e)).length, 0);
});

test("malformed JSON is acked 200 (so HelloAsso doesn't retry it), logged, and touches no order", async () => {
  // Regression: the body parser used to reject it before the handler ran, so
  // the app answered 500 and HelloAsso kept retrying the same bad body.
  const res = await post("{ not json", { raw: true });
  assert.equal(res.status, 200);
  await waitFor(() => warnings.some((w) => /ignored an unreadable body/.test(w)), { message: "unreadable-body warning" });
  assert.deepEqual(helloassoCalls, []);
  assert.equal(membershipLookups.length, 0);

  const { id, email } = await makeUser({ verified: true });
  membershipOrders = [authorizedOrder(Math.floor(Math.random() * 1e9))];
  assert.equal((await post(membershipBody(email))).status, 200, "server still works afterwards");
  await waitFor(async () => (await userRow(id)).is_member === true, { message: "membership granted" });
});

test("the 200 is sent immediately — before a slow HelloAsso membership lookup finishes", async () => {
  const { id, email } = await makeUser({ verified: true });
  membershipOrders = [authorizedOrder(Math.floor(Math.random() * 1e9))];
  let release;
  membershipGate = new Promise((r) => { release = r; });
  try {
    const res = await post(membershipBody(email));
    assert.equal(res.status, 200);
    assert.equal((await userRow(id)).is_member, false, "work has not completed when the ack arrives");
  } finally {
    membershipGate = null;
    release();
  }
  await waitFor(async () => (await userRow(id)).is_member === true, { message: "membership granted after the lookup resumes" });
});

// Keep last: the limiter is per-process and counts every request above too.
// --- Cooldown and global cap (lib/webhookGuard.js) ------------------------

const { createSyncGuard, setSyncGuard } = require("../../src/lib/webhookGuard");

test("the same payer email twice within the cooldown: HelloAsso is asked once now and once more at the end of the cooldown; other emails are not delayed", async () => {
  setSyncGuard(createSyncGuard({ cooldownMs: 400, log: () => {} }));
  try {
    const { id, email } = await makeUser({ verified: true });
    membershipOrders = [authorizedOrder(Math.floor(Math.random() * 1e9))];
    for (let i = 0; i < 4; i++) assert.equal((await post(membershipBody(email))).status, 200, "always acknowledged");
    const other = `other-${uniq()}@example.test`;
    assert.equal((await post(membershipBody(other))).status, 200);
    await waitFor(async () => (await userRow(id)).is_member === true, { message: "membership granted by the first check" });
    await waitFor(() => membershipLookups.includes(other), { message: "another email is checked at once" });
    assert.deepEqual(membershipLookups.filter((e) => e === email), [email], "one check so far for the repeated email");
    await waitFor(() => membershipLookups.filter((e) => e === email).length === 2, { message: "the trailing check", timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(membershipLookups.filter((e) => e === email).length, 2, "exactly two checks for four webhooks");
  } finally { setSyncGuard(null); }
});

test("a flood of forged emails makes at most the global cap of HelloAsso checks; every call is still acknowledged", async () => {
  const logs = [];
  setSyncGuard(createSyncGuard({ maxPerWindow: 5, log: (m) => logs.push(m) }));
  try {
    for (let i = 0; i < 12; i++) assert.equal((await post(membershipBody(`forged${i}-${uniq()}@example.test`))).status, 200);
    await waitFor(() => membershipLookups.length >= 5, { message: "5 checks" });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(membershipLookups.length, 5);
    assert.equal(logs.length, 1);
    assert.equal(errors.length, 0);
  } finally { setSyncGuard(null); }
});

test("rate limit: callers past the cap get 429 and no further processing", async () => {
  const statuses = [];
  for (let i = 0; i < 320; i++) {
    statuses.push((await post({})).status);
  }
  const firstLimited = statuses.indexOf(429);
  assert.notEqual(firstLimited, -1, "a 429 should appear within 320 requests (cap is 300 per 5 minutes)");
  // A burst well past the old 30-per-5-minutes cap must still be accepted
  // (a 429 loses HelloAsso's notification).
  assert.ok(firstLimited > 100, `burst was limited too early (first 429 at request ${firstLimited})`);
  assert.ok(statuses.slice(0, firstLimited).every((s) => s === 200));
  assert.ok(statuses.slice(firstLimited).every((s) => s === 429), "once limited, stays limited");
  const limited = await post(membershipBody(`limited-${uniq()}@example.test`));
  assert.equal(limited.status, 429);
  assert.equal(membershipLookups.length, 0, "no processing once limited");
});
