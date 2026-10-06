// Launch safety, part 3 (accounts and personal data):
//  - never-confirmed self-signup accounts are purged after 7 days, but only
//    when they hold no data;
//  - export, erasure and "My account" match orders by the ACCOUNT (user_id),
//    not only by its current email, and never show/erase another account's
//    orders just because an old address matches;
//  - an admin email change keeps older orders with the account;
//  - after an erasure, registering again with the same email gets the paid
//    membership back.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");
const { createAccount, loginOverHttp } = require("../helpers/accounts");

const PORT = 4104;
const FORM = { "content-type": "application/x-www-form-urlencoded" };

// HelloAsso is stubbed BEFORE lib/membership loads (it destructures these).
const helloasso = require("../../src/lib/helloasso");
let mockedOrders = [];
helloasso.isConfigured = () => true;
helloasso.findMembershipOrdersByEmail = async (email) =>
  mockedOrders.filter((o) => o.payer.email.toLowerCase() === email.toLowerCase());

let app, pool, privacy, membership;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  await app.waitForLog(/Retention purge/); // the boot purge must not race the old rows below
  privacy = require("../../src/lib/privacy");
  membership = require("../../src/lib/membership");
});
after(async () => {
  await pool.end();
  app.stop();
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const email = (tag) => `${tag}-${uniq()}@example.test`;

async function pendingSignup({ daysOld, pending = true, verified = false }) {
  const e = email("pend");
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, first_verification_pending, email_verified_at, created_at)
     VALUES ($1, 'x', 'Pending', $2, CASE WHEN $3::boolean THEN now() END, now() - make_interval(days => $4::int)) RETURNING id`,
    [e, pending, verified, daysOld]
  );
  return { id: rows[0].id, email: e };
}
const exists = async (id) => (await pool.query("SELECT 1 FROM users WHERE id = $1", [id])).rowCount === 1;
const orderFor = async ({ userId, buyerEmail }) =>
  (await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, total_amount, status, user_id, paid_at)
     VALUES ('Buyer', $1, 10, 'paid', $2, now()) RETURNING id`, [buyerEmail, userId])).rows[0].id;

// ---------- 6. purge of unconfirmed accounts ----------

test("RETENTION has the 7-day constant", () => {
  assert.equal(privacy.RETENTION.unconfirmedAccountDays, 7);
});

test("an unconfirmed self-signup older than 7 days with no data is deleted; the purge counts it", async () => {
  const old = await pendingSignup({ daysOld: 8 });
  const counts = await privacy.purgeExpiredPersonalData(pool);
  assert.notEqual(counts.unconfirmedAccounts, "error");
  assert.ok(counts.unconfirmedAccounts >= 1);
  assert.equal(await exists(old.id), false);
});

test("kept: younger than 7 days, confirmed, admin-created (not pending), admins", async () => {
  const young = await pendingSignup({ daysOld: 3 });
  const confirmed = await pendingSignup({ daysOld: 30, pending: true, verified: true });
  const adminMade = await pendingSignup({ daysOld: 30, pending: false });
  const admin = await pendingSignup({ daysOld: 30 });
  await pool.query("UPDATE users SET is_admin = true WHERE id = $1", [admin.id]);
  await privacy.purgeExpiredPersonalData(pool);
  for (const u of [young, confirmed, adminMade, admin]) assert.equal(await exists(u.id), true);
});

test("kept when the account or its address holds data: order, membership payment, sign-up, request", async () => {
  const withOrder = await pendingSignup({ daysOld: 20 });
  await orderFor({ userId: null, buyerEmail: withOrder.email });
  const withPayment = await pendingSignup({ daysOld: 20 });
  await pool.query("INSERT INTO membership_payments (user_id, helloasso_order_id, payer_email, paid_at) VALUES (NULL, $1, $2, now())", [Date.now() % 1e9, withPayment.email]);
  const withSignup = await pendingSignup({ daysOld: 20 });
  const { rows: ev } = await pool.query("INSERT INTO events (title, starts_at) VALUES ('E', now() + interval '1 day') RETURNING id");
  await pool.query("INSERT INTO event_signups (event_id, name, email) VALUES ($1, 'N', $2)", [ev[0].id, withSignup.email]);
  const withRequest = await pendingSignup({ daysOld: 20 });
  await pool.query("INSERT INTO book_requests (title, email, status, user_id) VALUES ('T', $1, 'open', $2)", [withRequest.email, withRequest.id]);
  const orderByUserId = await pendingSignup({ daysOld: 20 });
  await orderFor({ userId: orderByUserId.id, buyerEmail: "someone-else@example.test" });
  await privacy.purgeExpiredPersonalData(pool);
  for (const u of [withOrder, withPayment, withSignup, withRequest, orderByUserId]) assert.equal(await exists(u.id), true);
});

// ---------- 7. orders follow the account ----------

async function adminJar() {
  const admin = await createAccount(pool, { email: email("adm"), displayName: "Adm" });
  await pool.query("UPDATE users SET is_admin = true WHERE id = $1", [admin.id]);
  const jar = makeCookieJar();
  assert.equal((await loginOverHttp(app.base, jar, admin)).status, 302);
  return jar;
}
async function adminEditEmail(jar, id, newEmail) {
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/admin/members/${id}/edit`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ displayName: "Renamed", email: newEmail, _csrf: token }).toString(),
  });
  assert.equal(res.status, 302);
}

test("after an admin email change the account export still has its older orders, and a stranger on the old address gets none", async () => {
  const { buildMemberExport } = require("../../src/lib/memberExport");
  const jar = await adminJar();
  const oldEmail = email("old");
  const owner = await createAccount(pool, { email: oldEmail, displayName: "Owner" });
  const linked = await orderFor({ userId: owner.id, buyerEmail: oldEmail });       // placed with an account
  const legacy = await orderFor({ userId: null, buyerEmail: oldEmail });           // placed before accounts were required
  const newEmail = email("new");
  await adminEditEmail(jar, owner.id, newEmail);

  const mine = await buildMemberExport(pool, owner.id);
  assert.deepEqual(mine.orders.map((o) => o.id).sort(), [linked, legacy].sort(), "both orders stay with the account");
  assert.equal((await pool.query("SELECT user_id FROM orders WHERE id = $1", [legacy])).rows[0].user_id, owner.id, "legacy order linked by user_id at the change");

  // A stranger registers the OLD address.
  const stranger = await createAccount(pool, { email: oldEmail, displayName: "Stranger" });
  assert.notEqual(stranger.id, owner.id);
  const theirs = await buildMemberExport(pool, stranger.id);
  assert.deepEqual(theirs.orders, [], "the stranger's export has none of them");

  const sjar = makeCookieJar();
  assert.equal((await loginOverHttp(app.base, sjar, stranger)).status, 302);
  const page = await (await fetch(`${app.base}/account`, { headers: { cookie: sjar.header() } })).text();
  assert.match(page, /No orders yet/, "the stranger's My Account shows no orders");
  assert.equal((await pool.query("SELECT 1 FROM orders WHERE id = ANY($1) AND buyer_email = $2", [[linked, legacy], oldEmail])).rowCount, 2);
});

test("a legacy order is NOT linked when the account never proved its address", async () => {
  const jar = await adminJar();
  const oldEmail = email("unv");
  const u = await createAccount(pool, { email: oldEmail, confirmed: false });
  const legacy = await orderFor({ userId: null, buyerEmail: oldEmail });
  await adminEditEmail(jar, u.id, email("unv-new"));
  assert.equal((await pool.query("SELECT user_id FROM orders WHERE id = $1", [legacy])).rows[0].user_id, null);
});

test("the account's own page lists orders by user_id after the email changed", async () => {
  const jar = await adminJar();
  const oldEmail = email("pg");
  const owner = await createAccount(pool, { email: oldEmail });
  const id = await orderFor({ userId: owner.id, buyerEmail: oldEmail });
  const newEmail = email("pg-new");
  await adminEditEmail(jar, owner.id, newEmail);
  await pool.query("UPDATE users SET email_verified_at = now(), password_hash = $2 WHERE id = $1", [owner.id, await bcrypt.hash(owner.password, 4)]);
  const ojar = makeCookieJar();
  assert.equal((await loginOverHttp(app.base, ojar, { ...owner, email: newEmail })).status, 302);
  const page = await (await fetch(`${app.base}/account`, { headers: { cookie: ojar.header() } })).text();
  assert.doesNotMatch(page, /No orders yet/, `order ${id} is listed for its owner`);
});

test("erasing an account anonymises its orders by user_id and leaves another account's orders alone", async () => {
  const oldEmail = email("er-old");
  const owner = await createAccount(pool, { email: oldEmail });
  const mineId = await orderFor({ userId: owner.id, buyerEmail: oldEmail });
  await pool.query("UPDATE users SET email = $2 WHERE id = $1", [owner.id, email("er-new")]); // admin changed it; the order kept the old address
  const stranger = await createAccount(pool, { email: oldEmail });
  const strangerOrder = await orderFor({ userId: stranger.id, buyerEmail: oldEmail });
  const state = async () => Object.fromEntries((await pool.query("SELECT id, buyer_name, buyer_email FROM orders WHERE id = ANY($1)", [[mineId, strangerOrder]])).rows.map((r) => [r.id, r]));

  // Erasing the STRANGER (current email = the old address) must not touch the first owner's order.
  await privacy.eraseMember(pool, stranger.id);
  let by = await state();
  assert.equal(by[mineId].buyer_name, "Buyer", "another account's order is untouched");
  assert.equal(by[strangerOrder].buyer_name, "Erased");

  // Erasing the owner finds the order by user_id although the email no longer matches it.
  await privacy.eraseMember(pool, owner.id);
  by = await state();
  assert.equal(by[mineId].buyer_name, "Erased");
  assert.match(by[mineId].buyer_email, /@erased\.invalid$/);
});

test("erasure still anonymises legacy orders (no account) found by email", async () => {
  const e = email("legacy");
  const u = await createAccount(pool, { email: e });
  const id = await orderFor({ userId: null, buyerEmail: e });
  await privacy.eraseMember(pool, u.id);
  assert.equal((await pool.query("SELECT buyer_name FROM orders WHERE id = $1", [id])).rows[0].buyer_name, "Erased");
});

// ---------- membership after erase + re-register ----------

const paidOrder = (payerEmail, id) => ({ id, payer: { email: payerEmail }, payments: [{ state: "Authorized" }], amount: { total: 3000 }, date: new Date().toISOString() });

test("erase, register again with the same email: the paid membership is restored (orphan payment re-attached)", async () => {
  const e = email("again");
  const orderId = 700000000 + (Date.now() % 100000000);
  mockedOrders = [paidOrder(e, orderId)];
  const first = await createAccount(pool, { email: e });
  await membership.syncMembershipForEmail(pool, e);
  assert.equal((await pool.query("SELECT is_member FROM users WHERE id = $1", [first.id])).rows[0].is_member, true);

  await privacy.eraseMember(pool, first.id);
  let pay = (await pool.query("SELECT user_id, payer_email FROM membership_payments WHERE helloasso_order_id = $1", [orderId])).rows[0];
  assert.equal(pay.user_id, null, "payment kept for accounting, detached");

  const second = await createAccount(pool, { email: e });
  assert.notEqual(second.id, first.id);
  await membership.syncMembershipForEmail(pool, e);
  const u = (await pool.query("SELECT is_member, member_expires_at FROM users WHERE id = $1", [second.id])).rows[0];
  assert.equal(u.is_member, true, "membership restored");
  assert.ok(u.member_expires_at);
  pay = (await pool.query("SELECT user_id, payer_email FROM membership_payments WHERE helloasso_order_id = $1", [orderId])).rows[0];
  assert.equal(pay.user_id, second.id);
  assert.equal(pay.payer_email, e);
});

test("a payment owned by another account is never taken over by the sync", async () => {
  const a = email("own-a");
  const orderId = 710000000 + (Date.now() % 100000000);
  mockedOrders = [paidOrder(a, orderId)];
  const owner = await createAccount(pool, { email: a });
  await membership.syncMembershipForEmail(pool, a);
  const b = email("own-b");
  const other = await createAccount(pool, { email: b });
  mockedOrders = [paidOrder(b, orderId)]; // same HelloAsso order id arriving for another address
  await membership.syncMembershipForEmail(pool, b);
  assert.equal((await pool.query("SELECT user_id FROM membership_payments WHERE helloasso_order_id = $1", [orderId])).rows[0].user_id, owner.id);
  assert.equal((await pool.query("SELECT is_member FROM users WHERE id = $1", [other.id])).rows[0].is_member, false);
});
