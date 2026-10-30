// Review 5, item A: a refund/dispute reverses the recorded payment by HelloAsso ORDER ID, whoever owns it.
// Before: the per-account pass only looked at payments owned by the account whose email HelloAsso reported, so a
// payment linked by hand ("Link to account") to an account with a different email stayed valid after a refund.
// Also: an unmatched payment refunded before it is linked must not grant membership.
// Own throwaway database, HelloAsso mocked.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase } = require("../helpers/testDatabase");
const db = prepareDatabase("memrefundbyorder", { isolated: true });

const helloasso = require("../../src/lib/helloasso");
let mockedOrders = [];
let configured = false;
let lookupFails = false;
helloasso.isConfigured = () => configured;
helloasso.findMembershipOrdersByEmail = async (email) => {
  if (lookupFails) throw new Error("down");
  return mockedOrders.filter((o) => o.payer.email.toLowerCase() === email.toLowerCase());
};

const { pool } = require("../../src/db");
const membership = require("../../src/lib/membership");

before(() => { db.create(); });
after(async () => { await pool.end(); db.drop(); });

const rid = () => Math.floor(Math.random() * 2e9);
const q = async (sql, p) => (await pool.query(sql, p)).rows;
const mkUser = async (label) => {
  const email = `${label}-${rid()}@example.test`;
  const [u] = await q("INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, 'x', 'T', now()) RETURNING id, email", [email]);
  return u;
};
const order = (email, id, state) =>
  ({ id, payer: { email }, payments: [{ state }], amount: { total: 2000 }, date: new Date().toISOString(), formSlug: "adhesion" });
const member = async (id) => (await q("SELECT is_member, member_expires_at FROM users WHERE id = $1", [id]))[0];

test("A1: a refund reverses a payment linked to an account with a DIFFERENT email", async () => {
  const u = await mkUser("real");
  const typo = `typo-${rid()}@example.test`;
  const id = rid();
  await q("INSERT INTO membership_payments (user_id, helloasso_order_id, payer_email, amount_cents, paid_at, linked_at) VALUES ($1,$2,$3,2000,now(),now())", [u.id, id, typo]);
  await membership.applyMembershipGrant(pool, u.id);
  assert.equal((await member(u.id)).is_member, true);

  mockedOrders = [order(typo, id, "Refunded")];
  await membership.syncMembershipForEmail(pool, typo);

  const [row] = await q("SELECT reversed_at, reversed_amount_cents FROM membership_payments WHERE helloasso_order_id = $1", [id]);
  assert.ok(row.reversed_at, "payment marked reversed (kept, not deleted)");
  assert.equal(row.reversed_amount_cents, 2000);
  const m = await member(u.id);
  assert.equal(m.is_member, false);
  assert.equal(m.member_expires_at, null);
});

test("A2: reversing one of two payments keeps the other one's membership", async () => {
  const u = await mkUser("two");
  const typo = `typo2-${rid()}@example.test`;
  const [a, b] = [rid(), rid()];
  await q("INSERT INTO membership_payments (user_id, helloasso_order_id, payer_email, amount_cents, paid_at) VALUES ($1,$2,$3,2000,now() - interval '10 days')", [u.id, a, typo]);
  await q("INSERT INTO membership_payments (user_id, helloasso_order_id, payer_email, amount_cents, paid_at) VALUES ($1,$2,$3,2000,now())", [u.id, b, u.email]);
  await membership.applyMembershipGrant(pool, u.id);
  mockedOrders = [order(typo, a, "Refunded")];
  await membership.syncMembershipForEmail(pool, typo);
  assert.equal((await member(u.id)).is_member, true);
  const [r] = await q("SELECT reversed_at FROM membership_payments WHERE helloasso_order_id = $1", [b]);
  assert.equal(r.reversed_at, null);
});

test("A3: a manual admin grant (no member_expires_at) is never cleared by a reversal elsewhere", async () => {
  const u = await mkUser("manual");
  await q("UPDATE users SET is_member = TRUE WHERE id = $1", [u.id]);
  const typo = `typo3-${rid()}@example.test`;
  const id = rid();
  await q("INSERT INTO membership_payments (user_id, helloasso_order_id, payer_email, amount_cents, paid_at) VALUES ($1,$2,$3,2000,now())", [u.id, id, typo]);
  mockedOrders = [order(typo, id, "Refunded")];
  await membership.syncMembershipForEmail(pool, typo);
  assert.equal((await member(u.id)).is_member, true);
});

test("A4: an unmatched payment refunded before it is linked is refused (stored reversal)", async () => {
  const u = await mkUser("late");
  const typo = `typo4-${rid()}@example.test`;
  const id = rid();
  mockedOrders = [order(typo, id, "Authorized")];
  await membership.syncMembershipForEmail(pool, typo); // no account: recorded unmatched
  const [p] = await q("SELECT id FROM membership_payments WHERE helloasso_order_id = $1", [id]);
  mockedOrders = [order(typo, id, "Refunded")];
  await membership.syncMembershipForEmail(pool, typo); // refund seen while still unmatched
  const r = await membership.linkUnmatchedPayment(pool, p.id, u.id);
  assert.deepEqual([r.ok, r.reason], [false, "refunded"]);
  assert.equal((await member(u.id)).is_member, false);
  assert.equal((await q("SELECT user_id FROM membership_payments WHERE id = $1", [p.id]))[0].user_id, null);
});

test("A5: link re-checks HelloAsso live (webhook missed): refunded -> refused and recorded as reversed; unreachable -> refused", async () => {
  const u = await mkUser("live");
  const typo = `typo5-${rid()}@example.test`;
  const id = rid();
  mockedOrders = [order(typo, id, "Authorized")];
  await membership.syncMembershipForEmail(pool, typo);
  const [p] = await q("SELECT id FROM membership_payments WHERE helloasso_order_id = $1", [id]);
  configured = true;
  try {
    lookupFails = true;
    assert.equal((await membership.linkUnmatchedPayment(pool, p.id, u.id)).reason, "check_failed");
    lookupFails = false;
    mockedOrders = [order(typo, id, "Refunded")];
    assert.equal((await membership.linkUnmatchedPayment(pool, p.id, u.id)).reason, "refunded");
    assert.ok((await q("SELECT reversed_at FROM membership_payments WHERE id = $1", [p.id]))[0].reversed_at);
    assert.equal((await member(u.id)).is_member, false);
  } finally { configured = false; lookupFails = false; }
});

test("A6: normal matching and linking of a still-valid payment are unchanged", async () => {
  const u = await mkUser("ok");
  const typo = `typo6-${rid()}@example.test`;
  const id = rid();
  mockedOrders = [order(typo, id, "Authorized")];
  await membership.syncMembershipForEmail(pool, typo);
  const [p] = await q("SELECT id FROM membership_payments WHERE helloasso_order_id = $1", [id]);
  configured = true;
  try { assert.equal((await membership.linkUnmatchedPayment(pool, p.id, u.id)).ok, true); } finally { configured = false; }
  assert.equal((await member(u.id)).is_member, true);
  await membership.syncMembershipForEmail(pool, typo);
  assert.equal((await member(u.id)).is_member, true);
});
