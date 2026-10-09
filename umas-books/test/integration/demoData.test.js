// npm run demo:load / demo:remove (src/lib/demoData.js, scripts/demo-data.js):
// fake people and reservations for the test system. Covers: load makes the
// accounts and the three reservations through the real library functions, a
// second load changes nothing, remove takes exactly that away (and gives real
// copies back), the safety refusals (not staging, production host, many
// real-looking users, no --yes), and that no email is sent or left queued.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { prepareDatabase } = require("../helpers/testDatabase");

const db = prepareDatabase("demo_data", { isolated: true });
const mailer = require("../../src/mailer");
const real = [];
const realSend = async (m) => { real.push(m); };
mailer.sendMail = realSend;

const demo = require("../../src/lib/demoData");
let pool;
let env;

before(() => {
  db.create();
  pool = require("../../src/db").pool;
  env = { APP_ENV: "staging", DATABASE_URL: process.env.DATABASE_URL };
});
after(async () => {
  await pool.end();
  db.drop();
});

const count = async (sql, params) => (await pool.query(sql, params)).rows[0].n;
const snapshot = async () => ({
  users: await count("SELECT count(*)::int AS n FROM users"),
  orders: await count("SELECT count(*)::int AS n FROM orders"),
  books: await count("SELECT count(*)::int AS n FROM books"),
  copies: await count("SELECT count(*)::int AS n FROM book_copies"),
  sales: await count("SELECT count(*)::int AS n FROM till_sales"),
  outbox: await count("SELECT count(*)::int AS n FROM email_outbox"),
});

// Runs main() and captures what it printed.
async function run(argv, overrides = {}) {
  const out = [];
  const err = [];
  const code = await demo.main({ argv, env: { ...env, ...overrides }, pool, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function wipe() {
  await pool.query("DELETE FROM till_sale_items");
  await pool.query("DELETE FROM shop_sales");
  await pool.query("DELETE FROM till_sales");
  await pool.query("DELETE FROM email_outbox");
  await pool.query("DELETE FROM order_items");
  await pool.query("DELETE FROM orders");
  await pool.query("DELETE FROM book_copies");
  await pool.query("DELETE FROM books");
  await pool.query("DELETE FROM users");
}

test("load: accounts, three reservations, fake books, receipt; second load changes nothing", async () => {
  await wipe();
  const first = await run(["load", "--yes"]);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /LOGINS \(shown ONCE/);

  const users = (await pool.query("SELECT * FROM users ORDER BY email")).rows;
  assert.equal(users.length, 5);
  const by = (k) => users.find((u) => u.email === `demo.${k}@example.com`);
  for (const u of users) {
    assert.ok(u.email.endsWith("@example.com"));
    assert.ok(u.email_verified_at, "confirmed, so it can log in");
    assert.equal(u.is_admin, false);
    assert.notEqual(u.password_hash, "x");
  }
  assert.equal(by("account").is_member, false);
  assert.equal(by("account2").is_member, false);
  assert.equal(by("member").is_member, true);
  assert.ok(new Date(by("member").member_expires_at) > new Date());
  assert.equal(by("expired").is_member, true);
  assert.ok(new Date(by("expired").member_expires_at) < new Date());
  assert.equal(by("volunteer").is_volunteer, true);

  // Each printed password really is that account's password, and is printed once.
  for (const u of users) {
    const line = first.out.split("\n").find((l) => l.startsWith(`  ${u.email}   `));
    assert.ok(line, `login line for ${u.email}`);
    const password = line.trim().split(/\s+/)[1];
    assert.ok(password.length >= 16);
    assert.ok(await bcrypt.compare(password, u.password_hash));
    assert.equal(first.out.split(password).length - 1, 1, "each password appears exactly once");
  }

  const orders = (await pool.query("SELECT * FROM orders ORDER BY id")).rows;
  assert.equal(orders.length, 3);
  const open = orders.find((o) => o.buyer_name === "DEMO Open reservation");
  const expiring = orders.find((o) => o.buyer_name === "DEMO Expiring reservation");
  const paid = orders.find((o) => o.buyer_name === "DEMO Collected and paid");
  assert.equal(open.status, "reserved");
  assert.ok(new Date(open.reserved_until) > new Date(Date.now() + 5 * 86400000));
  assert.equal(expiring.status, "reserved");
  const days = (new Date(expiring.reserved_until) - Date.now()) / 86400000;
  assert.ok(days > 1 && days < 3, `expires inside the reminder window (${days} days)`);
  assert.equal(paid.status, "paid");
  assert.ok(paid.collected_at);
  const { rows: sales } = await pool.query("SELECT * FROM till_sales");
  assert.equal(sales.length, 1);
  assert.ok(sales[0].receipt_no, "the till receipt has a number");
  const { rows: sold } = await pool.query("SELECT c.status FROM book_copies c JOIN order_items oi ON oi.book_copy_id = c.id WHERE oi.order_id = $1", [paid.id]);
  assert.deepEqual(sold.map((r) => r.status), ["sold"]);

  // No real books were around, so the fake ones were made: DEMO titles, no ISBN, at most 6 copies.
  const books = (await pool.query("SELECT * FROM books")).rows;
  assert.equal(books.length, 3);
  for (const b of books) { assert.match(b.title, /^DEMO /); assert.equal(b.isbn, null); }
  assert.ok((await count("SELECT count(*)::int AS n FROM book_copies")) <= demo.MAX_DEMO_COPIES);
  assert.equal(await count("SELECT count(*)::int AS n FROM book_copies WHERE notes NOT LIKE 'DEMO (%'"), 0);

  // No email: nothing sent, nothing left queued, the mailer is back as it was.
  assert.equal(real.length, 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM email_outbox"), 0);
  assert.equal(mailer.sendMail, realSend);

  // Again: the same counts, no new passwords.
  const before2 = await snapshot();
  const second = await run(["load", "--yes"]);
  assert.equal(second.code, 0, second.err);
  assert.deepEqual(await snapshot(), before2);
  assert.match(second.out, /No new passwords/);
  assert.doesNotMatch(second.out, /LOGINS/);
  assert.equal(real.length, 0);
});

test("--reset-passwords and --password-from-env", async () => {
  const fixed = "Fixed-Demo-Password-123!";
  const r = await run(["load", "--yes", "--reset-passwords", "--password-from-env"], { DEMO_PASSWORD: fixed });
  assert.equal(r.code, 0, r.err);
  const u = (await pool.query("SELECT password_hash FROM users WHERE email = 'demo.member@example.com'")).rows[0];
  assert.ok(await bcrypt.compare(fixed, u.password_hash));
  const short = await run(["load", "--yes", "--password-from-env"], { DEMO_PASSWORD: "short" });
  assert.equal(short.code, 1);
  assert.match(short.err, /at least 12 characters/);
});

test("remove: takes exactly the demo data away, nothing else", async () => {
  await wipe();
  await pool.query("INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ('boss@umasbooks.test', 'x', 'Boss', true)");
  const { rows: [b] } = await pool.query("INSERT INTO books (isbn, title, authors) VALUES ('9781234567897', 'A Real Book', 'Real Author') RETURNING id");
  await pool.query("INSERT INTO book_copies (book_id, price, status) VALUES ($1, 5, 'in_stock')", [b.id]);
  const base = await snapshot();
  assert.equal((await run(["load", "--yes"])).code, 0);
  assert.ok((await snapshot()).users > base.users);
  const r = await run(["remove", "--yes"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(await snapshot(), base);
  // The admin was never an option.
  assert.equal(await count("SELECT count(*)::int AS n FROM users WHERE is_admin"), 1);
  // And a second remove is fine.
  assert.equal((await run(["remove", "--yes"])).code, 0);
  assert.deepEqual(await snapshot(), base);
});

test("with at least 4 real in-stock copies, the open and expiring reservations use real ones and remove gives them back", async () => {
  await wipe();
  const { rows: [b] } = await pool.query("INSERT INTO books (isbn, title, authors) VALUES ('9781234567897', 'A Real Book', 'Real Author') RETURNING id");
  for (let i = 0; i < 4; i++) await pool.query("INSERT INTO book_copies (book_id, price, status) VALUES ($1, 5, 'in_stock')", [b.id]);
  assert.equal((await run(["load", "--yes"])).code, 0);
  const { rows: held } = await pool.query(
    "SELECT o.buyer_name, c.status, c.notes FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN book_copies c ON c.id = oi.book_copy_id ORDER BY o.id");
  assert.equal(held.length, 3);
  assert.equal(held.filter((h) => h.notes === null && h.status === "reserved").length, 2, "two real copies reserved");
  assert.equal(await count("SELECT count(*)::int AS n FROM books WHERE title LIKE 'DEMO %'"), 1, "one fake book, for the paid one");
  assert.equal(await count("SELECT count(*)::int AS n FROM book_copies WHERE notes LIKE 'DEMO (%'"), 1);
  assert.equal((await run(["remove", "--yes"])).code, 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM book_copies WHERE status = 'in_stock' AND cart_order_id IS NULL AND reserved_by_email IS NULL"), 4);
  assert.equal(await count("SELECT count(*)::int AS n FROM book_copies"), 4);
});

test("refuses outside the test system, and changes nothing", async () => {
  await wipe();
  const before2 = await snapshot();
  for (const argv of [["load", "--yes"], ["remove", "--yes"]]) {
    const r = await run(argv, { APP_ENV: "" });
    assert.equal(r.code, 1);
    assert.match(r.err, /Not the test system/);
    const prod = await run(argv, { APP_ENV: "production" });
    assert.equal(prod.code, 1);
  }
  assert.deepEqual(await snapshot(), before2);
});

test("local flag: needs a localhost DATABASE_URL", async () => {
  const away = await run(["load", "--yes"], { APP_ENV: "", DEMO_ALLOW_LOCAL: "1", DATABASE_URL: "postgres://db.internal.example:5432/x" });
  assert.equal(away.code, 1);
  assert.match(away.err, /localhost/);
  assert.equal(await count("SELECT count(*)::int AS n FROM users"), 0);
  // On localhost it is allowed (the pool is the test database either way).
  const here = await run(["load", "--yes"], { APP_ENV: "", DEMO_ALLOW_LOCAL: "1", DATABASE_URL: "postgres://localhost:5432/whatever" });
  assert.equal(here.code, 0, here.err);
  await run(["remove", "--yes"]);
});

test("refuses when DATABASE_URL is the production database host", async () => {
  const r = await run(["load", "--yes"], { DATABASE_URL: "postgres://u:p@dpg-abc123-a.frankfurt-postgres.render.com/x", PRODUCTION_DATABASE_HOST: "dpg-abc123-a" });
  assert.equal(r.code, 1);
  assert.match(r.err, /PRODUCTION database host/);
  // Also with the local flag (the production check is always on).
  const local = await run(["load", "--yes"], { APP_ENV: "", DEMO_ALLOW_LOCAL: "1", DATABASE_URL: "postgres://localhost/x", PRODUCTION_DATABASE_HOST: "localhost" });
  assert.equal(local.code, 1);
  assert.match(local.err, /PRODUCTION database host/);
  assert.equal(await count("SELECT count(*)::int AS n FROM users"), 0);
});

test("refuses when the users table is large and holds non-demo accounts (looks like real data)", async () => {
  await wipe();
  await pool.query("INSERT INTO users (email, password_hash, display_name) SELECT 'person' || g || '@umasbooks.test', 'x', 'P' FROM generate_series(1, $1) g", [demo.MANY_USERS + 1]);
  for (const argv of [["load", "--yes"], ["remove", "--yes"]]) {
    const r = await run(argv);
    assert.equal(r.code, 1);
    assert.match(r.err, /looks like real data/);
  }
  assert.equal(await count("SELECT count(*)::int AS n FROM users"), demo.MANY_USERS + 1);
  assert.equal(await count("SELECT count(*)::int AS n FROM orders"), 0);
  // Few users (a normal staging site: the admin and some testers) is fine.
  await pool.query("DELETE FROM users WHERE email LIKE 'person%' AND id > (SELECT min(id) + 5 FROM users)");
  assert.equal((await run(["load", "--yes"])).code, 0);
  await run(["remove", "--yes"]);
});

test("without --yes it prints the plan and changes nothing; DEMO_CONFIRM=yes works instead", async () => {
  await wipe();
  const r = await run(["load"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /demo:load will CREATE/);
  assert.match(r.err, /--yes/);
  assert.equal(await count("SELECT count(*)::int AS n FROM users"), 0);
  const viaEnv = await run(["load"], { DEMO_CONFIRM: "yes" });
  assert.equal(viaEnv.code, 0, viaEnv.err);
  assert.equal(await count("SELECT count(*)::int AS n FROM users"), 5);
  await run(["remove", "--yes"]);
  assert.equal((await run(["frobnicate", "--yes"])).code, 2);
});

test("no email rows are ever created, and the mailer is muted even when a transport exists", async () => {
  await wipe();
  const r = await run(["load", "--yes"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Email: none sent \(3 blocked\), 3 queued confirmation rows deleted/);
  assert.equal(await count("SELECT count(*)::int AS n FROM email_outbox"), 0);
  assert.equal(real.length, 0);
  await run(["remove", "--yes"]);
});

test("the real script (npm run demo:load) refuses without APP_ENV=staging and exits non-zero", () => {
  const { spawnSync } = require("node:child_process");
  const env = { ...process.env, APP_ENV: "", DEMO_ALLOW_LOCAL: "", NODE_ENV: "test" };
  const r = spawnSync("node", ["scripts/demo-data.js", "load", "--yes"], { cwd: require("node:path").join(__dirname, "..", ".."), env, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /REFUSED: Not the test system/);
  assert.equal(r.stdout, "");
});
