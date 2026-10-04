// POST /webhooks/helloasso (src/routes/helloassoWebhook.js): order matching
// by metadata.orderId and by checkoutIntentId, unmatched bodies, the
// membership-form branch (only ever applied to a verified account),
// malformed/empty bodies, the immediate 200, and the rate limit.
//
// In-process (test/helpers/inProcessApp.js) so getCheckoutIntent and
// findMembershipOrdersByEmail can be stubbed. The handler acks BEFORE it
// does any work, so effects are awaited with waitFor / by watching the
// console.warn lines the handler emits rather than sleeping blindly.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen, waitFor } = require("../helpers/inProcessApp");

const db = prepareDatabase("ha_webhook");

const mailer = require("../../src/mailer");
const sentEmails = [];
mailer.sendMail = async (opts) => { sentEmails.push(opts); };

const helloasso = require("../../src/lib/helloasso");
const intents = new Map();
const intentLookups = [];
let intentGate = null; // when set, lookups wait on it (slow-HelloAsso simulation)
helloasso.getCheckoutIntent = async (id) => {
  intentLookups.push(String(id));
  if (intentGate) await intentGate;
  if (!intents.has(String(id))) throw new Error(`unknown intent ${id}`);
  return intents.get(String(id));
};
const membershipLookups = [];
let membershipOrders = [];
helloasso.findMembershipOrdersByEmail = async (email) => {
  membershipLookups.push(email);
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
  intents.clear();
  intentLookups.length = 0;
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

async function pendingOrder({ intentId = `wh-${uniq()}` } = {}) {
  const { rows: b } = await pool.query("INSERT INTO books (title) VALUES ($1) RETURNING id", [`Webhook Book ${uniq()}`]);
  const { rows: c } = await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', 6) RETURNING id", [b[0].id]);
  const { rows } = await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, total_amount, checkout_intent_id)
     VALUES ('Hook Buyer', $1, 6.00, $2) RETURNING *`,
    [`hook-${uniq()}@example.test`, intentId]
  );
  const order = rows[0];
  await pool.query("UPDATE book_copies SET status = 'in_cart', cart_order_id = $1, cart_added_at = now() WHERE id = $2", [order.id, c[0].id]);
  await pool.query("INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, 'Hook Book', 6)", [order.id, c[0].id]);
  return { order, copyId: c[0].id, intentId };
}
const orderRow = async (id) => (await pool.query("SELECT * FROM orders WHERE id = $1", [id])).rows[0];
const copyStatus = async (id) => (await pool.query("SELECT status FROM book_copies WHERE id = $1", [id])).rows[0].status;
const paidIntent = { order: { id: 9001, payments: [{ state: "Authorized" }] } };

test("a webhook naming the order in metadata.orderId triggers reconcile and responds 200", async () => {
  const { order, copyId, intentId } = await pendingOrder();
  intents.set(intentId, paidIntent);
  const res = await post({ eventType: "Order", metadata: { orderId: order.id } });
  assert.equal(res.status, 200);
  await waitFor(async () => (await orderRow(order.id)).status === "paid", { message: "order to become paid" });
  assert.equal(await copyStatus(copyId), "sold");
  assert.deepEqual(intentLookups, [intentId], "state came from HelloAsso's API, using the order's own intent id");
  await waitFor(() => sentEmails.length === 1, { message: "confirmation email" });
  assert.equal(sentEmails[0].to, order.buyer_email);
});

test("orderId nested under data.metadata is also recognised", async () => {
  const { order, intentId } = await pendingOrder();
  intents.set(intentId, paidIntent);
  assert.equal((await post({ data: { metadata: { orderId: order.id } } })).status, 200);
  await waitFor(async () => (await orderRow(order.id)).status === "paid", { message: "order to become paid" });
});

test("a webhook carrying only a checkoutIntentId is matched through orders.checkout_intent_id", async () => {
  const { order, copyId, intentId } = await pendingOrder();
  intents.set(intentId, paidIntent);
  const res = await post({ data: { checkoutIntentId: intentId } });
  assert.equal(res.status, 200);
  await waitFor(async () => (await orderRow(order.id)).status === "paid", { message: "order to become paid" });
  assert.equal(await copyStatus(copyId), "sold");
});

test("a webhook whose intent is still pending leaves the order and copies alone", async () => {
  const { order, copyId, intentId } = await pendingOrder();
  intents.set(intentId, { order: { payments: [{ state: "Pending" }] } });
  assert.equal((await post({ metadata: { orderId: order.id } })).status, 200);
  await waitFor(() => intentLookups.length === 1, { message: "HelloAsso lookup" });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await orderRow(order.id)).status, "pending");
  assert.equal(await copyStatus(copyId), "in_cart");
});

test("a replayed webhook does not double-process the order", async () => {
  const { order, intentId } = await pendingOrder();
  intents.set(intentId, paidIntent);
  await post({ metadata: { orderId: order.id } });
  await waitFor(() => sentEmails.length === 1, { message: "first confirmation" });
  await post({ metadata: { orderId: order.id } });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(sentEmails.length, 1);
});

test("an unmatched body does nothing except log a warning", async () => {
  const res = await post({ eventType: "Order", data: { id: 1 }, metadata: { orderId: 999999999 } });
  assert.equal(res.status, 200);
  await waitFor(() => warnings.some((w) => /couldn't match a local order/.test(w)), { message: "unmatched warning" });
  assert.equal(intentLookups.length, 0);
  assert.equal(membershipLookups.length, 0);
  assert.equal(errors.length, 0);
});

test("the unmatched-body log line never contains the payer's email address or phone number", async () => {
  await post({ eventType: "Order", data: { formType: "Shop", payer: { email: "private.person@example.test", phone: "0612345678" } } });
  await waitFor(() => warnings.some((w) => /couldn't match a local order/.test(w)), { message: "unmatched warning" });
  const line = warnings.find((w) => /couldn't match a local order/.test(w));
  assert.doesNotMatch(line, /private\.person|example\.test|0612345678/);
  assert.match(line, /\[email\]/);
});

test("an unknown checkoutIntentId with no order id is likewise just logged", async () => {
  assert.equal((await post({ checkoutIntentId: "no-such-intent" })).status, 200);
  await waitFor(() => warnings.some((w) => /couldn't match a local order/.test(w)), { message: "unmatched warning" });
  assert.equal(intentLookups.length, 0);
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
  await waitFor(() => warnings.filter((w) => /couldn't match a local order/.test(w)).length === 2, { message: "two unmatched warnings" });
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
  await waitFor(() => warnings.filter((w) => /couldn't match a local order/.test(w)).length === 3, { message: "three unmatched warnings" });
  assert.equal(errors.length, 0);
});

test("a JSON array body is acked and logged; a bare scalar is acked too — neither crashes the handler", async () => {
  assert.equal((await post([1, 2, 3])).status, 200);
  await waitFor(() => warnings.some((w) => /couldn't match a local order/.test(w)), { message: "unmatched warning" });
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
  assert.equal(intentLookups.length, 0);

  const { order, intentId } = await pendingOrder();
  intents.set(intentId, paidIntent);
  assert.equal((await post({ metadata: { orderId: order.id } })).status, 200, "server still works afterwards");
  await waitFor(async () => (await orderRow(order.id)).status === "paid", { message: "order to become paid" });
});

test("the 200 is sent immediately — before a slow HelloAsso lookup finishes", async () => {
  const { order, intentId } = await pendingOrder();
  intents.set(intentId, paidIntent);
  let release;
  intentGate = new Promise((r) => { release = r; });
  try {
    const res = await post({ metadata: { orderId: order.id } });
    assert.equal(res.status, 200);
    assert.equal((await orderRow(order.id)).status, "pending", "work has not completed when the ack arrives");
  } finally {
    intentGate = null;
    release();
  }
  await waitFor(async () => (await orderRow(order.id)).status === "paid", { message: "order to become paid after the lookup resumes" });
});

// Keep last: the limiter is per-process and counts every request above too.
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
  const limited = await post({ metadata: { orderId: 1 } });
  assert.equal(limited.status, 429);
  assert.equal(intentLookups.length, 0);
});
