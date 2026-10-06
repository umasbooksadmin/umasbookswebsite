// The 6-hourly follow-up for paid online orders (lib/orderSweeps.js):
//  - refund detection from HelloAsso's own checkout-intent lookup: flag only,
//    ONE alert email per order, nothing restocked automatically;
//  - the day-10 customer pickup reminder (EN/FR, once, only inside the 14-day
//    window the terms of sale talk about) and the day-12 admin digest (once).
// Own throwaway database; HelloAsso and the mailer are stubbed.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { prepareDatabase } = require("../helpers/testDatabase");
const { makeOrder } = require("../helpers/orderFixtures");

const db = prepareDatabase("order_sweeps", { isolated: true });

const mailer = require("../../src/mailer");
const sent = [];
let failNextSends = 0;
let failTo = null; // fail every send to this address
mailer.sendMail = async (opts) => {
  if (failTo && opts.to === failTo) throw new Error("smtp down");
  if (failNextSends > 0) { failNextSends--; throw new Error("smtp down"); }
  sent.push(opts);
};
const helloasso = require("../../src/lib/helloasso");
const intents = new Map();
let lookups = [];
helloasso.getCheckoutIntent = async (id) => {
  lookups.push(String(id));
  const v = intents.get(String(id));
  if (v instanceof Error) throw v;
  if (!v) throw new Error(`unknown intent ${id}`);
  return v;
};

const { pool } = require("../../src/db");
const {
  detectRefundedOrders, sendCustomerPickupReminders, sendAdminPickupDigest, runOrderFollowUps, buildCustomerPickupReminder,
} = require("../../src/lib/orderSweeps");

before(() => db.create());
after(async () => { await pool.end(); db.drop(); });
beforeEach(() => { sent.length = 0; lookups = []; failNextSends = 0; failTo = null; intents.clear(); });

const orderRow = async (id) => (await pool.query("SELECT * FROM orders WHERE id = $1", [id])).rows[0];
const refundedIntent = (state = "Refunded") => ({ id: 1, order: { id: 9, payments: [{ state }] } });
const paidIntent = { id: 1, order: { id: 9, payments: [{ state: "Authorized" }] } };
// Other tests' orders must not interfere: each test works on its own and only
// looks at emails that mention its own order numbers.
const mailsAbout = (id) => sent.filter((m) => (m.subject + m.text).includes(`#${id}`));

test("a paid order refunded in HelloAsso is flagged and the admin is alerted ONCE; nothing is restocked", async () => {
  const { order, copyIds } = await makeOrder(pool, { paidDaysAgo: 3, intentId: "sw-refund-1" });
  intents.set("sw-refund-1", refundedIntent("Refunded"));

  const first = await detectRefundedOrders(pool);
  assert.ok(first.detected >= 1);
  const row = await orderRow(order.id);
  assert.ok(row.refund_detected_at);
  assert.ok(row.refund_alert_sent_at);
  assert.equal(row.status, "paid", "never marked refunded automatically");
  assert.equal((await pool.query("SELECT status FROM book_copies WHERE id = $1", [copyIds[0]])).rows[0].status, "sold", "never restocked automatically");

  const mails = mailsAbout(order.id);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].subject, `Order #${order.id} was refunded in HelloAsso: mark it refunded in admin to restock`);
  assert.match(mails[0].text, new RegExp(`/admin/orders/${order.id}`));

  // Second and third runs: already flagged, no new lookup for it, no new email.
  lookups = [];
  await detectRefundedOrders(pool);
  await detectRefundedOrders(pool);
  assert.ok(!lookups.includes("sw-refund-1"));
  assert.equal(mailsAbout(order.id).length, 1);
});

test("several refunds found in one run produce one email, and 'Canceled' and 'Refunding' count too", async () => {
  const a = await makeOrder(pool, { paidDaysAgo: 1, intentId: "sw-multi-a" });
  const b = await makeOrder(pool, { paidDaysAgo: 2, intentId: "sw-multi-b" });
  intents.set("sw-multi-a", refundedIntent("Canceled"));
  intents.set("sw-multi-b", refundedIntent("Refunding"));
  await detectRefundedOrders(pool);
  assert.ok((await orderRow(a.order.id)).refund_detected_at);
  assert.ok((await orderRow(b.order.id)).refund_detected_at);
  const mails = sent.filter((m) => m.text.includes(`#${a.order.id}`));
  assert.equal(mails.length, 1);
  assert.ok(mails[0].text.includes(`#${b.order.id}`));
  assert.match(mails[0].subject, /orders were refunded in HelloAsso/);
});

test("orders still paid in HelloAsso (even after a canceled first attempt), lookup errors and old orders are not flagged", async () => {
  const ok = await makeOrder(pool, { paidDaysAgo: 1, intentId: "sw-ok" });
  intents.set("sw-ok", paidIntent);
  const retried = await makeOrder(pool, { paidDaysAgo: 1, intentId: "sw-retried" });
  intents.set("sw-retried", { id: 2, order: { payments: [{ state: "Canceled" }, { state: "Authorized" }] } });
  const flaky = await makeOrder(pool, { paidDaysAgo: 1, intentId: "sw-flaky" });
  intents.set("sw-flaky", Object.assign(new Error("HelloAsso API failed: 500"), { kind: "http" }));
  const old = await makeOrder(pool, { paidDaysAgo: 45, intentId: "sw-old" });
  intents.set("sw-old", refundedIntent());
  const noIntent = await makeOrder(pool, { paidDaysAgo: 1, intentId: null });

  await detectRefundedOrders(pool);
  for (const o of [ok, retried, flaky, old, noIntent]) assert.equal((await orderRow(o.order.id)).refund_detected_at, null);
  assert.ok(!lookups.includes("sw-old"), "orders paid more than 30 days ago are not re-checked");
  assert.equal(mailsAbout(ok.order.id).length + mailsAbout(old.order.id).length, 0);
});

test("a failed alert email is retried by the next run (the claim is handed back)", async () => {
  const { order } = await makeOrder(pool, { paidDaysAgo: 1, intentId: "sw-retry-mail" });
  intents.set("sw-retry-mail", refundedIntent());
  failNextSends = 1;
  await detectRefundedOrders(pool);
  let row = await orderRow(order.id);
  assert.ok(row.refund_detected_at);
  assert.equal(row.refund_alert_sent_at, null);
  assert.equal(mailsAbout(order.id).length, 0);

  await detectRefundedOrders(pool);
  row = await orderRow(order.id);
  assert.ok(row.refund_alert_sent_at);
  assert.equal(mailsAbout(order.id).length, 1);
});

test("a systemic HelloAsso failure stops the refund check instead of timing out on every order", async () => {
  const a = await makeOrder(pool, { paidDaysAgo: 1, intentId: "sw-down-a" });
  const b = await makeOrder(pool, { paidDaysAgo: 1, intentId: "sw-down-b" });
  const down = Object.assign(new Error("HelloAsso auth failed: 401"), { kind: "auth" });
  intents.set("sw-down-a", down);
  intents.set("sw-down-b", down);
  const res = await runOrderFollowUps(pool);
  assert.ok(!res.refunds.error);
  assert.equal(lookups.filter((x) => x === "sw-down-a" || x === "sw-down-b").length, 1);
  assert.equal((await orderRow(a.order.id)).refund_detected_at, null);
  assert.equal((await orderRow(b.order.id)).refund_detected_at, null);
});

test("customer pickup reminder: day 10 to 14 only, once, EN or FR, never for a drop-in-only or refund-flagged or collected order", async () => {
  const due = await makeOrder(pool, { paidDaysAgo: 11, lang: "en", name: "Edith Reader" });
  const dueFr = await makeOrder(pool, { paidDaysAgo: 10, lang: "fr", name: "Édith Lectrice" });
  const early = await makeOrder(pool, { paidDaysAgo: 5 });
  const late = await makeOrder(pool, { paidDaysAgo: 16 });
  const collected = await makeOrder(pool, { paidDaysAgo: 11, collected: true });
  const dropinOnly = await makeOrder(pool, { paidDaysAgo: 11, books: 0, seat: true });
  const flagged = await makeOrder(pool, { paidDaysAgo: 11 });
  await pool.query("UPDATE orders SET refund_detected_at = now() WHERE id = $1", [flagged.order.id]);
  const refunded = await makeOrder(pool, { status: "refunded", paidDaysAgo: 11 });

  await sendCustomerPickupReminders(pool);
  const to = (o) => sent.filter((m) => m.to === o.order.buyer_email);
  assert.equal(to(due).length, 1);
  assert.match(to(due)[0].subject, /Your books are waiting at the shop/);
  assert.match(to(due)[0].text, /within 14 days of payment/);
  assert.match(to(due)[0].text, /Tuesday to Saturday, 10:00 to 19:00/);
  assert.match(to(due)[0].text, /Rue Peyrolière/);
  assert.match(to(due)[0].text, /write to us at admin@umasbooks\.org/);
  assert.equal(to(dueFr).length, 1);
  assert.match(to(dueFr)[0].subject, /Vos livres vous attendent à la boutique/);
  assert.match(to(dueFr)[0].text, /du mardi au samedi, de 10 h à 19 h/);
  for (const o of [early, late, collected, dropinOnly, flagged, refunded]) assert.equal(to(o).length, 0);

  assert.ok((await orderRow(due.order.id)).customer_pickup_reminder_sent_at);
  sent.length = 0;
  await sendCustomerPickupReminders(pool);
  assert.equal(to(due).length, 0, "once per order");
});

test("the pickup reminder only repeats what the terms of sale say: no promise about what happens after 14 days", async () => {
  const { order } = await makeOrder(pool, { paidDaysAgo: 11 });
  for (const lang of ["en", "fr"]) {
    const { text, subject } = buildCustomerPickupReminder({ ...order, lang }, [{ item_title: "A Book" }]);
    assert.doesNotMatch(text + subject, /refund|rembours|cancel|annul|forfeit|donat|don /i, lang);
    assert.match(text, /14/);
  }
});

test("a failed customer reminder is retried by the next run", async () => {
  const { order } = await makeOrder(pool, { paidDaysAgo: 12 });
  failTo = order.buyer_email;
  await sendCustomerPickupReminders(pool);
  assert.equal((await orderRow(order.id)).customer_pickup_reminder_sent_at, null);
  failTo = null;
  await sendCustomerPickupReminders(pool);
  assert.ok((await orderRow(order.id)).customer_pickup_reminder_sent_at);
  assert.equal(sent.filter((m) => m.to === order.buyer_email).length, 1);
});

test("admin digest: day 12 and later, not collected, once per order, one email for the batch", async () => {
  const a = await makeOrder(pool, { paidDaysAgo: 12, name: "Digest A" });
  const b = await makeOrder(pool, { paidDaysAgo: 20, name: "Digest B" });
  const young = await makeOrder(pool, { paidDaysAgo: 11 });
  const collected = await makeOrder(pool, { paidDaysAgo: 13, collected: true });
  const dropinOnly = await makeOrder(pool, { paidDaysAgo: 13, books: 0, seat: true });

  await sendAdminPickupDigest(pool);
  const digests = sent.filter((m) => /not collected after 12 days/.test(m.subject));
  assert.equal(digests.length, 1);
  const text = digests[0].text;
  assert.ok(text.includes(`#${a.order.id}`) && text.includes(`#${b.order.id}`));
  for (const o of [young, collected, dropinOnly]) assert.ok(!text.includes(`Order #${o.order.id}:`));
  assert.match(text, /\/admin\/orders\/\d+/);

  sent.length = 0;
  await sendAdminPickupDigest(pool);
  assert.equal(sent.length, 0, "an order is listed in one digest only");
  assert.ok((await orderRow(a.order.id)).pickup_reminder_sent_at);
});
