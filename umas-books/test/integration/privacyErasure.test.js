// Right to erasure and retention purge (src/lib/privacy.js): everything
// held under a member's email goes, accounting rows are anonymised, and
// the purge only touches data past its promised retention period.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3490;
const PASSWORD = "ErasureTest1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let app, pool, privacy;

before(async () => {
  app = await startTestApp({ port: PORT });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  privacy = require("../../src/lib/privacy");
});

after(async () => {
  await pool.end();
  app.stop();
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function createUser({ admin = false, lastLoginYearsAgo = null, memberUntil = null, warnedDaysAgo = null } = {}) {
  const email = `erase-${uniq()}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, email_verified_at,
                        last_login_at, created_at, member_expires_at, inactivity_warned_at)
     VALUES ($1, $2, 'Erase Me', $3, now(),
             CASE WHEN $4::int IS NULL THEN now() ELSE now() - make_interval(years => $4::int) END,
             CASE WHEN $4::int IS NULL THEN now() ELSE now() - make_interval(years => $4::int) END,
             $5, CASE WHEN $6::int IS NULL THEN NULL ELSE now() - make_interval(days => $6::int) END)
     RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 10), admin, lastLoginYearsAgo, memberUntil, warnedDaysAgo]
  );
  return { id: rows[0].id, email };
}

async function seedPersonalData(user) {
  const { rows: ev } = await pool.query(
    "INSERT INTO events (title, starts_at) VALUES ('E', now() + interval '1 day') RETURNING id"
  );
  const { rows: cl } = await pool.query(
    "INSERT INTO classes (title, starts_at) VALUES ('C', now() + interval '1 day') RETURNING id"
  );
  await pool.query("INSERT INTO event_signups (event_id, name, email) VALUES ($1, 'N', $2)", [ev[0].id, user.email.toUpperCase()]);
  await pool.query("INSERT INTO class_signups (class_id, name, email) VALUES ($1, 'N', $2)", [cl[0].id, user.email]);
  const { rows: ord } = await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, buyer_phone, status, total_amount, paid_at)
     VALUES ('Real Name', $1, '0600000000', 'paid', 5, now()) RETURNING id, access_token`,
    [user.email]
  );
  await pool.query(
    `INSERT INTO membership_payments (user_id, helloasso_order_id, payer_email, amount_cents, paid_at)
     VALUES ($1, $2, $3, 1500, now())`,
    [user.id, Math.floor(Math.random() * 1e12), user.email]
  );
  const { rows: thread } = await pool.query(
    "INSERT INTO forum_threads (title, body, author_id) VALUES ('T', 'kept text', $1) RETURNING id",
    [user.id]
  );
  return { order: ord[0], threadId: thread[0].id };
}

test("eraseMember removes the account and all email-keyed data, anonymises accounting rows", async () => {
  const user = await createUser();
  const other = await createUser();
  const seeded = await seedPersonalData(user);
  await seedPersonalData(other);

  assert.equal(await privacy.eraseMember(pool, user.id), true);

  const q = async (sql, p) => (await pool.query(sql, p)).rows;
  assert.equal((await q("SELECT 1 FROM users WHERE id=$1", [user.id])).length, 0);
  assert.equal((await q("SELECT 1 FROM event_signups WHERE lower(email)=lower($1)", [user.email])).length, 0);
  assert.equal((await q("SELECT 1 FROM class_signups WHERE lower(email)=lower($1)", [user.email])).length, 0);

  const [order] = await q("SELECT * FROM orders WHERE id=$1", [seeded.order.id]);
  assert.equal(order.buyer_email, privacy.erasedEmail(user.id));
  assert.equal(order.buyer_name, privacy.ERASED_NAME);
  assert.equal(order.buyer_phone, null);
  assert.equal(order.status, "paid");
  assert.equal(Number(order.total_amount), 5);
  assert.notEqual(order.access_token, seeded.order.access_token);

  const pays = await q("SELECT * FROM membership_payments WHERE payer_email=$1", [privacy.erasedEmail(user.id)]);
  assert.equal(pays.length, 1);
  assert.equal(pays[0].amount_cents, 1500);

  const [thread] = await q("SELECT * FROM forum_threads WHERE id=$1", [seeded.threadId]);
  assert.equal(thread.body, "kept text");
  assert.equal(thread.author_id, null);

  // Someone else's data is untouched.
  assert.equal((await q("SELECT 1 FROM event_signups WHERE lower(email)=lower($1)", [other.email])).length, 1);
  assert.equal((await q("SELECT 1 FROM orders WHERE buyer_email=$1", [other.email])).length, 1);

  assert.equal(await privacy.eraseMember(pool, user.id), false);
});

test("eraseMember releases an active reservation held under the email", async () => {
  const user = await createUser();
  const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ('B','A') RETURNING id");
  const { rows: c } = await pool.query(
    `INSERT INTO book_copies (book_id, status, reserved_by_name, reserved_by_email, reserved_by_phone, reserved_at)
     VALUES ($1, 'reserved', 'Real', $2, '06', now()) RETURNING id`,
    [b[0].id, user.email]
  );
  await privacy.eraseMember(pool, user.id);
  const [copy] = (await pool.query("SELECT * FROM book_copies WHERE id=$1", [c[0].id])).rows;
  assert.equal(copy.status, "in_stock");
  assert.equal(copy.reserved_by_email, null);
  assert.equal(copy.reserved_by_name, null);
  assert.equal(copy.reserved_by_phone, null);
});

test("eraseMember ends the account's logged-in sessions", async () => {
  const user = await createUser();
  await pool.query(
    `CREATE TABLE IF NOT EXISTS session (sid varchar PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL)`
  );
  await pool.query(
    "INSERT INTO session (sid, sess, expire) VALUES ($1, $2, now() + interval '1 day')",
    [`erase-${uniq()}`, JSON.stringify({ user: { id: user.id } })]
  );
  await privacy.eraseMember(pool, user.id);
  const { rows } = await pool.query("SELECT 1 FROM session WHERE (sess->'user'->>'id')::int = $1", [user.id]);
  assert.equal(rows.length, 0);
});

test("purge removes data past retention and keeps data inside it", async () => {
  const { rows: oldEv } = await pool.query(
    "INSERT INTO events (title, starts_at) VALUES ('old', now() - interval '13 months') RETURNING id");
  const { rows: newEv } = await pool.query(
    "INSERT INTO events (title, starts_at) VALUES ('recent', now() - interval '11 months') RETURNING id");
  await pool.query("INSERT INTO event_signups (event_id, name, email) VALUES ($1,'a','old@example.test')", [oldEv[0].id]);
  await pool.query("INSERT INTO event_signups (event_id, name, email) VALUES ($1,'a','new@example.test')", [newEv[0].id]);

  const oldOrder = (await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, status, total_amount, created_at)
     VALUES ('o','o-old@example.test','paid',1, now() - interval '11 years') RETURNING id`)).rows[0].id;
  const midOrder = (await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, status, total_amount, created_at)
     VALUES ('o','o-mid@example.test','paid',1, now() - interval '9 years') RETURNING id`)).rows[0].id;

  const stale = await createUser({ lastLoginYearsAgo: 4, warnedDaysAgo: 31 });
  const fresh = await createUser({ lastLoginYearsAgo: 2 });
  const oldAdmin = await createUser({ admin: true, lastLoginYearsAgo: 5, warnedDaysAgo: 40 });
  const oldPaidMember = await createUser({ lastLoginYearsAgo: 5, memberUntil: new Date(Date.now() + 86400000), warnedDaysAgo: 40 });

  const counts = await privacy.purgeExpiredPersonalData(pool);
  assert.ok(Object.values(counts).every((v) => v !== "error"), JSON.stringify(counts));

  const has = async (sql, p) => (await pool.query(sql, p)).rows.length === 1;
  assert.equal(await has("SELECT 1 FROM event_signups WHERE email='old@example.test'"), false);
  assert.equal(await has("SELECT 1 FROM event_signups WHERE email='new@example.test'"), true);
  assert.equal(await has("SELECT 1 FROM orders WHERE id=$1", [oldOrder]), false);
  assert.equal(await has("SELECT 1 FROM orders WHERE id=$1", [midOrder]), true);
  assert.equal(await has("SELECT 1 FROM users WHERE id=$1", [stale.id]), false);
  assert.equal(await has("SELECT 1 FROM users WHERE id=$1", [fresh.id]), true);
  assert.equal(await has("SELECT 1 FROM users WHERE id=$1", [oldAdmin.id]), true);
  assert.equal(await has("SELECT 1 FROM users WHERE id=$1", [oldPaidMember.id]), true);
});

test("purge removes long-expired reset/verification tokens only", async () => {
  const u = await createUser();
  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES
     ($1, 'h-old-${uniq()}', now() - interval '8 days'), ($1, 'h-new-${uniq()}', now() - interval '1 day')`,
    [u.id]
  );
  await privacy.purgeExpiredPersonalData(pool);
  const { rows } = await pool.query("SELECT 1 FROM password_reset_tokens WHERE user_id=$1", [u.id]);
  assert.equal(rows.length, 1);
});

test("admin Erase Member route erases through the app,", async () => {
  const admin = await createUser({ admin: true });
  const victim = await createUser();
  await seedPersonalData(victim);

  const jar = makeCookieJar();
  let token = await fetchCsrfToken(app.base, jar);
  const login = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ email: admin.email, password: PASSWORD, _csrf: token }).toString(),
  });
  jar.capture(login);
  assert.equal(login.status, 302);

  token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/admin/members/${victim.id}/delete`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ _csrf: token }).toString(),
  });
  assert.equal(res.status, 302);
  assert.equal((await pool.query("SELECT 1 FROM users WHERE id=$1", [victim.id])).rows.length, 0);
  assert.equal((await pool.query("SELECT 1 FROM event_signups WHERE lower(email)=lower($1)", [victim.email])).rows.length, 0);
  assert.equal((await pool.query("SELECT 1 FROM orders WHERE buyer_email=$1", [victim.email])).rows.length, 0);
});

test("inactive accounts are warned first, and only deleted 30 days after the warning", async () => {
  const unwarned = await createUser({ lastLoginYearsAgo: 4 });
  const warnedRecently = await createUser({ lastLoginYearsAgo: 4, warnedDaysAgo: 10 });
  const nearlyDue = await createUser({ lastLoginYearsAgo: 3 }); // 3y - 30d < inactive < 3y: warn, don't delete

  await privacy.purgeExpiredPersonalData(pool);

  const row = async (id) => (await pool.query("SELECT inactivity_warned_at FROM users WHERE id=$1", [id])).rows[0];
  assert.ok(await row(unwarned.id), "unwarned account must still exist");
  assert.ok((await row(unwarned.id)).inactivity_warned_at, "and now be marked warned");
  assert.ok(await row(warnedRecently.id), "warned 10 days ago: not deleted yet");
  assert.ok(await row(nearlyDue.id));
});

test("logging in clears the inactivity warning", async () => {
  const u = await createUser({ lastLoginYearsAgo: 4, warnedDaysAgo: 5 });
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ email: u.email, password: PASSWORD, _csrf: token }).toString(),
  });
  assert.equal(res.status, 302);
  const { rows } = await pool.query("SELECT inactivity_warned_at FROM users WHERE id=$1", [u.id]);
  assert.equal(rows[0].inactivity_warned_at, null);
});
