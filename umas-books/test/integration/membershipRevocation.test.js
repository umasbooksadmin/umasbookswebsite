// Revocation only on positive evidence (audit finding 10). HelloAsso's
// userSearchKey search is fuzzy and paginated, so a recorded order that
// just isn't in the response proves nothing; a refund shows up as the SAME
// order id returned with a non-Authorized payment. Same setup as
// membershipVerification.test.js (own throwaway DB, mocked HelloAsso).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const bcrypt = require("bcryptjs");

const ROOT = path.join(__dirname, "..", "..");
const OWNS_DATABASE = !process.env.DATABASE_URL;
const TEST_DB = `umasbooks_revocation_test_${Date.now()}`;
process.env.DATABASE_URL = process.env.DATABASE_URL || `postgres://localhost:5432/${TEST_DB}`;
process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";

const helloasso = require("../../src/lib/helloasso");
let mockedOrders = [];
helloasso.findMembershipOrdersByEmail = async (email) =>
  mockedOrders.filter((o) => o.payer && o.payer.email.toLowerCase() === email.toLowerCase());

const { pool } = require("../../src/db");
const { syncMembershipForEmail } = require("../../src/lib/membership");

before(() => {
  if (OWNS_DATABASE) execFileSync("createdb", [TEST_DB], { stdio: "inherit" });
  execFileSync("node", ["src/migrate.js"], { cwd: ROOT, env: process.env, stdio: "inherit" });
});

after(async () => {
  await pool.end();
  if (OWNS_DATABASE) execFileSync("dropdb", ["--if-exists", TEST_DB], { stdio: "inherit" });
});

// Order ids are global (UNIQUE) in a shared CI database, so keep them random.
const rid = () => Math.floor(Math.random() * 2e9);

function order(email, id, state = "Authorized", date = new Date()) {
  return { id, payer: { email }, payments: [{ state }], amount: { total: 3000 }, date: date.toISOString() };
}

async function createVerifiedUser(email) {
  const hash = await bcrypt.hash("Irrelevant1!", 4);
  await pool.query(
    "INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, $2, 'Revocation Test', now())",
    [email, hash]
  );
}

const userRow = async (email) =>
  (await pool.query("SELECT is_member, member_expires_at FROM users WHERE email = $1", [email])).rows[0];
const recordedIds = async (email) =>
  (await pool.query("SELECT helloasso_order_id FROM membership_payments WHERE payer_email = $1 ORDER BY 1", [email]))
    .rows.map((r) => Number(r.helloasso_order_id));

test("a recorded payment absent from the search response is kept (no revocation by absence)", async () => {
  const email = `absent-${Date.now()}@example.test`;
  await createVerifiedUser(email);
  const [a, b, c] = [rid(), rid(), rid()];
  mockedOrders = [order(email, a)];
  await syncMembershipForEmail(pool, email);
  assert.equal((await userRow(email)).is_member, true);

  // The search now returns only a different order (the recorded one fell
  // off the first page, say); the recorded payment must survive.
  mockedOrders = [order(email, b)];
  await syncMembershipForEmail(pool, email);
  assert.equal((await userRow(email)).is_member, true);
  assert.deepEqual(await recordedIds(email), [a, b].sort((x, y) => x - y));

  // Even when everything returned is non-Authorized, an order that is not
  // in the response is untouched.
  mockedOrders = [order(email, c, "Refunded")];
  await syncMembershipForEmail(pool, email);
  assert.equal((await userRow(email)).is_member, true);
  assert.deepEqual(await recordedIds(email), [a, b].sort((x, y) => x - y));
});

test("an order that is present but no longer Authorized (refund) is revoked", async () => {
  const email = `refund-${Date.now()}@example.test`;
  await createVerifiedUser(email);
  const id = rid();
  mockedOrders = [order(email, id)];
  await syncMembershipForEmail(pool, email);
  assert.equal((await userRow(email)).is_member, true);

  mockedOrders = [order(email, id, "Refunded")];
  await syncMembershipForEmail(pool, email);
  const u = await userRow(email);
  assert.equal(u.is_member, false);
  assert.equal(u.member_expires_at, null);
  assert.deepEqual(await recordedIds(email), []);
});

test("refunding one of two orders keeps the other; a newer paid order still extends expiry", async () => {
  const email = `two-orders-${Date.now()}@example.test`;
  await createVerifiedUser(email);
  const [oldId, newId] = [rid(), rid()];
  const oldDate = new Date(Date.now() - 100 * 86400000);
  mockedOrders = [order(email, oldId, "Authorized", oldDate)];
  await syncMembershipForEmail(pool, email);
  const firstExpiry = (await userRow(email)).member_expires_at.getTime();

  mockedOrders = [order(email, newId), order(email, oldId, "Authorized", oldDate)];
  await syncMembershipForEmail(pool, email);
  assert.ok((await userRow(email)).member_expires_at.getTime() > firstExpiry, "newer paid order extends expiry");

  mockedOrders = [order(email, newId), order(email, oldId, "Refunded", oldDate)];
  await syncMembershipForEmail(pool, email);
  assert.equal((await userRow(email)).is_member, true);
  assert.deepEqual(await recordedIds(email), [newId]);
});
