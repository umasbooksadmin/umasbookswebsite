// A reservation is paid IN PERSON, so it must be counted exactly once and under the method it was
// really paid with: collected at the till (counted from the till's lines, never again from the
// order), or collected with the admin "Mark collected and paid" button (counted from the order, by
// orders.payment_method). HelloAsso is only for memberships and old online-checkout orders.
// Real app, real database; the Accounting export, the CSV, the Dashboard and the accounts mapping
// are compared with the takings the test knows.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { tillHarness } = require("../helpers/tillHarness");
const { makeOrder } = require("../helpers/orderFixtures");

let h;
let cart;
before(async () => {
  h = await tillHarness({ port: 4362, ip: "10.82.6.6" });
  cart = require("../../src/lib/cart");
});
after(async () => { await h.stop(); });

async function reserve(price) {
  const { rows: u } = await h.pool.query(
    "INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, 'x', 'Acc Reserver', now()) RETURNING id, email", [`acc-res-${h.uniq()}@example.test`]);
  const book = await h.seedBook(`Acc Reserved ${h.uniq()}`);
  const copy = await h.seedCopy(book.id, { price, location: "R7" });
  const order = await cart.createReservation(h.pool, {
    user: u[0], name: "Acc Reserver", items: [{ kind: "book", copyId: copy, title: `Acc ${copy}`, price }], acceptedVersion: "v", hasDropin: false,
  });
  const lines = (await h.pool.query("SELECT id FROM order_items WHERE order_id = $1", [order.id])).rows;
  return { order, lines };
}
const atTill = async (r, method) => {
  const res = await h.sale(r.lines.map((l) => ({ kind: "reserved", orderId: r.order.id, itemId: l.id })), { method, received: "100" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
};
const byAdmin = async (r, method) => {
  const res = await h.post(`/admin/orders/${r.order.id}/collect`, { method });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location") || "", /collected-paid/);
};
const refund = async (r) => {
  const { markOrderRefunded } = require("../../src/lib/orderActions");
  assert.equal((await markOrderRefunded(h.pool, r.order.id, { note: "gave the money back" })).outcome, "refunded");
};

const paris = async () => (await h.pool.query("SELECT (now() AT TIME ZONE 'Europe/Paris')::date::text AS d")).rows[0].d;
async function exportRows(day) {
  const res = await fetch(`${h.app.base}/admin/reports/accounting?from=${day}&to=${day}&format=csv`, { headers: { cookie: h.jar.header(), "x-forwarded-for": h.ip } });
  assert.equal(res.status, 200);
  const text = Buffer.from(await res.arrayBuffer()).toString("utf8").replace(/^﻿/, "").trim();
  const split = (l) => (l.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || []).filter((x, i, a) => i < a.length - 1 || x !== "").map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
  return text.split("\r\n").slice(1).map(split)
    .map(([date, category, method, count, total, , debit, credit]) => ({ date, category, method, count: Number(count), cents: Math.round(Number(total) * 100), debit, credit }));
}
const cell = (rows, category, method, refund = false) => rows.find((r) => r.category === category && r.method === method && (r.cents < 0) === refund);
const sum = (rows, pred = () => true) => rows.filter(pred).reduce((a, r) => a + r.cents, 0);

const fixture = {};
test("a reservation collected at the till (cash), two collected with the admin button (cash, card): each counted once, under its real method", async () => {
  const { accountingRows, salesTotals } = require("../../src/lib/accounting");
  const { salesStats } = require("../../src/lib/dashboardStats");
  const day = await paris();
  fixture.till = await reserve(5); fixture.cash = await reserve(5); fixture.card = await reserve(7);
  await atTill(fixture.till, "cash");
  await byAdmin(fixture.cash, "cash");
  await byAdmin(fixture.card, "card");
  // an old order paid online through HelloAsso (no payment method), and a membership
  fixture.legacy = await makeOrder(h.pool, { price: 10 });
  await h.pool.query("INSERT INTO membership_payments (helloasso_order_id, payer_email, amount_cents, paid_at) VALUES ($1, 'm@example.test', 1500, now())", [Date.now()]);

  // real takings: cash 5 + 5, card 7, old HelloAsso order 10, membership 15
  const rows = await accountingRows(h.pool, day, day);
  const cash = rows.find((r) => r.category === "Books used" && r.method === "Cash");
  assert.deepEqual([cash.count, cash.cents], [2, 1000], "the till reservation and the admin-cash one, each once (not 3 or 4)");
  const card = rows.find((r) => r.category === "Books used" && r.method === "Card at the till");
  assert.deepEqual([card.count, card.cents], [1, 700], "the admin-card one is Card, not HelloAsso");
  const ha = rows.find((r) => r.category === "Books used" && r.method === "HelloAsso");
  assert.deepEqual([ha.count, ha.cents], [1, 1000], "only the old online order is HelloAsso");
  assert.equal(rows.find((r) => r.category === "Membership").cents, 1500);
  assert.equal(rows.reduce((a, r) => a + r.cents, 0), 1000 + 700 + 1000 + 1500);

  // the same function twice: nothing changes (read-only, idempotent)
  assert.deepEqual(await accountingRows(h.pool, day, day), rows);

  const t = await salesTotals(h.pool, day, day);
  assert.deepEqual(t, { totalCents: 4200, tillCents: 1700, onlineCents: 1000, membershipCents: 1500 });

  // the Dashboard's figure
  const stats = await salesStats(h.pool);
  assert.equal(Math.round(stats.salesToday * 100), 4200);
  assert.equal(stats.ordersToday, 4, "collected reservations (3) + the old paid order");
  assert.deepEqual(
    { till: Math.round(stats.salesBreakdown.till * 100), online: Math.round(stats.salesBreakdown.online * 100), membership: Math.round(stats.salesBreakdown.membership * 100) },
    { till: 1700, online: 1000, membership: 1500 });

  // the CSV, with the account mapping (cash 530, card 511, HelloAsso 511, membership income 756)
  const csv = await exportRows(day);
  assert.equal(sum(csv), 4200);
  assert.equal(cell(csv, "Books used", "Cash").debit, "530");
  assert.equal(cell(csv, "Books used", "Card at the till").debit, "511");
  assert.equal(cell(csv, "Books used", "HelloAsso").debit, "511");
  assert.equal(cell(csv, "Books used", "Cash").credit, "707");
  assert.equal(cell(csv, "Membership", "HelloAsso").credit, "756");
  assert.deepEqual([cell(csv, "Books used", "Cash").count, cell(csv, "Books used", "Cash").cents], [2, 1000]);

  // End of day (till sales only): the till reservation, once
  const eod = (await h.get(`/admin/till/day?day=${day}`)).text;
  assert.ok(eod.includes("€5.00"), "End of day shows the till sale");
});

test("cheque and 'other' admin payments: cheque has its own row (bank 511), other goes to 471; a missing method is never invented", async () => {
  const { accountingRows, loadMapping } = require("../../src/lib/accounting");
  const day = await paris();
  const before = await accountingRows(h.pool, day, day);
  const chq = await reserve(3); const oth = await reserve(4);
  await byAdmin(chq, "cheque"); await byAdmin(oth, "other");
  const after = await accountingRows(h.pool, day, day);
  const delta = (m) => (after.find((r) => r.category === "Books used" && r.method === m) || { cents: 0 }).cents - (before.find((r) => r.category === "Books used" && r.method === m) || { cents: 0 }).cents;
  assert.equal(delta("Cheque"), 300);
  assert.equal(delta("Other / not recorded"), 400);
  assert.equal(delta("HelloAsso"), 0);
  const map = await loadMapping(h.pool);
  assert.equal(map.find((m) => m.category === "Books used" && m.method === "Cheque").debit, "511");
  assert.equal(map.find((m) => m.category === "Books used" && m.method === "Other / not recorded").debit, "471");
  await refund(chq); await refund(oth); // keep the later totals simple
});

test("refunds follow the sale's method and count once: till-collected, admin cash, admin card", async () => {
  const { accountingRows, salesTotals } = require("../../src/lib/accounting");
  const { salesStats } = require("../../src/lib/dashboardStats");
  const day = await paris();
  const net = async () => accountingRows(h.pool, day, day);
  const get = (rows, m, neg) => rows.find((r) => r.category === "Books used" && r.method === m && r.refund === neg);

  await refund(fixture.till); // cash, collected at the till, 5.00
  let rows = await net();
  assert.deepEqual([get(rows, "Cash", true).count, get(rows, "Cash", true).cents], [-1, -500], "one negative cash row for the till reservation");
  assert.deepEqual([get(rows, "Cash", false).count, get(rows, "Cash", false).cents], [2, 1000], "its sale is still counted once, on its day");

  await refund(fixture.cash); // cash, admin button, 5.00
  rows = await net();
  assert.deepEqual([get(rows, "Cash", true).count, get(rows, "Cash", true).cents], [-2, -1000]);
  assert.equal(get(rows, "Card at the till", true), undefined, "a cash refund is not a card refund");

  await refund(fixture.card); // card, admin button, 7.00
  rows = await net();
  assert.deepEqual([get(rows, "Card at the till", true).count, get(rows, "Card at the till", true).cents], [-1, -700]);
  assert.equal(get(rows, "HelloAsso", true), undefined, "no refund is labelled HelloAsso");

  // Everything refunded nets to zero, except the old HelloAsso order (10) and the membership (15)
  const t = await salesTotals(h.pool, day, day);
  assert.deepEqual(t, { totalCents: 2500, tillCents: 0, onlineCents: 1000, membershipCents: 1500 });
  assert.equal(Math.round((await salesStats(h.pool)).salesToday * 100), 2500);
  assert.equal(sum(await exportRows(day)), 2500);
});

test("a refunded old HelloAsso order is refunded under HelloAsso, and a legacy order still counts as HelloAsso", async () => {
  const { accountingRows } = require("../../src/lib/accounting");
  const day = await paris();
  const old = await makeOrder(h.pool, { price: 8 });
  let rows = await accountingRows(h.pool, day, day);
  assert.equal(rows.find((r) => r.method === "HelloAsso" && r.category === "Books used" && !r.refund).cents, 1800);
  await h.pool.query("UPDATE orders SET status = 'refunded', refunded_at = now() WHERE id = $1", [old.order.id]);
  rows = await accountingRows(h.pool, day, day);
  const neg = rows.find((r) => r.method === "HelloAsso" && r.category === "Books used" && r.refund);
  assert.deepEqual([neg.count, neg.cents], [-1, -800]);
  // an order explicitly marked helloasso or online is the same
  const ha = await makeOrder(h.pool, { price: 2 });
  await h.pool.query("UPDATE orders SET payment_method = 'helloasso' WHERE id = $1", [ha.order.id]);
  const on = await makeOrder(h.pool, { price: 3 });
  await h.pool.query("UPDATE orders SET payment_method = 'online' WHERE id = $1", [on.order.id]);
  rows = await accountingRows(h.pool, day, day);
  assert.equal(rows.find((r) => r.method === "HelloAsso" && r.category === "Books used" && !r.refund).count, 4);
  assert.equal(rows.find((r) => r.method === "HelloAsso" && r.category === "Books used" && !r.refund).cents, 2300, "legacy 10 + the refunded one's original 8 + 2 + 3 (the 8 is netted by its own negative row)");
});
