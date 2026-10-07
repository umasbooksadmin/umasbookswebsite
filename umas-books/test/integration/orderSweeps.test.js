// The 6-hourly follow-up (lib/orderSweeps.js), the part for orders PAID ONLINE
// before reservations replaced online payment (status 'paid', never collected):
//  - the day-10 customer pickup reminder (EN/FR, once, only inside the 14-day
//    window the terms of sale talk about) and the day-12 admin digest (once);
//  - runOrderFollowUps as a whole: every part runs, and no HelloAsso lookup exists
//    any more (there is no refund detection: refunds are recorded in the shop).
// The reservation sweeps (reminders, expiry notices, admin digest of expiring
// reservations) are in reservationSweeps.test.js.
// Own throwaway database; the mailer is stubbed, HelloAsso must never be called.

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
const helloassoCalls = [];
for (const name of Object.keys(helloasso)) {
  if (typeof helloasso[name] === "function") helloasso[name] = async () => { helloassoCalls.push(name); throw new Error(`HelloAsso must not be called (${name})`); };
}

const { pool } = require("../../src/db");
const {
  sendCustomerPickupReminders, sendAdminPickupDigest, runOrderFollowUps, buildCustomerPickupReminder,
} = require("../../src/lib/orderSweeps");

before(() => db.create());
after(async () => { await pool.end(); db.drop(); });
beforeEach(() => { sent.length = 0; failNextSends = 0; failTo = null; helloassoCalls.length = 0; });

const orderRow = async (id) => (await pool.query("SELECT * FROM orders WHERE id = $1", [id])).rows[0];
test("runOrderFollowUps runs the reservation parts and the legacy parts, and never asks HelloAsso anything (no refund detection any more)", async () => {
  const res = await runOrderFollowUps(pool);
  for (const key of ["release", "reservationReminders", "seatReminders", "expiryNotices", "adminReservationDigest", "customerReminders", "adminDigest"]) {
    assert.ok(res[key] && !res[key].error, `${key} ran`);
  }
  assert.equal(res.refunds, undefined, "the refund-detection part is gone");
  assert.deepEqual(helloassoCalls, []);
  assert.equal(typeof require("../../src/lib/orderSweeps").detectRefundedOrders, "undefined");
});

test("a paid order whose old HelloAsso payment was refunded is NOT flagged or emailed: refunds are recorded by hand in the shop", async () => {
  const { order } = await makeOrder(pool, { paidDaysAgo: 3, intentId: "sw-refund-1" });
  await runOrderFollowUps(pool);
  const row = await orderRow(order.id);
  assert.equal(row.refund_detected_at, null);
  assert.equal(row.status, "paid");
  assert.equal(sent.filter((m) => /refunded in HelloAsso/i.test(m.subject)).length, 0);
  assert.deepEqual(helloassoCalls, []);
});

test("customer pickup reminder (order paid online): day 10 to 14 only, once, EN or FR, never for a drop-in-only, refunded or collected order", async () => {
  const due = await makeOrder(pool, { paidDaysAgo: 11, lang: "en", name: "Edith Reader" });
  const dueFr = await makeOrder(pool, { paidDaysAgo: 10, lang: "fr", name: "Édith Lectrice" });
  const early = await makeOrder(pool, { paidDaysAgo: 5 });
  const late = await makeOrder(pool, { paidDaysAgo: 16 });
  const collected = await makeOrder(pool, { paidDaysAgo: 11, collected: true });
  const dropinOnly = await makeOrder(pool, { paidDaysAgo: 11, books: 0, seat: true });
  const refunded = await makeOrder(pool, { status: "refunded", paidDaysAgo: 11 });

  await sendCustomerPickupReminders(pool);
  const to = (o) => sent.filter((m) => m.to === o.order.buyer_email);
  assert.equal(to(due).length, 1);
  assert.match(to(due)[0].subject, /Your books are waiting at the shop/);
  assert.match(to(due)[0].text, /within 14 days of payment/);
  assert.match(to(due)[0].text, /Tuesday to Saturday, 10:00–19:00/);
  assert.match(to(due)[0].text, /Rue Peyrolière/);
  assert.match(to(due)[0].text, /write to us at admin@umasbooks\.org/);
  assert.equal(to(dueFr).length, 1);
  assert.match(to(dueFr)[0].subject, /Vos livres vous attendent à la boutique/);
  assert.match(to(dueFr)[0].text, /du mardi au samedi, 10\u00a0h–19\u00a0h/);
  for (const o of [early, late, collected, dropinOnly, refunded]) assert.equal(to(o).length, 0);

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

test("admin digest (orders paid online): day 12 and later, not collected, once per order, one email for the batch", async () => {
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
  assert.match(text, /\/admin\/orders\?show=uncollected/, "the link to the full list uses the real filter name");

  sent.length = 0;
  await sendAdminPickupDigest(pool);
  assert.equal(sent.length, 0, "an order is listed in one digest only");
  assert.ok((await orderRow(a.order.id)).pickup_reminder_sent_at);
});
