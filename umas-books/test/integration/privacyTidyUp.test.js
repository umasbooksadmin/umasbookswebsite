// Privacy tidy-up: order phone cleanup, anonymising unpaid orders, a complete
// member export, a complete erase, the mailbox reminder, the repriced-run
// label purge, and the durable check that no table holding a person's data is
// forgotten (see "COVERAGE").
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { prepareDatabase } = require("../helpers/testDatabase");

const db = prepareDatabase("privacy_tidy", { isolated: true });
let pool, privacy, maint, exporter;
// errorAlert.js takes sendMail from the mailer when it is first loaded, so the
// stand-in must be in place before anything requires it.
const mailer = require("../../src/mailer");
const realSendMail = mailer.sendMail;
let sendImpl = async () => {};
mailer.sendMail = (m) => sendImpl(m);

before(() => {
  db.create();
  ({ pool } = require("../../src/db"));
  privacy = require("../../src/lib/privacy");
  maint = require("../../src/lib/privacyMaintenance");
  exporter = require("../../src/lib/memberExport");
});
after(async () => {
  mailer.sendMail = realSendMail;
  await pool.end();
  db.drop();
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
async function user({ admin = false } = {}) {
  const email = `tidy-${uniq()}@example.test`;
  const { rows } = await pool.query(
    "INSERT INTO users (email, password_hash, display_name, is_admin, email_verified_at) VALUES ($1, 'x', 'Tidy Person', $2, now()) RETURNING id",
    [email, admin]
  );
  return { id: rows[0].id, email };
}
async function order(u, { status = "reserved", ageDays = 0, collected = false, phone = "0612345678" } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, buyer_phone, total_amount, status, user_id, created_at, collected_at, paid_at)
     VALUES ('Tidy Person', $1, $2, 10, $3, $4, now() - make_interval(days => $5::int),
             CASE WHEN $6::boolean THEN now() END, CASE WHEN $3 = 'paid' THEN now() END) RETURNING id`,
    [u.email, phone, status, u.id, ageDays, collected]
  );
  return rows[0].id;
}
const phoneOf = async (id) => (await pool.query("SELECT buyer_phone FROM orders WHERE id = $1", [id])).rows[0].buyer_phone;

test("order phone cleanup: clears closed, collected-and-paid and 30-day-old orders; keeps live reservations; idempotent", async () => {
  const u = await user();
  const live = await order(u, { status: "reserved", ageDays: 3 });
  const paidWaiting = await order(u, { status: "paid", ageDays: 3, collected: false });
  const paidCollected = await order(u, { status: "paid", ageDays: 3, collected: true });
  const cancelled = await order(u, { status: "cancelled", ageDays: 1 });
  const expired = await order(u, { status: "expired", ageDays: 1 });
  const old = await order(u, { status: "reserved", ageDays: 31 });
  const first = await maint.cleanOrderPhones(pool);
  assert.ok(first.orders >= 4);
  assert.equal(await phoneOf(live), "0612345678");
  assert.equal(await phoneOf(paidWaiting), "0612345678", "uncollected paid order still needs the number");
  for (const id of [paidCollected, cancelled, expired, old]) assert.equal(await phoneOf(id), null);
  assert.deepEqual(await maint.cleanOrderPhones(pool), { orders: 0, copies: 0 }, "second run changes nothing");
  // name and email stay on a paid order (10-year accounting retention)
  const { rows } = await pool.query("SELECT buyer_name, buyer_email FROM orders WHERE id = $1", [paidCollected]);
  assert.deepEqual([rows[0].buyer_name, rows[0].buyer_email], ["Tidy Person", u.email]);
});

test("order phone cleanup: batch-limited, and clears the phone on a held book copy only when the hold ended or is 30 days old", async () => {
  const u = await user();
  for (let i = 0; i < 3; i++) await order(u, { status: "cancelled" });
  const r = await maint.cleanOrderPhones(pool, { batch: 2 });
  assert.equal(r.orders, 2);
  await maint.cleanOrderPhones(pool);

  const { rows: b } = await pool.query("INSERT INTO books (title, isbn) VALUES ('Tidy', $1) RETURNING id", [`9${Date.now()}`.slice(0, 13)]);
  const mk = async (status, ageDays) =>
    (await pool.query(
      `INSERT INTO book_copies (book_id, status, reserved_by_phone, reserved_by_email, reserved_at)
       VALUES ($1, $2, '0699999999', $3, now() - make_interval(days => $4::int)) RETURNING id`,
      [b[0].id, status, u.email, ageDays]
    )).rows[0].id;
  const held = await mk("reserved", 2), ended = await mk("in_stock", 2), stale = await mk("reserved", 40);
  await maint.cleanOrderPhones(pool);
  const phone = async (id) => (await pool.query("SELECT reserved_by_phone AS p FROM book_copies WHERE id = $1", [id])).rows[0].p;
  assert.equal(await phone(held), "0699999999");
  assert.equal(await phone(ended), null);
  assert.equal(await phone(stale), null);
});

test("unpaid/cancelled/expired orders lose name, email and phone after 30 days (the promised period); paid ones keep name and email", async () => {
  const u = await user();
  const oldCancelled = await order(u, { status: "cancelled", ageDays: 31 });
  const recentCancelled = await order(u, { status: "cancelled", ageDays: 5 });
  const oldPaid = await order(u, { status: "paid", ageDays: 400, collected: true });
  await privacy.purgeExpiredPersonalData(pool);
  const get = async (id) => (await pool.query("SELECT buyer_name, buyer_email, buyer_phone FROM orders WHERE id = $1", [id])).rows[0];
  const a = await get(oldCancelled);
  assert.deepEqual([a.buyer_name, a.buyer_phone, a.buyer_email.endsWith("@erased.invalid")], ["Erased", null, true]);
  assert.equal((await get(recentCancelled)).buyer_name, "Tidy Person");
  assert.deepEqual([(await get(oldPaid)).buyer_name, (await get(oldPaid)).buyer_email], ["Tidy Person", u.email]);
});

test("purge: reprice run labels older than 12 months are cleared", async () => {
  await pool.query(
    `INSERT INTO price_reprice_runs (group_key, new_price, copies_changed, actor_label, created_at) VALUES
     ('trade', 5, 1, 'a@example.test', now() - interval '13 months'), ('trade', 5, 1, 'b@example.test', now() - interval '1 month')`
  );
  await privacy.purgeExpiredPersonalData(pool);
  const { rows } = await pool.query("SELECT actor_label FROM price_reprice_runs WHERE group_key = 'trade' ORDER BY created_at");
  assert.deepEqual(rows.map((r) => r.actor_label), [null, "b@example.test"]);
});

test("member export: outbox copies, admin-log entries about the person, RSVPs, 2FA flag (no secret), session count", async () => {
  const u = await user();
  const other = await user();
  await pool.query("UPDATE users SET totp_enabled_at = now(), totp_secret_enc = 'SECRETVALUE' WHERE id = $1", [u.id]);
  await pool.query(
    "INSERT INTO email_outbox (to_email, subject, body_text, kind, status, sent_at) VALUES ($1, 'Hello subject', 'BODYTEXT', 'welcome', 'sent', now())",
    [u.email]
  );
  const oid = await order(u);
  await pool.query(
    `INSERT INTO admin_audit_log (actor_user_id, actor_label, action, target_type, target_id, detail) VALUES
     (NULL, 'admin@example.test', 'member.update', 'user', $1, 'about you'),
     (NULL, 'admin@example.test', 'member.update', 'user', $2, 'about someone else'),
     (NULL, 'admin@example.test', 'order.collect', 'order', $3, 'your order')`,
    [u.id, other.id, oid]
  );
  const { rows: ev } = await pool.query("INSERT INTO events (title, starts_at) VALUES ('E', now() + interval '1 day') RETURNING id");
  await pool.query("INSERT INTO event_rsvps (event_id, user_id) VALUES ($1, $2)", [ev[0].id, u.id]);
  await pool.query("CREATE TABLE IF NOT EXISTS session (sid varchar PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL)");
  await pool.query("INSERT INTO session VALUES ($1, $2, now() + interval '1 day')", [`s-${uniq()}`, JSON.stringify({ user: { id: u.id } })]);

  const out = await exporter.buildMemberExport(pool, u.id);
  assert.equal(out.two_factor_enabled, true);
  assert.equal(out.active_sessions, 1);
  assert.deepEqual(out.admin_log_entries_about_you.map((e) => e.detail), ["about you", "your order"]);
  assert.equal(out.event_rsvps.length, 1);
  assert.equal(out.emails_sent.length, 1);
  assert.equal(out.emails_sent[0].subject, "Hello subject");
  const json = JSON.stringify(out);
  assert.ok(!json.includes("SECRETVALUE") && !json.includes("BODYTEXT"), "no secrets, no email bodies");
  assert.ok(!json.includes("admin@example.test"), "an administrator's email is not in someone else's export");
  assert.ok(!json.includes("about someone else"));
});

test("erase: an erased administrator's labels are removed from the admin log and reprice history, and the session rows go", async () => {
  const a = await user({ admin: true });
  await pool.query("INSERT INTO admin_audit_log (actor_user_id, actor_label, action) VALUES ($1, $2, 'x.y')", [a.id, a.email]);
  await pool.query("INSERT INTO price_reprice_runs (group_key, new_price, copies_changed, actor_user_id, actor_label) VALUES ('mass_market', 5, 1, $1, $2)", [a.id, a.email]);
  await pool.query("INSERT INTO session VALUES ($1, $2, now() + interval '1 day')", [`s-${uniq()}`, JSON.stringify({ user: { id: a.id } })]);
  assert.equal(await privacy.eraseMember(pool, a.id), true);
  const log = await pool.query("SELECT actor_label FROM admin_audit_log WHERE action = 'x.y'");
  assert.equal(log.rows[0].actor_label, null);
  const run = await pool.query("SELECT actor_user_id, actor_label FROM price_reprice_runs WHERE group_key = 'mass_market'");
  assert.deepEqual([run.rows[0].actor_user_id, run.rows[0].actor_label], [null, null]);
  const dump = (await pool.query("SELECT sess::text AS s FROM session")).rows.map((r) => r.s).join();
  assert.ok(!dump.includes(`"id":${a.id}`));
});

test("mailbox reminder: one email per 30 days to ALERT_TO, no personal data; a failed send frees the slot", async () => {
  const sent = [];
  sendImpl = async (m) => { sent.push(m); };
  try {
    await pool.query("DELETE FROM alert_flags WHERE key = $1", [maint.MAILBOX_REMINDER_KEY]);
    assert.equal(await maint.sendMailboxCleanupReminder(pool), true);
    assert.equal(await maint.sendMailboxCleanupReminder(pool), false, "not again within 30 days");
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /older_than:1y/);
    assert.match(sent[0].subject, /12 months/);
    await pool.query("UPDATE alert_flags SET last_sent_at = now() - interval '31 days' WHERE key = $1", [maint.MAILBOX_REMINDER_KEY]);
    assert.equal(await maint.sendMailboxCleanupReminder(pool), true, "due again after 30 days");
    sendImpl = async () => { throw new Error("smtp down"); };
    await pool.query("UPDATE alert_flags SET last_sent_at = now() - interval '31 days' WHERE key = $1", [maint.MAILBOX_REMINDER_KEY]);
    const { setAlertRetryDelay } = require("../../src/lib/errorAlert");
    setAlertRetryDelay(0);
    assert.equal(await maint.sendMailboxCleanupReminder(pool), false);
    const { rows } = await pool.query("SELECT 1 FROM alert_flags WHERE key = $1", [maint.MAILBOX_REMINDER_KEY]);
    assert.equal(rows.length, 0, "slot released so the next tick retries");
  } finally {
    sendImpl = async () => {};
  }
});

// ---------------------------------------------------------------------------
// COVERAGE: the durable check. Every column in the public schema that can hold
// a person's data (matched by name below) must be listed here, either as
// handled ("erase" = how a right-to-erasure request removes it, "export" = which
// export section shows it) or allow-listed with a reason. A new table or column
// with such a name FAILS this test until someone decides. Erasure and export
// live in lib/privacy.js and lib/memberExport.js (grep'd below).
const PERSONAL_COLUMN = /(^|_)(user_id|email|phone|contact|author_id|submitted_by|created_by|decided_by|hidden_by|collected_by|sold_by|opened_by|closed_by|reopened_by|voided_by|confirmed_by|staff_user_id|actor_user_id|actor_label|client_ip|ip|name)$/;
const CASCADE = (exportSection) => ({ erase: "cascade", export: exportSection });
const SQL = (exportSection) => ({ erase: "sql", export: exportSection });
const STAFF = { erase: "setnull", allow: "administrator/staff account that did the action (an internal record, not the customer's data); SET NULL when that account is erased" };
const NOT_PERSON = (why) => ({ allow: why });

const COVERAGE = {
  "users.email": { erase: "delete", export: "user" },
  "users.display_name": { erase: "delete", export: "user" },
  "admin_audit_log.actor_user_id": { erase: "sql", allow: "administrator's own action; their label is cleared on erase" },
  "admin_audit_log.actor_label": { erase: "sql", allow: "administrator's email label; cleared on erase, row purged after 12 months" },
  "admin_audit_log.ip": { allow: "administrator's IP on their own actions; purged with the row after 12 months", erase: "none" },
  "announcements.created_by": STAFF, "blog_posts.created_by": STAFF, "book_awards.decided_by": STAFF,
  "book_copies.created_by": STAFF, "books.created_by": STAFF, "charities.created_by": STAFF, "classes.created_by": STAFF,
  "events.created_by": STAFF, "meetings.created_by": STAFF, "volunteer_shifts.created_by": STAFF,
  "orders.collected_by": STAFF, "shop_sales.sold_by": STAFF, "till_days.closed_by": STAFF, "till_days.opened_by": STAFF,
  "till_days.reopened_by": STAFF, "till_sales.refund_confirmed_by": STAFF, "till_sales.staff_user_id": STAFF,
  "till_sales.voided_by": STAFF, "forum_replies.hidden_by": STAFF, "forum_threads.hidden_by": STAFF,
  "book_copies.reserved_by_email": SQL("book_reservations"), "book_copies.reserved_by_name": SQL("book_reservations"),
  "book_copies.reserved_by_phone": SQL("book_reservations"),
  "book_request_list_tokens.email": SQL("book_requests"),
  "book_requests.email": SQL("book_requests"), "book_requests.name": SQL("book_requests"), "book_requests.user_id": SQL("book_requests"),
  "charity_ideas.name": NOT_PERSON("the name of the proposed charity, not of a person"),
  "charity_ideas.submitted_by": { erase: "setnull", export: "charity_ideas" },
  "charity_options.name": NOT_PERSON("name of a charity option"),
  "charities.name": NOT_PERSON("name of a charity"),
  "charity_votes.user_id": CASCADE("charity_votes"),
  "class_signups.email": SQL("class_signups"), "class_signups.name": SQL("class_signups"),
  "event_signups.email": SQL("event_signups"), "event_signups.name": SQL("event_signups"),
  "email_outbox.subject_email": SQL("emails_sent"), "email_outbox.to_email": SQL("emails_sent"),
  "email_verification_tokens.user_id": { erase: "cascade", allow: "one-time token, no content; expires and is purged after 7 days" },
  "password_reset_tokens.user_id": { erase: "cascade", allow: "one-time token (hashed), no content; expires and is purged after 7 days" },
  "totp_recovery_codes.user_id": { erase: "cascade", allow: "hashed recovery codes: secrets are never exported; the export says only whether 2FA is on" },
  "event_rsvps.user_id": CASCADE("event_rsvps"), "favorites.user_id": CASCADE("favorites"),
  "meeting_rsvps.user_id": CASCADE("meeting_rsvps"), "volunteer_signups.user_id": CASCADE("volunteer_signups"),
  "forum_replies.author_id": { erase: "setnull", export: "forum_replies" }, "forum_threads.author_id": { erase: "setnull", export: "forum_threads" },
  "membership_payments.payer_email": SQL("membership_payments"), "membership_payments.user_id": SQL("membership_payments"),
  "orders.buyer_email": SQL("orders"), "orders.buyer_name": SQL("orders"), "orders.buyer_phone": SQL("orders"),
  "orders.client_ip": SQL("orders"), "orders.user_id": SQL("orders"),
  "price_reprice_runs.actor_label": { erase: "sql", allow: "no longer written; older values cleared at 12 months and on erase" },
  "price_reprice_runs.actor_user_id": STAFF,
  "genre_runs.actor_user_id": STAFF, // Admin > Genres run history: the admin who pressed Update all books (the e-mail is not stored; SET NULL on delete)
  "till_quick_items.name": NOT_PERSON("name of a quick-sale button (e.g. 'Coffee')"),
  "job_runs.name": NOT_PERSON("name of a background job"),
};

test("coverage: every column that can hold a person's data is handled in erase + export, or allow-listed with a reason", async () => {
  const { rows } = await pool.query(
    `SELECT c.table_name, c.column_name FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'session'`
  );
  const found = rows.map((r) => `${r.table_name}.${r.column_name}`).filter((k) => PERSONAL_COLUMN.test(k.split(".")[1]));
  assert.ok(found.length > 40, "the introspection finds the columns");
  const unlisted = found.filter((k) => !COVERAGE[k]);
  assert.deepEqual(unlisted, [], `New personal-data columns need a decision in COVERAGE (erase + export, or an allow reason): ${unlisted.join(", ")}`);
  const stale = Object.keys(COVERAGE).filter((k) => !found.includes(k));
  assert.deepEqual(stale, [], "COVERAGE lists a column that no longer exists");
  for (const [k, v] of Object.entries(COVERAGE)) assert.ok(v.export || v.allow, `${k}: needs an export section or an allow reason`);
});

test("coverage: the claimed erase behaviour matches the foreign keys, and exports/erases are really in the code", async () => {
  const privacySrc = fs.readFileSync(path.join(__dirname, "../../src/lib/privacy.js"), "utf8");
  const exportSrc = fs.readFileSync(path.join(__dirname, "../../src/lib/memberExport.js") , "utf8") + fs.readFileSync(path.join(__dirname, "../../src/lib/outbox.js"), "utf8");
  const { rows: fks } = await pool.query(
    `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, c.confdeltype::text AS del
     FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
     WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass`
  );
  for (const f of fks) {
    assert.ok(["c", "n"].includes(f.del), `${f.tbl}.${f.col} references users without CASCADE or SET NULL: deleting the account would fail`);
    const entry = COVERAGE[`${f.tbl}.${f.col}`];
    if (entry && entry.erase === "cascade") assert.equal(f.del, "c", `${f.tbl}.${f.col} claimed cascade`);
    if (entry && entry.erase === "setnull") assert.equal(f.del, "n", `${f.tbl}.${f.col} claimed set null`);
  }
  for (const [k, v] of Object.entries(COVERAGE)) {
    const table = k.split(".")[0];
    if (v.erase === "sql") assert.ok(new RegExp(`\\b${table}\\b`).test(privacySrc + fs.readFileSync(path.join(__dirname, "../../src/lib/outbox.js"), "utf8")), `${k}: erase code must mention ${table}`);
    if (v.export && !["user"].includes(v.export)) assert.ok(exportSrc.includes(v.export), `${k}: export section ${v.export} not found`);
  }
});

test("coverage: the allow-list check really fails for an unlisted new column (revert-check)", async () => {
  await pool.query("ALTER TABLE favorites ADD COLUMN shipping_phone TEXT");
  try {
    const { rows } = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'favorites'");
    const found = rows.map((r) => `favorites.${r.column_name}`).filter((k) => PERSONAL_COLUMN.test(k.split(".")[1]));
    assert.ok(found.includes("favorites.shipping_phone") && !COVERAGE["favorites.shipping_phone"]);
  } finally {
    await pool.query("ALTER TABLE favorites DROP COLUMN shipping_phone");
  }
});
