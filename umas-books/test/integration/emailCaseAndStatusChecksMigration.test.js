// Migration 094 (Review C, L2 + L3): a UNIQUE index on lower(users.email) and CHECK constraints on four
// status / method columns. It must be safe on production: with data that does not fit, it skips the step
// with a NOTICE instead of failing the deploy; with good data it adds everything; it can run twice.
// The seed stores the admin address lower-cased.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { startTestApp } = require("../helpers/testApp");

const PORT = 3867;
const ROOT = path.join(__dirname, "..", "..");
const FILE = "094_email_case_and_status_checks.sql";
const CHECKS = [
  ["orders", "orders_status_check"], ["orders", "orders_payment_method_check"],
  ["book_copies", "book_copies_status_check"], ["class_dropin_seats", "class_dropin_seats_status_check"],
];
const INDEX = "idx_users_email_lower_unique";

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
async function undo() {
  for (const [t, n] of CHECKS) await pool.query(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${n}`);
  await pool.query(`DROP INDEX IF EXISTS ${INDEX}`);
  await pool.query("DELETE FROM schema_migrations WHERE filename = $1", [FILE]);
}
const constraints = async () => (await pool.query("SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY($1) ORDER BY conname", [CHECKS.map((c) => c[1])])).rows;
const hasIndex = async () => (await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = $1", [INDEX])).rowCount === 1;
const clean = async () => {
  await pool.query("DELETE FROM order_items");
  await pool.query("DELETE FROM class_dropin_seats");
  await pool.query("DELETE FROM orders");
  await pool.query("DELETE FROM book_copies");
  await pool.query("DELETE FROM users WHERE email LIKE '%@m94.test'");
};

test("on a database with good data: the index and all four validated constraints are added, and the rules hold", async () => {
  await undo();
  await clean();
  await pool.query("INSERT INTO users (email, password_hash, display_name) VALUES ('one@m94.test', 'h', 'One')");
  const out = migrate();
  assert.match(out, /Running migration: 094_email_case_and_status_checks\.sql/);
  assert.equal(await hasIndex(), true);
  assert.deepEqual((await constraints()).map((r) => [r.conname, r.convalidated]), CHECKS.map((c) => c[1]).sort().map((n) => [n, true]));
  // The rules.
  await assert.rejects(pool.query("INSERT INTO users (email, password_hash, display_name) VALUES ('ONE@m94.test', 'h', 'Dup')"), { code: "23505" });
  await assert.rejects(pool.query("INSERT INTO orders (buyer_name, buyer_email, total_amount, status) VALUES ('B', 'b@m94.test', 1, 'bogus')"), { code: "23514" });
  await assert.rejects(pool.query("INSERT INTO orders (buyer_name, buyer_email, total_amount, status, payment_method) VALUES ('B', 'b@m94.test', 1, 'paid', 'bitcoin')"), { code: "23514" });
  const { rows: [book] } = await pool.query("INSERT INTO books (title) VALUES ('M94') RETURNING id");
  await assert.rejects(pool.query("INSERT INTO book_copies (book_id, status) VALUES ($1, 'lost')", [book.id]), { code: "23514" });
  await assert.rejects(pool.query("INSERT INTO class_dropin_seats (class_id, status) VALUES ((SELECT id FROM classes LIMIT 1), 'x')"), (e) => e.code === "23514" || e.code === "23502");
  // Every status the code uses is accepted, and NULL payment_method.
  for (const s of ["pending", "reserved", "paid", "cancelled", "expired", "refunded"]) {
    await pool.query("INSERT INTO orders (buyer_name, buyer_email, total_amount, status) VALUES ('B', 'b@m94.test', 1, $1)", [s]);
  }
  for (const m of ["cash", "card", "cheque", "other", "helloasso", "online"]) {
    await pool.query("INSERT INTO orders (buyer_name, buyer_email, total_amount, status, payment_method) VALUES ('B', 'b@m94.test', 1, 'paid', $1)", [m]);
  }
  for (const s of ["in_stock", "reserved", "sold", "donated", "damaged", "in_cart"]) {
    await pool.query("INSERT INTO book_copies (book_id, status) VALUES ($1, $2)", [book.id, s]);
  }
  await clean();
});

test("with data that does not fit, the migration neither fails nor adds the step that would not hold", async () => {
  await undo();
  await clean();
  const { rows: [book] } = await pool.query("INSERT INTO books (title) VALUES ('M94b') RETURNING id");
  await pool.query("INSERT INTO users (email, password_hash, display_name) VALUES ('Dup@m94.test', 'h', 'A'), ('dup@m94.test', 'h', 'B')");
  await pool.query("INSERT INTO orders (buyer_name, buyer_email, total_amount, status) VALUES ('B', 'b@m94.test', 1, 'weird_old_status')");
  await pool.query("INSERT INTO book_copies (book_id, status) VALUES ($1, 'in_stock')", [book.id]);
  const out = migrate(); // would throw on a failed migration
  assert.match(out, /Running migration: 094_/);
  assert.equal(await hasIndex(), false, "duplicates once lower-cased: no index");
  const names = (await constraints()).map((r) => r.conname);
  assert.ok(!names.includes("orders_status_check"), "an order holds an unknown status: skipped");
  assert.ok(names.includes("orders_payment_method_check"));
  assert.ok(names.includes("book_copies_status_check"));
  assert.ok(names.includes("class_dropin_seats_status_check"));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM schema_migrations WHERE filename = $1", [FILE])).rows[0].n, 1, "recorded as applied");
  await clean();
});

test("running it twice is harmless", async () => {
  await undo();
  await clean();
  migrate();
  await pool.query("DELETE FROM schema_migrations WHERE filename = $1", [FILE]);
  assert.match(migrate(), /Running migration: 094_/);
  assert.equal((await constraints()).length, 4);
  assert.equal(await hasIndex(), true);
});

test("the seed stores a mixed-case SEED_ADMIN_EMAIL lower-cased, so the admin can log in", async () => {
  await pool.query("DELETE FROM users WHERE is_admin");
  const { runSeed } = require("../../src/seed");
  const lines = [];
  await runSeed({
    env: { ...process.env, SEED_ADMIN_EMAIL: " Boss.Admin@Example.TEST ", SEED_ADMIN_PASSWORD: "Correct-Horse-Battery-9!" },
    pool, log: { log: (...a) => lines.push(a.join(" ")), warn: (...a) => lines.push(a.join(" ")) },
  });
  const { rows } = await pool.query("SELECT email FROM users WHERE is_admin");
  assert.deepEqual(rows.map((r) => r.email), ["boss.admin@example.test"]);
  await pool.query("DELETE FROM users WHERE is_admin");
});
