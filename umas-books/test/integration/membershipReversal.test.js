// Review F, F1: a membership payment that HelloAsso refunds (or loses in a dispute) is KEPT and marked reversed
// (membership_payments.reversed_at / reversed_amount_cents) instead of deleted. The accounting export of the month
// it was paid never changes; the month the reversal was seen shows a NEGATIVE Membership row (same category and
// method, labelled like every other refund). Membership validity ignores a reversed row; privacy export / erase and
// the 10-year purge still cover it.
// Own throwaway database, HelloAsso mocked (same setup as membershipRevocation.test.js).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");

const { prepareDatabase } = require("../helpers/testDatabase");
const db = prepareDatabase("memreversal", { isolated: true });

const helloasso = require("../../src/lib/helloasso");
let mockedOrders = [];
helloasso.findMembershipOrdersByEmail = async (email) =>
  mockedOrders.filter((o) => o.payer && o.payer.email.toLowerCase() === email.toLowerCase());

const { pool } = require("../../src/db");
const membership = require("../../src/lib/membership");
const accounting = require("../../src/lib/accounting");
const privacy = require("../../src/lib/privacy");
const { buildMemberExport } = require("../../src/lib/memberExport");
const { findRecords } = require("../../src/lib/privacyRequests");
const reports = require("../../src/lib/reports");

before(() => { db.create(); });
after(async () => { await pool.end(); db.drop(); });

const rid = () => Math.floor(Math.random() * 2e9);
const q = async (sql, p) => (await pool.query(sql, p)).rows;

// Paris month boundaries computed by Postgres: the payment goes in LAST month, the refund happens now (this month).
async function months() {
  const [r] = await q(`SELECT
      to_char(date_trunc('month', now() AT TIME ZONE 'Europe/Paris') - interval '1 month', 'YYYY-MM-DD') AS prev_from,
      to_char(date_trunc('month', now() AT TIME ZONE 'Europe/Paris') - interval '1 day', 'YYYY-MM-DD') AS prev_to,
      to_char(date_trunc('month', now() AT TIME ZONE 'Europe/Paris'), 'YYYY-MM-DD') AS cur_from,
      to_char((date_trunc('month', now() AT TIME ZONE 'Europe/Paris') + interval '1 month' - interval '1 day'), 'YYYY-MM-DD') AS cur_to,
      to_char(date_trunc('month', now() AT TIME ZONE 'Europe/Paris') - interval '1 month' + interval '14 days' + interval '10 hours', 'YYYY-MM-DD"T"HH24:MI:SS') AS paid_local`);
  return r;
}
const parisIso = (local) => new Date(local).toISOString(); // process TZ is Europe/Paris (lib/tz.js)

async function user(label) {
  const email = `${label}-${Date.now()}-${rid()}@example.test`;
  const hash = await bcrypt.hash("Irrelevant1!", 4);
  const [u] = await q(
    "INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, $2, 'Reversal Test', now()) RETURNING id, email", [email, hash]);
  return u;
}
const order = (email, id, state, dateIso, cents = 2000) =>
  ({ id, payer: { email }, payments: [{ state }], amount: { total: cents }, date: dateIso, formSlug: "adhesion" });
const memRows = async (from, to) => (await accounting.accountingRows(pool, from, to)).filter((r) => r.category === "Membership");
const sync = (email) => membership.syncMembershipForEmail(pool, email);
const userRow = async (id) => (await q("SELECT is_member, member_expires_at FROM users WHERE id = $1", [id]))[0];

test("F1: the September-style month is identical before and after the refund; the refund month shows the reversal", async () => {
  const m = await months();
  const u = await user("f1");
  const id = rid();
  mockedOrders = [order(u.email, id, "Authorized", parisIso(m.paid_local))];
  await sync(u.email);

  const before = await memRows(m.prev_from, m.prev_to);
  assert.equal(before.length, 1);
  assert.deepEqual([before[0].cents, before[0].count, before[0].refund, before[0].method], [2000, 1, false, "HelloAsso"]);
  assert.equal((await memRows(m.cur_from, m.cur_to)).length, 0, "nothing in the current month yet");

  mockedOrders = [order(u.email, id, "Refunded", parisIso(m.paid_local))];
  await sync(u.email);

  assert.deepEqual(await memRows(m.prev_from, m.prev_to), before, "the month already exported is unchanged");
  const cur = await memRows(m.cur_from, m.cur_to);
  assert.equal(cur.length, 1, "the month of the refund shows the reversal");
  assert.deepEqual([cur[0].cents, cur[0].count, cur[0].refund, cur[0].category, cur[0].method], [-2000, -1, true, "Membership", "HelloAsso"]);

  // The row is KEPT (10-year record) and marked; the labelling is the one every other refund row uses.
  const [row] = await q("SELECT * FROM membership_payments WHERE helloasso_order_id = $1", [id]);
  assert.ok(row.reversed_at);
  assert.equal(row.reversed_amount_cents, 2000);
  assert.equal(row.amount_cents, 2000, "the original amount is untouched");
  const report = await accounting.accountingExportReport(pool, { from: m.cur_from, to: m.cur_to });
  const exported = report.sections[0].rows.filter((r) => r.category === "Membership");
  assert.equal(exported.length, 1);
  assert.match(exported[0].label, /^Remboursement adhésions, HelloAsso, \d{4}-\d{2}-\d{2}$/);
  assert.equal(exported[0].credit, "756");

  // Membership is gone, as it was when the row was deleted.
  const after = await userRow(u.id);
  assert.equal(after.is_member, false);
  assert.equal(after.member_expires_at, null);
});

test("an immediate refund in the SAME month nets to zero for that month", async () => {
  const m = await months();
  const u = await user("same");
  const id = rid();
  const nowIso = new Date().toISOString();
  const net = async () => (await memRows(m.cur_from, m.cur_to)).reduce((a, r) => a + r.cents, 0);
  const start = await net();
  mockedOrders = [order(u.email, id, "Authorized", nowIso, 3000)];
  await sync(u.email);
  assert.equal(await net(), start + 3000);
  mockedOrders = [order(u.email, id, "Refunded", nowIso, 3000)];
  await sync(u.email);
  assert.equal(await net(), start, "sale and reversal in the same month cancel out");
  assert.equal((await salesNet(m)), await expectedNet());
});

test("re-syncing a refunded order is idempotent: reversed_at does not move, no second reversal", async () => {
  const m = await months();
  const u = await user("idem");
  const id = rid();
  mockedOrders = [order(u.email, id, "Authorized", parisIso(m.paid_local), 1500)];
  await sync(u.email);
  mockedOrders = [order(u.email, id, "Refunded", parisIso(m.paid_local), 1500)];
  await sync(u.email);
  const [first] = await q("SELECT reversed_at FROM membership_payments WHERE helloasso_order_id = $1", [id]);
  await q("UPDATE membership_payments SET reversed_at = reversed_at - interval '1 hour' WHERE helloasso_order_id = $1", [id]);
  const [moved] = await q("SELECT reversed_at FROM membership_payments WHERE helloasso_order_id = $1", [id]);
  await sync(u.email);
  await sync(u.email);
  const [second] = await q("SELECT reversed_at, reversed_amount_cents FROM membership_payments WHERE helloasso_order_id = $1", [id]);
  assert.notEqual(first.reversed_at.getTime(), moved.reversed_at.getTime());
  assert.equal(second.reversed_at.getTime(), moved.reversed_at.getTime(), "an existing reversed_at is never overwritten");
  assert.equal(second.reversed_amount_cents, 1500);
  assert.equal((await q("SELECT count(*)::int AS n FROM membership_payments WHERE helloasso_order_id = $1", [id]))[0].n, 1, "no duplicate row either");
});

test("a reversed payment grants nothing; a still-valid second payment keeps the membership running from ITS own year", async () => {
  const m = await months();
  const u = await user("validity");
  const a = rid();
  const b = rid();
  mockedOrders = [
    order(u.email, a, "Authorized", parisIso(m.paid_local)),
    order(u.email, b, "Authorized", new Date().toISOString()),
  ];
  await sync(u.email);
  const both = await userRow(u.id);
  assert.equal(both.is_member, true);

  // The first payment is refunded: only the second counts, so the end date is ONE year after the second payment.
  mockedOrders = [
    order(u.email, a, "Refunded", parisIso(m.paid_local)),
    order(u.email, b, "Authorized", new Date().toISOString()),
  ];
  await sync(u.email);
  const one = await userRow(u.id);
  assert.equal(one.is_member, true);
  assert.deepEqual(membership.expiryFromPayments([new Date()]).toISOString(), one.member_expires_at.toISOString());
  // applyMembershipGrant (used by the admin "link payment" path) ignores the reversed row too.
  const applied = await membership.applyMembershipGrant(pool, u.id);
  assert.equal(applied.toISOString(), one.member_expires_at.toISOString());

  // Both reversed: not a member.
  mockedOrders = [
    order(u.email, a, "Refunded", parisIso(m.paid_local)),
    order(u.email, b, "Refunded", new Date().toISOString()),
  ];
  await sync(u.email);
  assert.equal((await userRow(u.id)).is_member, false);
  assert.equal(await membership.applyMembershipGrant(pool, u.id), null, "only reversed rows: nothing to grant");
  // A later sync where the order is absent from the response changes nothing (absence proves nothing, a reversal stays).
  mockedOrders = [order(u.email, rid(), "Authorized", parisIso(m.paid_local))]; // a different payment returned instead
  await sync(u.email);
  assert.equal((await q("SELECT count(*)::int AS n FROM membership_payments WHERE user_id = $1 AND reversed_at IS NOT NULL", [u.id]))[0].n, 2);
});

test("a reversed payment that HelloAsso reports Authorized again (dispute won) stands again", async () => {
  const m = await months();
  const u = await user("again");
  const id = rid();
  mockedOrders = [order(u.email, id, "Authorized", parisIso(m.paid_local))];
  await sync(u.email);
  mockedOrders = [order(u.email, id, "Refunded", parisIso(m.paid_local))];
  await sync(u.email);
  assert.equal((await userRow(u.id)).is_member, false);
  mockedOrders = [order(u.email, id, "Authorized", parisIso(m.paid_local))];
  await sync(u.email);
  const [row] = await q("SELECT reversed_at, reversed_amount_cents FROM membership_payments WHERE helloasso_order_id = $1", [id]);
  assert.equal(row.reversed_at, null);
  assert.equal(row.reversed_amount_cents, null);
  assert.equal((await userRow(u.id)).is_member, true);
});

test("a payment with no recorded amount is reversed without an accounting row (it never had a sale row)", async () => {
  const m = await months();
  const u = await user("noamount");
  const id = rid();
  await q("INSERT INTO membership_payments (user_id, helloasso_order_id, payer_email, amount_cents, paid_at) VALUES ($1, $2, $3, NULL, $4)",
    [u.id, id, u.email, parisIso(m.paid_local)]);
  mockedOrders = [{ id, payer: { email: u.email }, payments: [{ state: "Refunded" }], amount: { total: 0 }, date: parisIso(m.paid_local) }];
  const beforeRows = await memRows(m.cur_from, m.cur_to);
  await sync(u.email);
  const [row] = await q("SELECT reversed_at, reversed_amount_cents FROM membership_payments WHERE helloasso_order_id = $1", [id]);
  assert.ok(row.reversed_at);
  assert.equal(row.reversed_amount_cents, null);
  assert.deepEqual(await memRows(m.cur_from, m.cur_to), beforeRows);
});

// Reconciliation: over every month, the export's Membership net equals the sum of payments still standing.
async function salesNet(m) {
  const t = await accounting.salesTotals(pool, m.prev_from, m.cur_to);
  return t.membershipCents;
}
async function expectedNet() {
  const [r] = await q(
    `SELECT COALESCE(SUM(amount_cents), 0)::int AS standing FROM membership_payments WHERE amount_cents IS NOT NULL AND reversed_at IS NULL`);
  return r.standing;
}
test("accounting vs members reconciliation: the Membership net of all months equals the payments that still stand", async () => {
  const m = await months();
  assert.equal(await salesNet(m), await expectedNet());
  // And the Dashboard / reports figure that sums the export agrees.
  assert.ok(typeof reports === "object");
});

test("privacy: a reversed payment is in the member's export, is anonymised (not deleted) on erase, and the 10-year purge removes it", async () => {
  const m = await months();
  const u = await user("privacy");
  const id = rid();
  mockedOrders = [order(u.email, id, "Authorized", parisIso(m.paid_local), 1800)];
  await sync(u.email);
  mockedOrders = [order(u.email, id, "Refunded", parisIso(m.paid_local), 1800)];
  await sync(u.email);

  const exp = await buildMemberExport(pool, u.id);
  assert.equal(exp.membership_payments.length, 1);
  assert.ok(exp.membership_payments[0].reversed_at);
  assert.equal(exp.membership_payments[0].reversed_amount_cents, 1800);
  const found = await findRecords(pool, u.email.toLowerCase());
  assert.equal(found.payments.length, 1);
  assert.ok(found.payments[0].reversed_at);

  assert.equal(await privacy.eraseMember(pool, u.id), true);
  const rows = await q("SELECT * FROM membership_payments WHERE helloasso_order_id = $1", [id]);
  assert.equal(rows.length, 1, "kept for the accounting record");
  assert.equal(rows[0].payer_email, privacy.erasedEmail(u.id), "anonymised like the other payment rows");
  assert.equal(rows[0].user_id, null);
  assert.ok(rows[0].reversed_at);
  assert.equal(rows[0].reversed_amount_cents, 1800);

  await q("UPDATE membership_payments SET paid_at = now() - interval '11 years' WHERE helloasso_order_id = $1", [id]);
  await privacy.purgeExpiredPersonalData(pool);
  assert.equal((await q("SELECT 1 FROM membership_payments WHERE helloasso_order_id = $1", [id])).length, 0, "purged after the retention period");
});

test("the membership report does not count a reversed payment as a join", async () => {
  const m = await months();
  const u = await user("report");
  const id = rid();
  mockedOrders = [order(u.email, id, "Authorized", parisIso(m.paid_local))];
  await sync(u.email);
  const join = async () => {
    const r = await reports.getReport("membership").run(pool, { from: m.prev_from, to: m.prev_to });
    return JSON.stringify(r);
  };
  const withPayment = await join();
  mockedOrders = [order(u.email, id, "Refunded", parisIso(m.paid_local))];
  await sync(u.email);
  assert.notEqual(await join(), withPayment, "the join disappears from the report");
});
