// Migration 056 (CHECK constraints on prices): applied to a database that
// already holds out-of-range rows, it sets those to NULL (so nothing out of
// range stays purchasable), keeps good rows, adds the constraints, and can be
// run again without error.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { startTestApp } = require("../helpers/testApp");

const PORT = 3850;
const ROOT = path.join(__dirname, "..", "..");
const FILE = "056_price_check_constraints.sql";
const CONSTRAINTS = ["book_copies_price_range_check", "book_copies_acquisition_cost_range_check", "classes_dropin_price_range_check"];

let app;
let pool;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
});
after(async () => {
  await pool.end();
  app.stop();
});

const migrate = () => execFileSync("node", ["src/migrate.js"], {
  cwd: ROOT, env: { ...process.env, DATABASE_URL: app.databaseUrl, PGSSLMODE: "disable" }, encoding: "utf8",
});
const constraintNames = async () => (await pool.query(
  "SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY($1) ORDER BY conname", [CONSTRAINTS]
)).rows;

test("056 cleans existing out-of-range rows, keeps good ones, adds validated constraints, and re-runs cleanly", async () => {
  // Back to the state before 056: no constraints, migration not recorded.
  for (const [table, name] of [["book_copies", CONSTRAINTS[0]], ["book_copies", CONSTRAINTS[1]], ["classes", CONSTRAINTS[2]]]) {
    await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}`);
  }
  await pool.query("DELETE FROM schema_migrations WHERE filename = $1", [FILE]);
  assert.equal((await constraintNames()).length, 0);

  const { rows: b } = await pool.query("INSERT INTO books (title) VALUES ('Migration 056') RETURNING id");
  const copy = async (price, cost) => (await pool.query("INSERT INTO book_copies (book_id, price, acquisition_cost) VALUES ($1, $2, $3) RETURNING id", [b[0].id, price, cost])).rows[0].id;
  const badPrice = await copy("-3.00", "1.00");
  const hugePrice = await copy("200000.00", null);
  const nanPrice = await copy("NaN", "2.00");
  const badCost = await copy("5.00", "-1.00");
  const hugeCost = await copy("5.00", "100000.00");
  const good = await copy("9.99", "0.00");
  const noPrice = await copy(null, null);
  const edge = await copy("99999.99", "99999.99");
  const cls = async (price) => (await pool.query("INSERT INTO classes (title, starts_at, dropin_price) VALUES ('M56', now(), $1) RETURNING id", [price])).rows[0].id;
  const badClass = await cls("-2.00");
  const goodClass = await cls("12.00");

  const out = migrate();
  assert.match(out, /Running migration: 056_price_check_constraints\.sql/);

  const row = async (id) => (await pool.query("SELECT price, acquisition_cost FROM book_copies WHERE id = $1", [id])).rows[0];
  assert.equal((await row(badPrice)).price, null);
  assert.equal(Number((await row(badPrice)).acquisition_cost), 1, "the other column is kept");
  assert.equal((await row(hugePrice)).price, null);
  assert.equal((await row(nanPrice)).price, null);
  assert.equal(Number((await row(nanPrice)).acquisition_cost), 2);
  assert.equal(Number((await row(badCost)).price), 5);
  assert.equal((await row(badCost)).acquisition_cost, null);
  assert.equal((await row(hugeCost)).acquisition_cost, null);
  assert.equal(Number((await row(good)).price), 9.99);
  assert.deepEqual(await row(noPrice), { price: null, acquisition_cost: null });
  assert.equal(Number((await row(edge)).price), 99999.99);
  const { rows: c } = await pool.query("SELECT id, dropin_price FROM classes WHERE id = ANY($1) ORDER BY id", [[badClass, goodClass]]);
  assert.equal(c[0].dropin_price, null);
  assert.equal(Number(c[1].dropin_price), 12);

  assert.deepEqual((await constraintNames()).map((r) => [r.conname, r.convalidated]), CONSTRAINTS.slice().sort().map((n) => [n, true]));
  await assert.rejects(pool.query("INSERT INTO book_copies (book_id, price) VALUES ($1, -1)", [b[0].id]), { code: "23514" });

  // Idempotent: forget it was applied and run it again over the same database.
  await pool.query("DELETE FROM schema_migrations WHERE filename = $1", [FILE]);
  assert.match(migrate(), /Running migration: 056_price_check_constraints\.sql/);
  assert.equal((await constraintNames()).length, 3);
  assert.equal(Number((await row(good)).price), 9.99);
});
