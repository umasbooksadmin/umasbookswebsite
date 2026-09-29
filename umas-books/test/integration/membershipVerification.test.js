// Regression coverage for the core exploit: nothing verified that a
// signup actually controlled the email address it typed in, so an
// attacker could register a real person's email first and, once that
// person later paid for a real HelloAsso membership with their own
// email, silently inherit it — because syncMembershipForEmail matched
// purely on "which account has this email locally", never "does this
// account's holder actually own it". See migrations/032_email_verification.sql
// and the email_verified_at check in lib/membership.js.
//
// Uses its own throwaway database (same pattern as orderIdempotency.test.js)
// and mocks lib/helloasso's findMembershipOrdersByEmail — this is testing
// membership.js's own logic against a real database, not HelloAsso's
// actual API (no sandbox credentials available in CI).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const bcrypt = require("bcryptjs");

const ROOT = path.join(__dirname, "..", "..");
const OWNS_DATABASE = !process.env.DATABASE_URL;
const TEST_DB = `umasbooks_membership_test_${Date.now()}`;
process.env.DATABASE_URL = process.env.DATABASE_URL || `postgres://localhost:5432/${TEST_DB}`;
process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";

// Mocked before requiring membership.js, which destructures
// findMembershipOrdersByEmail off this same exports object at require
// time — same technique as orderIdempotency.test.js's mailer mock.
const helloasso = require("../../src/lib/helloasso");
let mockedOrders = [];
helloasso.findMembershipOrdersByEmail = async (email) =>
  mockedOrders.filter((o) => o.payer && o.payer.email.toLowerCase() === email.toLowerCase());

const { pool } = require("../../src/db");
const { syncMembershipForEmail } = require("../../src/lib/membership");

before(() => {
  if (OWNS_DATABASE) {
    execFileSync("createdb", [TEST_DB], { stdio: "inherit" });
  }
  execFileSync("node", ["src/migrate.js"], { cwd: ROOT, env: process.env, stdio: "inherit" });
});

after(async () => {
  await pool.end();
  if (OWNS_DATABASE) {
    execFileSync("dropdb", ["--if-exists", TEST_DB], { stdio: "inherit" });
  }
});

function authorizedOrder(email, id) {
  return { id, payer: { email }, payments: [{ state: "Authorized" }], amount: { total: 3000 }, date: new Date().toISOString() };
}

async function createUser(email, { verified }) {
  const hash = await bcrypt.hash("Irrelevant1!", 12);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at)
     VALUES ($1, $2, 'Membership Test', ${verified ? "now()" : "NULL"}) RETURNING id`,
    [email, hash]
  );
  return rows[0].id;
}

test("an unverified account is never granted membership, even with a real Authorized order", async () => {
  const email = `unverified-${Date.now()}@example.test`;
  await createUser(email, { verified: false });
  mockedOrders = [authorizedOrder(email, 1)];

  await syncMembershipForEmail(pool, email);

  const { rows } = await pool.query("SELECT is_member, member_expires_at FROM users WHERE email = $1", [email]);
  assert.equal(rows[0].is_member, false);
  assert.equal(rows[0].member_expires_at, null);

  const { rows: payments } = await pool.query("SELECT * FROM membership_payments WHERE payer_email = $1", [email]);
  assert.equal(payments.length, 0, "should not even record the payment against an unverified account");
});

test("a verified account is granted membership from the same real order", async () => {
  const email = `verified-${Date.now()}@example.test`;
  await createUser(email, { verified: true });
  mockedOrders = [authorizedOrder(email, 2)];

  await syncMembershipForEmail(pool, email);

  const { rows } = await pool.query("SELECT is_member, member_expires_at FROM users WHERE email = $1", [email]);
  assert.equal(rows[0].is_member, true);
  assert.ok(rows[0].member_expires_at);
});

test("an account that becomes verified later is picked up by the next sync", async () => {
  const email = `late-verify-${Date.now()}@example.test`;
  await createUser(email, { verified: false });
  mockedOrders = [authorizedOrder(email, 3)];

  await syncMembershipForEmail(pool, email);
  let { rows } = await pool.query("SELECT is_member FROM users WHERE email = $1", [email]);
  assert.equal(rows[0].is_member, false);

  await pool.query("UPDATE users SET email_verified_at = now() WHERE email = $1", [email]);
  await syncMembershipForEmail(pool, email);

  ({ rows } = await pool.query("SELECT is_member FROM users WHERE email = $1", [email]));
  assert.equal(rows[0].is_member, true);
});
