// Backup/retention follow-ups: inactivity clock refresh, in_cart copy edits,
// claim-first reminder and warning emails, and the 30-day purge of ended
// reservations and closed orders.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3680;
const PASSWORD = "RetentionTest1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let app, pool, privacy, reservations, mailer, processOutbox;
let sent = [];
let failSends = false;
let sendDelayMs = 0; // widens the window in which overlapping runs race

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  // The server runs a retention purge of its own at boot, in the background;
  // let it finish before this file inserts old rows it is allowed to purge.
  await app.waitForLog(/Retention purge/);
  privacy = require("../../src/lib/privacy");
  reservations = require("../../src/lib/reservations");
  ({ processOutbox } = require("../../src/lib/outbox"));
  mailer = require("../../src/mailer");
  mailer.sendMail = async (opts) => {
    if (sendDelayMs) await new Promise((r) => setTimeout(r, sendDelayMs));
    if (failSends) throw new Error("smtp down");
    sent.push(opts);
  };
});

after(async () => {
  await pool.end();
  app.stop();
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function createUser({ admin = false, yearsAgo = null } = {}) {
  const email = `ret-${uniq()}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, email_verified_at, last_login_at, created_at)
     VALUES ($1, $2, 'Ret Test', $3, now(),
             CASE WHEN $4::int IS NULL THEN now() ELSE now() - make_interval(years => $4::int) END,
             CASE WHEN $4::int IS NULL THEN now() ELSE now() - make_interval(years => $4::int) END)
     RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 10), admin, yearsAgo]
  );
  return { id: rows[0].id, email };
}

async function loginJar(email) {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ email, password: PASSWORD, _csrf: token }).toString(),
  });
  jar.capture(res);
  assert.equal(res.status, 302, "test login should succeed");
  return jar;
}

async function makeCopy() {
  const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ('Retention Book', 'A') RETURNING id");
  const { rows: c } = await pool.query(
    `INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', 5) RETURNING id`, [b[0].id]);
  return { bookId: b[0].id, copyId: c[0].id };
}

const lastLogin = async (id) =>
  (await pool.query("SELECT last_login_at, inactivity_warned_at FROM users WHERE id=$1", [id])).rows[0];

test("any signed-in request refreshes last_login_at and clears the warning, once per day", async () => {
  const u = await createUser();
  const jar = await loginJar(u.email);
  const stale = "now() - interval '4 years'";

  await pool.query(`UPDATE users SET last_login_at = ${stale}, inactivity_warned_at = now() WHERE id = $1`, [u.id]);
  jar.capture(await fetch(`${app.base}/`, { headers: { cookie: jar.header() } }));
  let row = await lastLogin(u.id);
  assert.ok(Date.now() - row.last_login_at.getTime() < 60000, "an ordinary request counts as activity");
  assert.equal(row.inactivity_warned_at, null);

  // Same day again: no further write (the session carries the day marker).
  await pool.query(`UPDATE users SET last_login_at = ${stale} WHERE id = $1`, [u.id]);
  jar.capture(await fetch(`${app.base}/`, { headers: { cookie: jar.header() } }));
  row = await lastLogin(u.id);
  assert.ok(Date.now() - row.last_login_at.getTime() > 86400000 * 365, "no second write on the same day");
});

test("editing an in_cart copy keeps it in_cart but still saves other fields", async () => {
  const admin = await createUser({ admin: true });
  const jar = await loginJar(admin.email);
  const { bookId, copyId } = await makeCopy();
  await pool.query("UPDATE book_copies SET status='in_cart', cart_added_at=now() WHERE id=$1", [copyId]);

  const edit = async (status, price) => {
    const token = await fetchCsrfToken(app.base, jar);
    const res = await fetch(`${app.base}/admin/inventory/${bookId}/copies/${copyId}`, {
      method: "POST", redirect: "manual",
      headers: { ...FORM, cookie: jar.header() },
      body: new URLSearchParams({ condition: "very_good", status, price, notes: "edited", _csrf: token }).toString(),
    });
    assert.equal(res.status, 302);
    return (await pool.query("SELECT status, price, notes FROM book_copies WHERE id=$1", [copyId])).rows[0];
  };

  const r = await edit("in_stock", "9");
  assert.equal(r.status, "in_cart");
  assert.equal(Number(r.price), 9);
  assert.equal(r.notes, "edited");

  // Control: a copy that is not in a cart still takes the submitted status.
  await pool.query("UPDATE book_copies SET status='in_stock' WHERE id=$1", [copyId]);
  assert.equal((await edit("sold", "9")).status, "sold");
});

async function reservedCopy({ email = `r-${uniq()}@example.test`, daysOld = 12 } = {}) {
  const { copyId } = await makeCopy();
  await pool.query(
    `UPDATE book_copies SET status='reserved', reserved_by_name='Rita', reserved_by_email=$2,
            reserved_by_phone='0600', reserved_at = now() - make_interval(days => $3::int), reminder_sent_at = NULL
     WHERE id=$1`, [copyId, email, daysOld]);
  return { copyId, email };
}
const reminderAt = async (id) => (await pool.query("SELECT reminder_sent_at FROM book_copies WHERE id=$1", [id])).rows[0].reminder_sent_at;

test("pickup reminders: sent once, skipped without an email, claim kept and the retry owned by the outbox on failure", async () => {
  const ok = await reservedCopy();
  const noEmail = await reservedCopy();
  await pool.query("UPDATE book_copies SET reserved_by_email = NULL WHERE id=$1", [noEmail.copyId]);

  sent = [];
  await reservations.sendPickupReminders(pool);
  assert.equal(sent.filter((m) => m.to === ok.email).length, 1);
  assert.ok(await reminderAt(ok.copyId));
  assert.equal(await reminderAt(noEmail.copyId), null, "no email: nothing to send, nothing marked");

  // Two overlapping runs (a deploy overlap) send one reminder between them.
  const racy = await reservedCopy();
  sent = [];
  sendDelayMs = 100;
  try { await Promise.all([reservations.sendPickupReminders(pool), reservations.sendPickupReminders(pool)]); } finally { sendDelayMs = 0; }
  assert.equal(sent.filter((m) => m.to === racy.email).length, 1);

  // A failed send no longer hands the claim back: the reminder is safely in the
  // email outbox, whose worker retries it (once, whatever the daily runs do).
  const flaky = await reservedCopy();
  failSends = true;
  try { await reservations.sendPickupReminders(pool); } finally { failSends = false; }
  assert.ok(await reminderAt(flaky.copyId), "claim kept: the outbox owns the retry");
  const { rows: queued } = await pool.query("SELECT id, status, attempts FROM email_outbox WHERE lower(to_email) = lower($1) AND kind = 'reservation_reminder'", [flaky.email]);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].status, "pending");
  assert.equal(queued[0].attempts, 1);
  sent = [];
  await reservations.sendPickupReminders(pool);
  assert.equal(sent.filter((m) => m.to === flaky.email).length, 0, "tomorrow's run does not send a second reminder");
  await pool.query("UPDATE email_outbox SET next_try_at = now() WHERE id = $1", [queued[0].id]);
  await processOutbox(pool);
  assert.equal(sent.filter((m) => m.to === flaky.email).length, 1, "the outbox worker delivers it");
});

test("inactivity warnings: claimed before sending, once only, queued for retry if the send fails", async () => {
  const a = await createUser({ yearsAgo: 4 });
  const b = await createUser({ yearsAgo: 4 });
  const mine = (m) => m.to === a.email || m.to === b.email;

  sent = [];
  sendDelayMs = 100;
  try { await Promise.all([privacy.purgeExpiredPersonalData(pool), privacy.purgeExpiredPersonalData(pool)]); } finally { sendDelayMs = 0; }
  assert.equal(sent.filter((m) => m.to === a.email).length, 1, "overlapping sweeps warn each person once");
  assert.equal(sent.filter(mine).length, 2);
  assert.ok((await lastLogin(a.id)).inactivity_warned_at);

  // A failed send is queued in the outbox for retry; the account counts as
  // warned (the warning WILL go out), and the retry sends it exactly once.
  const c = await createUser({ yearsAgo: 4 });
  failSends = true;
  try { await privacy.purgeExpiredPersonalData(pool); } finally { failSends = false; }
  assert.ok((await lastLogin(c.id)).inactivity_warned_at, "queued for retry: the warning is on its way");
  await pool.query("UPDATE email_outbox SET next_try_at = now() WHERE kind = 'inactivity_warning' AND status = 'pending'");
  sent = [];
  await processOutbox(pool);
  assert.equal(sent.filter((m) => m.to === c.email).length, 1, "the retry delivers the warning");
  sent = [];
  await processOutbox(pool);
  assert.equal(sent.length, 0, "and only once");
});

test("purge drops contact data from ended reservations and closed orders after 30 days", async () => {
  const old = await reservedCopy();
  await pool.query("UPDATE book_copies SET status='sold', updated_at = now() - interval '31 days' WHERE id=$1", [old.copyId]);
  const recent = await reservedCopy();
  await pool.query("UPDATE book_copies SET status='sold', updated_at = now() - interval '5 days' WHERE id=$1", [recent.copyId]);
  const active = await reservedCopy();
  await pool.query("UPDATE book_copies SET updated_at = now() - interval '40 days' WHERE id=$1", [active.copyId]);

  const order = async (status, days) => (await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, buyer_phone, status, total_amount, created_at)
     VALUES ('Real Buyer', $1, '0611', $2, 5, now() - make_interval(days => $3::int)) RETURNING id`,
    [`buyer-${uniq()}@example.test`, status, days])).rows[0].id;
  const oldExpired = await order("expired", 31);
  const oldCancelled = await order("cancelled", 45);
  const recentExpired = await order("expired", 3);
  const oldPaid = await order("paid", 100);

  await privacy.purgeExpiredPersonalData(pool);

  const copy = async (id) => (await pool.query(
    "SELECT reserved_by_name, reserved_by_email, reserved_by_phone FROM book_copies WHERE id=$1", [id])).rows[0];
  assert.deepEqual(await copy(old.copyId), { reserved_by_name: null, reserved_by_email: null, reserved_by_phone: null });
  assert.equal((await copy(recent.copyId)).reserved_by_email, recent.email);
  assert.equal((await copy(active.copyId)).reserved_by_email, active.email, "a live reservation is never touched");

  const ord = async (id) => (await pool.query("SELECT buyer_name, buyer_email, buyer_phone FROM orders WHERE id=$1", [id])).rows[0];
  for (const id of [oldExpired, oldCancelled]) {
    assert.deepEqual(await ord(id), { buyer_name: "Erased", buyer_email: `erased-order-${id}@erased.invalid`, buyer_phone: null });
  }
  assert.equal((await ord(recentExpired)).buyer_name, "Real Buyer");
  assert.equal((await ord(oldPaid)).buyer_name, "Real Buyer", "paid orders are accounting records, kept");
});
