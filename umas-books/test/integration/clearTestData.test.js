// npm run clear-test-data (src/lib/clearTestData.js) wipes the database, so
// these tests only ever run against a database of their own: isolated:true
// gives a throwaway database (CI shares one database between test files and
// this wipes tables), and the first thing the suite does is refuse to go on
// unless that database's name is the throwaway pattern.
//
// Each test re-plants the same fixture (every table of the schema has at
// least one row, admins with two-step verification included), runs the script
// the way a person would (main() with a command line, or the real script as a
// child process) and looks at the rows.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Client } = require("pg");
const { startTestApp } = require("../helpers/testApp");
const ctd = require("../../src/lib/clearTestData");

const PORT = 3880;
const ROOT = path.join(__dirname, "..", "..");
const PASSWORD_IN_URL = "s3cr3t-pw-never-printed";

let app;
let db;
let dbName;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  dbName = new URL(app.databaseUrl).pathname.slice(1);
  // Hard stop: this suite must NEVER run against anything but its own database.
  assert.match(dbName, /^umasbooks_test_\d+_\d+$/, "refusing to run: not a throwaway test database");
  assert.notEqual(dbName, new URL(process.env.DATABASE_URL || "postgres://x/none").pathname.slice(1), "refusing: this is the shared database");
  db = new Client({ connectionString: app.databaseUrl, ssl: false });
  await db.connect();
  // connect-pg-simple creates this table on the first login; the app has had no
  // login here, so make it exactly as the library would.
  await db.query(`CREATE TABLE IF NOT EXISTS "session" (
    "sid" varchar NOT NULL PRIMARY KEY, "sess" json NOT NULL, "expire" timestamp(6) NOT NULL)`);
});
after(async () => {
  await db.end();
  await app.stop();
});

const q = async (sql, params) => (await db.query(sql, params)).rows;
const count = async (table, where = "TRUE") => (await q(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))[0].n;
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const HASH_BOOK = sha("book cover");
const HASH_NEWS = sha("announcement photo");
const HASH_BLOG = sha("blog photo");

// Every table in the database except the two that a wipe must preserve.
async function emptyEverything() {
  const tables = (await q("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"))
    .map((r) => r.table_name)
    .filter((t) => !["schema_migrations", "pricing_settings"].includes(t));
  await db.query(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
  await db.query("UPDATE pricing_settings SET a_price = 7.77, clearance_price = 2.34 WHERE id = 1");
}

// One row (at least) in every table. Returns the ids tests need.
async function plant() {
  await emptyEverything();
  const one = async (sql, params) => (await q(sql, params))[0].id;
  const admin = await one(
    `INSERT INTO users (email, password_hash, display_name, is_admin, totp_secret_enc, totp_enabled_at)
     VALUES ('admin@example.test', 'admin-hash', 'Admin', true, 'enc-secret', now()) RETURNING id`
  );
  const member = await one(
    "INSERT INTO users (email, password_hash, display_name, is_member, member_expires_at) VALUES ('member@example.test', 'h', 'Member', true, now() + interval '30 days') RETURNING id"
  );
  const plain = await one("INSERT INTO users (email, password_hash, display_name) VALUES ('plain@example.test', 'h', 'Plain') RETURNING id");

  // sessions
  const sess = (sid, data) => db.query("INSERT INTO session (sid, sess, expire) VALUES ($1, $2, now() + interval '1 day')", [sid, JSON.stringify(data)]);
  await sess("sid-admin", { user: { id: admin } });
  await sess("sid-member", { user: { id: member } });
  await sess("sid-guest", { cart: [1] });

  // images
  for (const [id, bytes] of [[HASH_BOOK, "a"], [HASH_NEWS, "b"], [HASH_BLOG, "c"]]) {
    await db.query("INSERT INTO images (id, content_type, data, byte_size) VALUES ($1, 'image/jpeg', $2, 1)", [id, Buffer.from(bytes)]);
  }

  // shop
  const book = await one("INSERT INTO books (title, cover_url) VALUES ('Test Book', $1) RETURNING id", [`/img/${HASH_BOOK}.jpg`]);
  const copy1 = await one("INSERT INTO book_copies (book_id) VALUES ($1) RETURNING id", [book]);
  const copy2 = await one("INSERT INTO book_copies (book_id) VALUES ($1) RETURNING id", [book]);
  const order = await one("INSERT INTO orders (buyer_name, buyer_email, total_amount, status) VALUES ('Buyer', 'buyer@example.test', 9, 'paid') RETURNING id");
  await db.query("INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, 'Test Book', 9)", [order, copy1]);
  await db.query("INSERT INTO guest_order_tokens (order_id, purpose, token_hash, expires_at) VALUES ($1, 'manage', 'guest-tok', now() + interval '1 day')", [order]);
  const cls = await one("INSERT INTO classes (title, starts_at) VALUES ('Class', now() + interval '3 days') RETURNING id");
  const seat = await one("INSERT INTO class_dropin_seats (class_id, order_id) VALUES ($1, $2) RETURNING id", [cls, order]);
  await db.query("INSERT INTO order_items (order_id, class_dropin_seat_id, item_title, price) VALUES ($1, $2, 'Seat', 5)", [order, seat]);
  await db.query("INSERT INTO shop_sales (copy_id, price, sold_by) VALUES ($1, 4, $2)", [copy2, admin]);
  const tillSale = await one("INSERT INTO till_sales (staff_user_id, payment_method, total_cents, sale_token) VALUES ($1, 'cash', 400, 'fixture-sale-token-0001') RETURNING id", [admin]);
  await db.query("INSERT INTO till_sale_items (sale_id, kind, copy_id, description, quantity, unit_price_cents, category) VALUES ($1, 'book', $2, 'Test Book', 1, 400, 'books_used')", [tillSale, copy2]);
  await db.query("INSERT INTO till_quick_items (name, price_cents, category) VALUES ('Tote', 1200, 'merchandise')");
  await db.query("INSERT INTO till_days (day, opening_float_cents, opened_by) VALUES (current_date, 5000, $1)", [admin]);
  await db.query("INSERT INTO till_receipt_counters (year, last_no) VALUES (2026, 7)");
  await db.query("INSERT INTO accounting_map (category, method, debit_account, credit_account) VALUES ('Books used', 'Cash', '530', '707')");
  await db.query("INSERT INTO book_awards (book_id, label, kind, source, status) VALUES ($1, 'Prize', 'award', 'manual', 'verified')", [book]);
  await db.query("INSERT INTO book_requests (title, email, matched_copy_id, user_id) VALUES ('Wanted', 'asker@example.test', $1, $2)", [copy1, member]);
  await db.query("INSERT INTO book_request_list_tokens (email, token_hash, expires_at) VALUES ('asker@example.test', 'tok', now() + interval '1 day')");
  await db.query("INSERT INTO price_lookups (isbn) VALUES ('9780000000002')");
  const { rows: [rr] } = await db.query("INSERT INTO price_reprice_runs (group_key, new_price, copies_changed) VALUES ('trade', 5, 1) RETURNING id");
  await db.query("INSERT INTO price_reprice_items (run_id, copy_id, new_price) VALUES ($1, 1, 5)", [rr.id]);
  // Admin > Genres: the run history goes with the books, the managed list and the rules are settings (kept)
  const managedGenre = await one("INSERT INTO managed_genres (name_en, name_fr, browse_slug) VALUES ('Test genre', 'Genre test', 'test-genre') RETURNING id");
  await db.query("INSERT INTO genre_rules (kind, pattern, pattern_key, action, target_managed_genre_id) VALUES ('exact', 'Test', 'test', 'map', $1)", [managedGenre]);
  const genreRun = await one("INSERT INTO genre_runs (actor_user_id) VALUES ($1) RETURNING id", [admin]);
  await db.query("INSERT INTO genre_run_changes (run_id, book_id, old_categories, new_categories) VALUES ($1, $2, 'a', 'b')", [genreRun, book]);
  await db.query("INSERT INTO favorites (user_id, book_id) VALUES ($1, $2)", [member, book]);
  await db.query("INSERT INTO copy_intake_tokens (token, copy_id, book_id) VALUES ('tok-clear-test-0123456789', $1, $2)", [copy1, book]);
  const collection = await one("INSERT INTO curated_collections (slug, title_en) VALUES ('test-shelf', 'Test shelf') RETURNING id");
  await db.query("INSERT INTO curated_collection_books (collection_id, book_id, status) VALUES ($1, $2, 'approved')", [collection, book]);

  // content
  const event = await one("INSERT INTO events (title, starts_at, created_by) VALUES ('Event', now() + interval '2 days', $1) RETURNING id", [admin]);
  await db.query("INSERT INTO announcements (title, body, event_id, image_url) VALUES ('News', 'Body', $1, $2)", [event, `/img/${HASH_NEWS}.jpg`]);
  await db.query("INSERT INTO blog_posts (title, body, slug, image_url) VALUES ('Post', 'Body', 'post', $1)", [`/img/${HASH_BLOG}.jpg`]);
  const round = await one("INSERT INTO charity_rounds (title) VALUES ('Round') RETURNING id");
  const charity = await one("INSERT INTO charities (name) VALUES ('Charity') RETURNING id");
  const option = await one("INSERT INTO charity_options (round_id, name, charity_id) VALUES ($1, 'Option', $2) RETURNING id", [round, charity]);
  const meeting = await one("INSERT INTO meetings (title, scheduled_at) VALUES ('Meeting', now() + interval '1 day') RETURNING id");
  const shift = await one("INSERT INTO volunteer_shifts (role, starts_at, ends_at) VALUES ('Desk', now() + interval '1 day', now() + interval '1 day 2 hours') RETURNING id");

  // people
  await db.query("INSERT INTO event_signups (event_id, name, email) VALUES ($1, 'Guest', 'guest@example.test')", [event]);
  await db.query("INSERT INTO class_signups (class_id, name, email) VALUES ($1, 'Guest', 'guest@example.test')", [cls]);
  for (const u of [admin, member]) {
    await db.query("INSERT INTO event_rsvps (event_id, user_id) VALUES ($1, $2)", [event, u]);
    await db.query("INSERT INTO meeting_rsvps (meeting_id, user_id) VALUES ($1, $2)", [meeting, u]);
    await db.query("INSERT INTO volunteer_signups (shift_id, user_id) VALUES ($1, $2)", [shift, u]);
  }
  await db.query("INSERT INTO charity_votes (round_id, option_id, user_id) VALUES ($1, $2, $3)", [round, option, member]);
  await db.query("INSERT INTO charity_ideas (name, submitted_by) VALUES ('Idea', $1)", [member]);
  const memberThread = await one("INSERT INTO forum_threads (title, body, author_id) VALUES ('Mine', 'x', $1) RETURNING id", [member]);
  const adminThread = await one("INSERT INTO forum_threads (title, body, author_id) VALUES ('Admin thread', 'x', $1) RETURNING id", [admin]);
  await db.query("INSERT INTO forum_replies (thread_id, body, author_id) VALUES ($1, 'reply by plain', $2)", [adminThread, plain]);
  await db.query("INSERT INTO forum_replies (thread_id, body, author_id) VALUES ($1, 'reply by admin', $2)", [adminThread, admin]);
  await db.query("INSERT INTO forum_replies (thread_id, body, author_id) VALUES ($1, 'reply by admin on member thread', $2)", [memberThread, admin]);
  await db.query("INSERT INTO membership_payments (helloasso_order_id, payer_email, paid_at, user_id) VALUES (1001, 'member@example.test', now(), $1)", [member]);
  await db.query("INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, 'rt', now() + interval '1 day')", [member]);
  await db.query("INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, 'vt', now() + interval '1 day')", [member]);
  await db.query("INSERT INTO email_outbox (to_email, subject, body_text, kind) VALUES ('member@example.test', 'Hello', 'Body', 'verification')");
  await db.query("INSERT INTO totp_recovery_codes (user_id, code_hash) VALUES ($1, 'admin-code-1'), ($1, 'admin-code-2'), ($2, 'member-code')", [admin, member]);

  // kept: operational bookkeeping, never cleared
  await db.query("INSERT INTO job_runs (name, interval_seconds, last_run_at, last_success_at) VALUES ('Email outbox', 60, now(), now())");
  await db.query("INSERT INTO alert_flags (key, last_sent_at) VALUES ('outbox-stuck', now())");
  await db.query("INSERT INTO db_size_snapshots (db_bytes, images_bytes) VALUES (1000, 100)");
  await db.query("INSERT INTO lookup_source_stats (day, source, asked) VALUES (current_date, 'google', 1)");
  await db.query("INSERT INTO ai_usage_stats (day, feature, calls) VALUES (current_date, 'genre', 1)");
  await db.query("INSERT INTO ai_daily_cap (day, scope, calls) VALUES (current_date, 'all', 1)");

  // logs
  await db.query("INSERT INTO admin_audit_log (action, actor_label) VALUES ('test_one', 'a'), ('test_two', 'b'), ('test_three', 'c')");

  return { admin, member, plain, book };
}

// Row counts of every table, for "nothing changed" comparisons.
async function allCounts() {
  const out = {};
  for (const t of Object.keys(ctd.TABLES)) out[t] = await count(t);
  return out;
}

const HOST = "db.example.internal";
const liveOverride = async () => { const a = await liveArgs(); return { acknowledged: true, phrase: a[2] }; };
// The phrase a person would type after reading the host and the counts (see livePhrase in the library).
async function liveArgs() {
  const paid = await count("orders", "status IN ('paid', 'refunded') OR paid_at IS NOT NULL OR collected_at IS NOT NULL");
  const members = await count("users", "NOT is_admin AND (is_member OR is_volunteer OR is_till)");
  return ["--i-know-this-is-the-live-database", "--live-confirm", `DELETE LIVE DATA ON ${HOST} WITH ${paid} PAID ORDERS AND ${members} MEMBERS`];
}

// Runs the command line like a person would; returns { code, out, err }.
// The fixture is deliberately real-looking (paid order, member, membership payment), which the data-derived
// live guard refuses; so unless a test passes { live: false } the live override is appended (the guard itself
// is tested at the end of this file).
async function cli(args, env = {}, { live = true } = {}) {
  const out = [];
  const err = [];
  if (live && !args.includes("--list-admins") && !args.includes("--help")) args = [...args, ...(await liveArgs())];
  const code = await ctd.main(args, {
    env: { DATABASE_URL: `postgres://user:${PASSWORD_IN_URL}@${HOST}:5432/${dbName}`, PREVIEW_MODE: "true", ...env },
    out: (s = "") => out.push(String(s)),
    err: (s = "") => err.push(String(s)),
    connect: async () => {
      const c = new Client({ connectionString: app.databaseUrl, ssl: false });
      await c.connect();
      return c;
    },
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const execArgs = (...more) => ["--execute", "--confirm", `DELETE TEST DATA FROM ${dbName}`, "--i-have-a-backup", ...more];

beforeEach(plant);

// ---------------------------------------------------------------------------

test("every table in the schema is classified (new tables must be classified on purpose)", async () => {
  const actual = (await q("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")).map((r) => r.table_name);
  const unclassified = actual.filter((t) => !ctd.TABLES[t]);
  assert.deepEqual(
    unclassified,
    [],
    `Table(s) ${unclassified.join(", ")} are not classified in src/lib/clearTestData.js (TABLES). ` +
      "Decide: shop, people, logs, content or kept, and make sure buildPlan() deletes it in foreign-key order."
  );
  // And the other way round: a classification for a table that no longer exists is a stale entry.
  const stale = Object.keys(ctd.TABLES).filter((t) => !actual.includes(t));
  assert.deepEqual(stale, [], `TABLES lists table(s) that do not exist: ${stale.join(", ")}`);
  for (const g of Object.values(ctd.TABLES)) assert.ok(ctd.GROUPS.includes(g), `unknown group ${g}`);
});

test("the script refuses to run when the database has an unclassified table", async () => {
  await db.query("CREATE TABLE zz_unknown_new_table (id SERIAL PRIMARY KEY)");
  try {
    const before = await allCounts();
    const r = await cli([]);
    assert.equal(r.code, 1);
    assert.match(r.err, /zz_unknown_new_table/);
    assert.deepEqual(await allCounts(), before);
  } finally {
    await db.query("DROP TABLE zz_unknown_new_table");
  }
});

test("the fixture really has a row in every table (so the tests below prove something)", async () => {
  for (const [t, n] of Object.entries(await allCounts())) assert.ok(n > 0, `fixture has no rows in ${t}`);
});

test("dry run deletes nothing, restarts no counter, and reports the right counts", async () => {
  const before = await allCounts();
  const r = await cli([]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(await allCounts(), before, "a dry run must not change any table");

  // Output: names the database, never the password, says dry run, shows groups.
  assert.match(r.out, new RegExp(`Database name: ${dbName}`));
  assert.match(r.out, /Database host: db\.example\.internal/);
  assert.ok(!r.out.includes(PASSWORD_IN_URL) && !r.err.includes(PASSWORD_IN_URL));
  assert.match(r.out, /DRY RUN \(nothing was changed\)/);
  for (const title of ["Shop data", "People", "Logs", "Content (KEPT", "Always kept"]) assert.ok(r.out.includes(title), title);
  assert.match(r.out, /--confirm "DELETE TEST DATA FROM umasbooks_test_/);

  // Counts: compare with the report of the library itself, and spot-check a few by hand.
  const report = await runDry();
  const del = Object.fromEntries(report.tables.map((t) => [t.table, t.deleted]));
  assert.equal(del.books, 1);
  assert.equal(del.book_copies, 2);
  assert.equal(del.order_items, 2);
  assert.equal(del.orders, 1);
  assert.equal(del.users, 2, "member + plain, never the admin");
  assert.equal(del.event_rsvps, 1, "the member's RSVP, not the admin's");
  assert.equal(del.totp_recovery_codes, 1, "the member's code, not the admin's two");
  assert.equal(del.session, 2, "member and guest sessions, not the admin's");
  assert.equal(del.admin_audit_log, 3);
  assert.equal(del.forum_replies, 2, "plain's reply and the admin reply on the member's thread");
  assert.equal(del.forum_threads, 1);
  assert.equal(del.images, 1, "only the cover nothing refers to any more");
  assert.equal(del.events, 0, "content is kept by default");
  assert.equal(del.pricing_settings, 0);
  assert.ok(report.sequences.map((s) => s.table).includes("books"));
  assert.ok(report.sequences.every((s) => s.restarted === false));
  // The next ids are still where they were (no sequence was restarted).
  assert.ok((await q("INSERT INTO books (title) VALUES ('after dry run') RETURNING id"))[0].id > 1);
});

async function runDry(opts = {}) {
  return ctd.runClearTestData(db, { execute: false, dbHost: HOST, env: {}, ...opts });
}

test("execute is refused without the exact confirmation, without the backup flag, and with a wrong database name", async () => {
  const before = await allCounts();
  for (const args of [
    ["--execute"],
    ["--execute", "--i-have-a-backup"],
    ["--execute", "--confirm", `DELETE TEST DATA FROM ${dbName}`],
    ["--execute", "--confirm", "DELETE TEST DATA FROM another_db", "--i-have-a-backup"],
    ["--execute", "--confirm", `delete test data from ${dbName}`, "--i-have-a-backup"],
    ["--execute", "--confirm", `DELETE TEST DATA FROM ${dbName} `, "--i-have-a-backup"],
    ["--execute", "--confirm"],
  ]) {
    const r = await cli(args);
    assert.notEqual(r.code, 0, args.join(" "));
    assert.match(r.err, /REFUSED|needs a value/, args.join(" "));
    assert.deepEqual(await allCounts(), before, `${args.join(" ")} must not delete anything`);
  }
  // --confirm=... form works as well.
  const ok = await cli(["--execute", `--confirm=DELETE TEST DATA FROM ${dbName}`, "--i-have-a-backup"]);
  assert.equal(ok.code, 0, ok.err);
});

test("a real run wipes shop, people and logs, and keeps admins, 2FA, pricing, content, migrations", async () => {
  const adminRow = await q("SELECT row_to_json(u)::text AS j FROM users u WHERE is_admin");
  const pricing = await q("SELECT row_to_json(p)::text AS j FROM pricing_settings p");
  const migrations = await count("schema_migrations");
  const contentBefore = {};
  for (const [t, g] of Object.entries(ctd.TABLES)) if (g === "content") contentBefore[t] = await count(t);

  const r = await cli(execArgs());
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /REAL RUN \(committed\)/);
  assert.match(r.out, /Nightly database backup/);

  // Shop, guests, logs: empty (logs hold only the one line the script wrote itself).
  for (const [t, g] of Object.entries(ctd.TABLES)) {
    if (g === "shop" && t !== "images") assert.equal(await count(t), 0, t);
  }
  for (const t of ["event_signups", "class_signups", "charity_ideas", "password_reset_tokens", "email_verification_tokens", "membership_payments", "email_outbox", "favorites"]) {
    assert.equal(await count(t), 0, t);
  }
  assert.deepEqual((await q("SELECT id, action FROM admin_audit_log")), [{ id: 1, action: "clear_test_data" }]);

  // People: only the admin is left, with their 2FA, recovery codes, RSVPs, forum post and session.
  assert.deepEqual((await q("SELECT email FROM users")).map((u) => u.email), ["admin@example.test"]);
  assert.deepEqual(await q("SELECT row_to_json(u)::text AS j FROM users u"), adminRow, "admin row untouched, 2FA included");
  assert.equal(await count("totp_recovery_codes", "code_hash LIKE 'admin-code-%'"), 2);
  assert.equal(await count("totp_recovery_codes"), 2);
  assert.deepEqual((await q("SELECT sid FROM session")).map((s) => s.sid), ["sid-admin"]);
  assert.equal(await count("event_rsvps"), 1);
  assert.equal(await count("forum_threads", "title = 'Admin thread'"), 1);
  assert.equal(await count("forum_threads"), 1);
  assert.equal(await count("forum_replies"), 1, "only the admin's reply on the admin's own thread");

  // Kept: pricing, migrations, content (and the pictures content uses).
  assert.deepEqual(await q("SELECT row_to_json(p)::text AS j FROM pricing_settings p"), pricing);
  assert.equal(await count("schema_migrations"), migrations);
  for (const [t, n] of Object.entries(contentBefore)) assert.equal(await count(t), n, `content table ${t}`);
  assert.deepEqual((await q("SELECT id FROM images ORDER BY id")).map((i) => i.id).sort(), [HASH_NEWS, HASH_BLOG].sort());

  // Counters of emptied tables start over; the users counter does not (an admin is still there).
  assert.equal((await q("INSERT INTO books (title) VALUES ('first real book') RETURNING id"))[0].id, 1);
  assert.equal((await q("INSERT INTO orders (buyer_name, buyer_email, total_amount) VALUES ('a', 'a@example.test', 1) RETURNING id"))[0].id, 1);
  assert.ok((await q("INSERT INTO users (email, password_hash, display_name) VALUES ('new@example.test', 'h', 'n') RETURNING id"))[0].id > 1);
});

test("--include-content also clears content (and its dependants), still keeps admin and settings", async () => {
  const r = await cli(execArgs("--include-content"));
  assert.equal(r.code, 0, r.err);
  for (const [t, g] of Object.entries(ctd.TABLES)) {
    if (g === "content" || (g === "shop" && t !== "images")) assert.equal(await count(t), 0, t);
  }
  assert.equal(await count("event_rsvps"), 0, "RSVPs of the deleted events go, the admin's too");
  assert.equal(await count("volunteer_signups"), 0);
  assert.equal(await count("meeting_rsvps"), 0);
  assert.equal(await count("charity_votes"), 0);
  assert.equal(await count("images"), 0, "photos of the deleted content go as well");
  assert.deepEqual((await q("SELECT email FROM users")).map((u) => u.email), ["admin@example.test"]);
  assert.equal(await count("totp_recovery_codes"), 2);
  assert.equal(Number((await q("SELECT a_price FROM pricing_settings"))[0].a_price), 7.77);
  assert.equal((await q("INSERT INTO events (title, starts_at) VALUES ('first real event', now()) RETURNING id"))[0].id, 1);
});

test("--keep-members keeps every account and what it owns, but still wipes the shop and guests", async () => {
  const r = await cli(execArgs("--keep-members"));
  assert.equal(r.code, 0, r.err);
  assert.equal(await count("users"), 3);
  assert.equal(await count("membership_payments"), 1);
  assert.equal(await count("forum_threads"), 2);
  assert.equal(await count("forum_replies"), 3);
  assert.equal(await count("password_reset_tokens"), 1);
  assert.equal(await count("totp_recovery_codes"), 3);
  assert.equal(await count("event_rsvps"), 2);
  assert.deepEqual((await q("SELECT sid FROM session ORDER BY sid")).map((s) => s.sid), ["sid-admin", "sid-member"], "the guest cart session goes");
  for (const [t, g] of Object.entries(ctd.TABLES)) if (g === "shop" && t !== "images") assert.equal(await count(t), 0, t);
  assert.equal(await count("event_signups"), 0);
  assert.equal(await count("events"), 1);
  // users counter is not restarted: rows remain.
  assert.ok((await q("INSERT INTO users (email, password_hash, display_name) VALUES ('n@example.test', 'h', 'n') RETURNING id"))[0].id > 3);
});

test("a failed sanity check rolls everything back (simulated damage after the deletes)", async () => {
  const before = await allCounts();
  const adminRow = await q("SELECT row_to_json(u)::text AS j FROM users u WHERE is_admin");
  const damage = {
    "pricing settings lost": "DELETE FROM pricing_settings",
    "an event lost": "DELETE FROM events",
    "the admin's 2FA lost": "UPDATE users SET totp_enabled_at = NULL WHERE is_admin",
    "an admin recovery code lost": "DELETE FROM totp_recovery_codes WHERE code_hash = 'admin-code-1'",
    "the admin demoted": "UPDATE users SET is_admin = false WHERE is_admin",
    "a migration record lost": "DELETE FROM schema_migrations WHERE filename = (SELECT min(filename) FROM schema_migrations)",
    "the admin's session lost": "DELETE FROM session WHERE sid = 'sid-admin'",
    "a book comes back": "INSERT INTO books (title) VALUES ('sneaky')",
  };
  for (const [label, sql] of Object.entries(damage)) {
    await assert.rejects(
      async () => ctd.runClearTestData(db, { execute: true, dbHost: HOST, env: {}, liveOverride: await liveOverride(), hooks: { afterDeletes: (c) => c.query(sql) } }),
      (e) => e instanceof ctd.SanityError || (label === "the admin demoted" && e instanceof Error),
      label
    );
    assert.deepEqual(await allCounts(), before, `${label}: rolled back`);
    assert.deepEqual(await q("SELECT row_to_json(u)::text AS j FROM users u WHERE is_admin"), adminRow, label);
  }
  // Rolled back means rolled back for the counters too: the next book is NOT id 1.
  assert.ok((await q("INSERT INTO books (title) VALUES ('after rollback') RETURNING id"))[0].id > 1);
  // And the connection is usable again (no transaction left open).
  assert.equal((await q("SELECT 1 AS one"))[0].one, 1);
});

test("the last admin is never deleted, and with no admin at all it refuses to run", async () => {
  // Only the admin and one non-admin.
  await db.query("DELETE FROM users WHERE email = 'member@example.test' OR email = 'plain@example.test'");
  assert.equal(await count("users", "is_admin"), 1);
  const r = await cli(execArgs());
  assert.equal(r.code, 0, r.err);
  assert.equal(await count("users", "is_admin"), 1);

  // Two admins: both kept.
  await db.query("INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ('admin2@example.test', 'h', 'Admin 2', true)");
  assert.equal((await cli(execArgs())).code, 0);
  assert.equal(await count("users", "is_admin"), 2);

  // No admin: refuses, nothing is deleted.
  await db.query("UPDATE users SET is_admin = false");
  const before = await allCounts();
  const none = await cli(execArgs());
  assert.equal(none.code, 1);
  assert.match(none.err, /no admin/i);
  assert.deepEqual(await allCounts(), before);
  await assert.rejects(() => ctd.runClearTestData(db, { execute: true, dbHost: HOST, env: {} }), ctd.RefusedError);
});

test("a real run is refused when PREVIEW_MODE is not on, unless --allow-live is given", async () => {
  const before = await allCounts();
  for (const env of [{ PREVIEW_MODE: "" }, { PREVIEW_MODE: "false" }, { PREVIEW_MODE: "0" }]) {
    const r = await cli(execArgs(), env);
    assert.equal(r.code, 1, JSON.stringify(env));
    assert.match(r.err, /PREVIEW_MODE is not on/);
    assert.deepEqual(await allCounts(), before);
  }
  // The dry run is fine on a live site: it changes nothing.
  assert.equal((await cli([], { PREVIEW_MODE: "" })).code, 0);
  assert.deepEqual(await allCounts(), before);

  const live = await cli(execArgs("--allow-live"), { PREVIEW_MODE: "" });
  assert.equal(live.code, 0, live.err);
  assert.match(live.out, /THIS DELETES REAL ORDERS/);
  assert.equal(await count("books"), 0);

  // PREVIEW_MODE on needs no extra flag (covered by the other tests): 1 and true both count.
  await plant();
  assert.equal((await cli(execArgs(), { PREVIEW_MODE: "1" })).code, 0);
});

test("unknown flags and stray words are refused before anything touches the database", async () => {
  const before = await allCounts();
  for (const args of [["--bogus"], ["--execute", "--confirmm", "x"], ["--delete-everything"], ["execute"], ["--execute=yes"], ["--list-admins", "--execute"]]) {
    const r = await ctd.main(args, {
      env: { DATABASE_URL: app.databaseUrl, PREVIEW_MODE: "true" },
      out: () => {},
      err: () => {},
      connect: async () => {
        throw new Error("must not connect");
      },
    });
    assert.equal(r, 2, args.join(" "));
  }
  assert.deepEqual(await allCounts(), before);
});

test("--list-admins prints the admin e-mail addresses only", async () => {
  await db.query("INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ('admin2@example.test', 'second-hash', 'Admin 2', true)");
  const before = await allCounts();
  const r = await cli(["--list-admins"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /admin@example\.test/);
  assert.match(r.out, /admin2@example\.test/);
  assert.ok(!/member@example|plain@example/.test(r.out), "non-admins are not listed");
  assert.ok(!/hash|enc-secret/.test(r.out), "no hashes or secrets");
  assert.ok(!r.out.includes(PASSWORD_IN_URL));
  assert.deepEqual(await allCounts(), before);
});

test("warnings flag real-looking data in the dry run", async () => {
  const report = await runDry();
  assert.ok(report.warnings.some((w) => /paid reservation/.test(w) && /10 years/.test(w)));
  assert.ok(report.warnings.some((w) => /member or volunteer/.test(w)));
  const kept = await runDry({ keepMembers: true });
  assert.ok(!kept.warnings.some((w) => /member or volunteer/.test(w)));
});

test("the real script (child process) runs the dry run and refuses an unknown flag", async () => {
  const run = (args, extra = {}) =>
    spawnSync("node", ["scripts/clear-test-data.js", ...args], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: app.databaseUrl, PGSSLMODE: "disable", PREVIEW_MODE: "true", ...extra },
      encoding: "utf8",
      timeout: 60000,
    });
  const before = await allCounts();
  // The fixture looks live, so the dry run says so and exits 1 unless the override is given; localhost here.
  const paid = await count("orders", "status IN ('paid', 'refunded') OR paid_at IS NOT NULL OR collected_at IS NOT NULL");
  const members = await count("users", "NOT is_admin AND (is_member OR is_volunteer OR is_till)");
  const refused = run([]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /looks LIVE/);
  const dry = run(["--i-know-this-is-the-live-database", "--live-confirm", `DELETE LIVE DATA ON ${new URL(app.databaseUrl).hostname} WITH ${paid} PAID ORDERS AND ${members} MEMBERS`]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp(`Database name: ${dbName}`));
  const bad = run(["--nope"]);
  assert.equal(bad.status, 2);
  const noUrl = run([], { DATABASE_URL: "" });
  assert.equal(noUrl.status, 1);
  assert.deepEqual(await allCounts(), before);
});

test("parseArgs", () => {
  const { flags, errors } = ctd.parseArgs(["--execute", "--confirm=DELETE TEST DATA FROM x", "--i-have-a-backup", "--keep-members", "--include-content", "--allow-live"]);
  assert.deepEqual(errors, []);
  assert.equal(flags.execute && flags.backup && flags.keepMembers && flags.includeContent && flags.allowLive, true);
  assert.equal(flags.confirm, "DELETE TEST DATA FROM x");
  assert.equal(ctd.parseArgs(["--confirm", "--execute"]).errors.length, 1, "a flag is not a value");
  assert.deepEqual(ctd.describeDatabaseUrl("postgres://u:pw@host.example:5432/mydb?sslmode=require"), { host: "host.example", name: "mydb" });
});

// ---------------------------------------------------------------------------
// Review C (C-M4): the data-derived live-database guard. PREVIEW_MODE is only the operator's word.

test("EXPLOIT: PREVIEW_MODE=true typed on a laptop against a real-looking database is refused, nothing is deleted", async () => {
  const before = await allCounts();
  const r = await cli(execArgs(), { PREVIEW_MODE: "true" }, { live: false });
  assert.equal(r.code, 1);
  assert.match(r.err, /looks LIVE/);
  assert.match(r.err, /paid, refunded or collected order/);
  assert.match(r.err, /membership payment/);
  assert.match(r.err, /member, volunteer or till account/);
  assert.match(r.err, /closed till day|PREVIEW_MODE included/);
  assert.deepEqual(await allCounts(), before, "nothing was deleted");
  // --allow-live and PREVIEW_MODE variants do not help either.
  for (const [extra, env] of [[["--allow-live"], { PREVIEW_MODE: "" }], [[], { PREVIEW_MODE: "1" }], [["--allow-live"], { PREVIEW_MODE: "true" }]]) {
    const x = await cli(execArgs(...extra), env, { live: false });
    assert.equal(x.code, 1, JSON.stringify([extra, env]));
    assert.deepEqual(await allCounts(), before);
  }
});

test("the dry run prints the refusal reasons and exits non-zero; it still shows the counts", async () => {
  const before = await allCounts();
  const r = await cli([], { PREVIEW_MODE: "true" }, { live: false });
  assert.equal(r.code, 1);
  assert.match(r.out, /THIS DATABASE LOOKS LIVE: A REAL RUN WOULD BE REFUSED/);
  assert.match(r.out, /would delete/);
  assert.match(r.err, /1 paid, refunded or collected order/);
  assert.match(r.err, /1 membership payment/);
  assert.match(r.err, /1 member, volunteer or till account/);
  assert.deepEqual(await allCounts(), before);
});

test("each kind of live evidence refuses on its own", async () => {
  const cases = {
    "a closed till day": async () => { await emptyEverything(); await adminOnly(); await db.query("INSERT INTO till_days (day, opening_float_cents, closed_at) VALUES (current_date, 0, now())"); },
    "a paid order": async () => { await emptyEverything(); await adminOnly(); await db.query("INSERT INTO orders (buyer_name, buyer_email, total_amount, status) VALUES ('B', 'b@example.test', 1, 'paid')"); },
    "a refunded order": async () => { await emptyEverything(); await adminOnly(); await db.query("INSERT INTO orders (buyer_name, buyer_email, total_amount, status) VALUES ('B', 'b@example.test', 1, 'refunded')"); },
    "a collected order": async () => { await emptyEverything(); await adminOnly(); await db.query("INSERT INTO orders (buyer_name, buyer_email, total_amount, status, collected_at) VALUES ('B', 'b@example.test', 1, 'reserved', now())"); },
    "a membership payment": async () => { await emptyEverything(); await adminOnly(); await db.query("INSERT INTO membership_payments (helloasso_order_id, payer_email, paid_at) VALUES (5, 'm@example.test', now())"); },
    "a member": async () => { await emptyEverything(); await adminOnly(); await db.query("INSERT INTO users (email, password_hash, display_name, is_member) VALUES ('m@example.test', 'h', 'M', true)"); },
    "a volunteer": async () => { await emptyEverything(); await adminOnly(); await db.query("INSERT INTO users (email, password_hash, display_name, is_volunteer) VALUES ('v@example.test', 'h', 'V', true)"); },
    "a till account": async () => { await emptyEverything(); await adminOnly(); await db.query("INSERT INTO users (email, password_hash, display_name, is_till) VALUES ('t@example.test', 'h', 'T', true)"); },
    "a stocked shop with a sale": async () => {
      await emptyEverything(); const admin = await adminOnly();
      await db.query("INSERT INTO books (title) SELECT 'B' || g FROM generate_series(1, 51) g");
      await db.query("INSERT INTO book_copies (book_id, status) SELECT id, 'in_stock' FROM books");
      await db.query("INSERT INTO shop_sales (copy_id, price, sold_by) SELECT id, 4, $1 FROM book_copies LIMIT 1", [admin]);
    },
  };
  for (const [label, setup] of Object.entries(cases)) {
    await setup();
    const r = await cli(execArgs(), {}, { live: false });
    assert.equal(r.code, 1, label);
    assert.match(r.err, /looks LIVE/, label);
    assert.ok(await count("users") >= 1 && (await count("users", "is_admin")) === 1, `${label}: nothing deleted`);
  }
});

async function adminOnly() {
  return (await q(`INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ('admin@example.test', 'h', 'Admin', true) RETURNING id`))[0].id;
}

test("a genuinely empty/test database is still allowed without any override (dry run and real run)", async () => {
  await emptyEverything();
  await adminOnly();
  await db.query("INSERT INTO users (email, password_hash, display_name) VALUES ('plain@example.test', 'h', 'Plain')");
  await db.query("INSERT INTO books (title) SELECT 'B' || g FROM generate_series(1, 60) g");
  await db.query("INSERT INTO book_copies (book_id, status) SELECT id, 'in_stock' FROM books");
  await db.query("INSERT INTO orders (buyer_name, buyer_email, total_amount, status) VALUES ('B', 'b@example.test', 1, 'reserved'), ('C', 'c@example.test', 1, 'cancelled')");
  await db.query("INSERT INTO till_days (day, opening_float_cents) VALUES (current_date, 0)"); // opened, never closed
  assert.equal((await cli([], {}, { live: false })).code, 0);
  const real = await cli(execArgs(), {}, { live: false });
  assert.equal(real.code, 0, real.err);
  assert.equal(await count("books"), 0);
});

test("more than 50 stocked books alone (no sale) is a test database; 50 books with a sale is too", async () => {
  await emptyEverything();
  const admin = await adminOnly();
  await db.query("INSERT INTO books (title) SELECT 'B' || g FROM generate_series(1, 50) g");
  await db.query("INSERT INTO book_copies (book_id, status) SELECT id, 'in_stock' FROM books");
  await db.query("INSERT INTO shop_sales (copy_id, price, sold_by) SELECT id, 4, $1 FROM book_copies LIMIT 1", [admin]);
  assert.equal((await cli([], {}, { live: false })).code, 0, "exactly 50 is within the limit");
});

test("the override needs the flag AND a phrase naming the host and the counts; a wrong or pasted phrase is refused", async () => {
  const before = await allCounts();
  const right = (await liveArgs())[2];
  const bad = [
    [["--i-know-this-is-the-live-database"]],
    [["--live-confirm", right]],
    [["--i-know-this-is-the-live-database", "--live-confirm", right.replace(HOST, "other.example")]],
    [["--i-know-this-is-the-live-database", "--live-confirm", right.replace("WITH 1 PAID", "WITH 0 PAID")]],
    [["--i-know-this-is-the-live-database", "--live-confirm", right.replace("AND 1 MEMBERS", "AND 7 MEMBERS")]],
    [["--i-know-this-is-the-live-database", "--live-confirm", "DELETE LIVE DATA ON <host> WITH <paid orders> PAID ORDERS AND <members> MEMBERS"]],
    [["--i-know-this-is-the-live-database", "--live-confirm", right.toLowerCase()]],
    [["--i-know-this-is-the-live-database", "--live-confirm", `DELETE TEST DATA FROM ${dbName}`]],
  ];
  for (const [extra] of bad) {
    const r = await cli(execArgs(...extra), {}, { live: false });
    assert.equal(r.code, 1, extra.join(" "));
    assert.deepEqual(await allCounts(), before, `${extra.join(" ")} deleted nothing`);
  }
  assert.ok(!(await cli(execArgs("--i-know-this-is-the-live-database", "--live-confirm", "x"), {}, { live: false })).err.includes(right), "the refusal never prints the right phrase");
  const ok = await cli(execArgs(...(await liveArgs())), {}, { live: false });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /LIVE-DATABASE OVERRIDE WAS GIVEN/);
  assert.equal(await count("books"), 0);
});

test("a database on PRODUCTION_DATABASE_HOST is refused even when it looks empty, unless the override is given", async () => {
  await emptyEverything();
  await adminOnly();
  const env = { PRODUCTION_DATABASE_HOST: "db.example.internal" };
  const r = await cli(execArgs(), env, { live: false });
  assert.equal(r.code, 1);
  assert.match(r.err, /PRODUCTION database host/);
  const render = await cli(execArgs(), { PRODUCTION_DATABASE_HOST: "db" }, { live: false });
  assert.equal(render.code, 1, "Render's short host name matches the long one (first label)");
  const phrase = `DELETE LIVE DATA ON ${HOST} WITH 0 PAID ORDERS AND 0 MEMBERS`;
  const ok = await cli(execArgs("--i-know-this-is-the-live-database", "--live-confirm", phrase), env, { live: false });
  assert.equal(ok.code, 0, ok.err);
});

test("parseArgs knows the live override flags", () => {
  const { flags, errors } = ctd.parseArgs(["--i-know-this-is-the-live-database", "--live-confirm", "X Y"]);
  assert.deepEqual(errors, []);
  assert.equal(flags.iKnowThisIsTheLiveDatabase, true);
  assert.equal(flags.liveConfirm, "X Y");
  assert.equal(flags.confirm, null, "--live-confirm is not --confirm");
});
