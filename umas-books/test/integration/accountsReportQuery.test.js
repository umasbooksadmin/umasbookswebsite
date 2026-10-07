// The Accounts report's per-account order totals (lib/reports.js accountsReport).
// The query used a per-user EXISTS over all orders (10 s for 5,000 accounts, near the
// 30 s statement timeout at about 10,000). It now joins on orders.user_id and uses the
// buyer email only for old orders with no user_id. This file proves
//   1. the result equals the old per-email query on a fixture covering every case, and
//   2. 10,000 accounts / 10,000 orders answer in a couple of seconds at most (measured:
//      about 100 ms; the old query took minutes at this size).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase } = require("../helpers/inProcessApp");

const db = prepareDatabase("acctreport", { isolated: true });
const { pool } = require("../../src/db");
const { getReport, PAID_ORDERS_BY_ACCOUNT_SQL } = require("../../src/lib/reports");
const accountsReport = (db, ctx) => getReport("accounts").run(db, ctx);

before(() => db.create());
after(async () => { await pool.end(); db.drop(); });

// The previous definition, kept here as the reference.
const OLD_LIST = `SELECT u.email, COALESCE(ord.n, 0)::int AS orders, COALESCE(ord.spent, 0)::float8 AS spent
  FROM users u LEFT JOIN (SELECT lower(buyer_email) AS email, COUNT(*) AS n, SUM(total_amount) AS spent
                          FROM orders WHERE status = 'paid' GROUP BY 1) ord ON ord.email = lower(u.email) ORDER BY u.email`;
const OLD_BUYERS = `SELECT COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM orders o WHERE o.status = 'paid' AND lower(o.buyer_email) = lower(u.email)))::int AS n FROM users u`;
const NEW_LIST = `SELECT u.email, COALESCE(ord.n, 0)::int AS orders, COALESCE(ord.spent, 0)::float8 AS spent
  FROM users u LEFT JOIN (${PAID_ORDERS_BY_ACCOUNT_SQL}) ord ON ord.uid = u.id ORDER BY u.email`;

test("same per-account counts and totals as the old per-email query", async () => {
  const mk = async (email) => (await pool.query("INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', $1) RETURNING id", [email])).rows[0].id;
  const a = await mk("Alice@Example.test"); // mixed case in the account
  const b = await mk("bob@example.test");
  await mk("nobody@example.test"); // never bought
  const d = await mk("dora@example.test"); // only a refunded and a pending order
  const order = (email, userId, status, total) =>
    pool.query("INSERT INTO orders (buyer_name, buyer_email, user_id, status, total_amount, paid_at) VALUES ('n', $1, $2, $3, $4, now())", [email, userId, status, total]);
  await order("alice@example.test", a, "paid", 10); // linked, lower-case email
  await order("ALICE@example.test", null, "paid", 5.5); // legacy order (no user_id), other case
  await order("bob@example.test", b, "paid", 7);
  await order("bob@example.test", null, "paid", 3);
  await order("dora@example.test", d, "refunded", 9);
  await order("dora@example.test", d, "pending", 9);
  await order("stranger@example.test", null, "paid", 40); // no account
  const { rows: oldRows } = await pool.query(OLD_LIST);
  const { rows: newRows } = await pool.query(NEW_LIST);
  assert.deepEqual(newRows, oldRows);
  assert.deepEqual(newRows.find((r) => r.email === "Alice@Example.test"), { email: "Alice@Example.test", orders: 2, spent: 15.5 });
  const oldBuyers = (await pool.query(OLD_BUYERS)).rows[0].n;
  const rep = await accountsReport(pool, { query: {}, csv: false });
  const buyersRow = rep.sections[0].rows.find((r) => r.label === "With at least one paid order");
  assert.equal(buyersRow.count, oldBuyers);
  assert.equal(oldBuyers, 2);
  // and the listed numbers on the page
  const list = rep.sections.find((s) => s.key === "accounts") || rep.sections[1];
  const alice = list.rows.find((r) => r.email === "Alice@Example.test");
  assert.deepEqual([alice.orders, alice.spent], [2, 15.5]);
});

test("10,000 accounts and 10,000 orders: the report answers well inside the 30 s statement timeout", async () => {
  await pool.query(`INSERT INTO users (email, password_hash, display_name)
                    SELECT 'perf' || g || '@example.test', 'x', 'Perf ' || g FROM generate_series(1, 10000) g`);
  await pool.query(`INSERT INTO orders (buyer_name, buyer_email, user_id, status, total_amount, paid_at)
                    SELECT 'n', 'perf' || g || '@example.test', CASE WHEN g % 2 = 0 THEN u.id END, 'paid', 12.5, now()
                      FROM generate_series(1, 10000) g JOIN users u ON u.email = 'perf' || g || '@example.test'`);
  await pool.query("ANALYZE users");
  await pool.query("ANALYZE orders");
  const t0 = Date.now();
  const rep = await accountsReport(pool, { query: {}, csv: false });
  const ms = Date.now() - t0;
  console.log(`accountsReport at 10,000 accounts / 10,000 orders: ${ms} ms`);
  assert.ok(ms < 3000, `took ${ms} ms`);
  const buyers = rep.sections[0].rows.find((r) => r.label === "With at least one paid order").count;
  assert.ok(buyers >= 10000);
});
