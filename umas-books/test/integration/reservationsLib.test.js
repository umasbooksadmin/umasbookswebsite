// lib/reservations.js against a real database: reservations expire after
// 14 days, a pickup reminder goes out once a reservation is 11+ days old
// (and only once), mail failures don't block other reminders, and the
// reminder claim under concurrency.
//
// Every row here carries a unique email/title: in CI all test files share
// one database and run concurrently, so assertions only look at this
// file's own rows and mails.

const { test, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase } = require("../helpers/inProcessApp");

const db = prepareDatabase("reservations_lib", { isolated: true });

const mailer = require("../../src/mailer");
const sentEmails = [];
let sendImpl = async () => {};
mailer.sendMail = async (opts) => { sentEmails.push(opts); return sendImpl(opts); };

const { expireStaleReservations, sendPickupReminders } = require("../../src/lib/reservations");
const { pool } = require("../../src/db");

before(() => db.create());
after(async () => {
  await pool.end();
  db.drop();
});

const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let seq = 0;
beforeEach(() => {
  sentEmails.length = 0;
  sendImpl = async () => {};
  mock.method(console, "error", () => {});
});

// A reserved copy whose reservation is `ageSql` old (e.g. "11 days").
async function reservedCopy({ age = "0 days", name = "Reserva Tor", status = "reserved", withReminder = false } = {}) {
  const n = ++seq;
  const email = `resv-${RUN}-${n}@example.test`;
  const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'Res Author') RETURNING id", [`Res Book ${RUN} ${n}`]);
  const { rows } = await pool.query(
    `INSERT INTO book_copies (book_id, status, price, reserved_by_name, reserved_by_email, reserved_by_phone, reserved_at, reminder_sent_at)
     VALUES ($1, $2, 5, $3, $4, '0600000000', now() - $5::interval, ${withReminder ? "now() - interval '1 day'" : "NULL"}) RETURNING id`,
    [b[0].id, status, name, email, age]
  );
  return { id: rows[0].id, email, title: `Res Book ${RUN} ${n}` };
}
const copyRow = async (id) => (await pool.query("SELECT * FROM book_copies WHERE id = $1", [id])).rows[0];
const mailsTo = (email) => sentEmails.filter((m) => m.to === email);

// ---------------------------------------------------------------- expiry

test("a reservation older than 14 days reverts to in_stock and loses the reserver's details", async () => {
  const c = await reservedCopy({ age: "14 days 1 minute", withReminder: true });
  await expireStaleReservations(pool);
  const row = await copyRow(c.id);
  assert.equal(row.status, "in_stock");
  assert.equal(row.reserved_by_name, null);
  assert.equal(row.reserved_by_email, null);
  assert.equal(row.reserved_by_phone, null);
  assert.equal(row.reserved_at, null);
  assert.equal(row.reminder_sent_at, null, "reminder flag reset so a later reservation can be reminded again");
});

test("a reservation just under 14 days old is left alone", async () => {
  const c = await reservedCopy({ age: "13 days 23 hours 58 minutes" });
  await expireStaleReservations(pool);
  const row = await copyRow(c.id);
  assert.equal(row.status, "reserved");
  assert.equal(row.reserved_by_email, c.email);
  assert.ok(row.reserved_at);
});

test("expiry only touches reserved copies (a sold copy with an old reserved_at stays sold)", async () => {
  const c = await reservedCopy({ age: "30 days", status: "sold" });
  await expireStaleReservations(pool);
  const row = await copyRow(c.id);
  assert.equal(row.status, "sold");
  assert.equal(row.reserved_by_email, c.email);
});

test("expiry is idempotent", async () => {
  const c = await reservedCopy({ age: "20 days" });
  await expireStaleReservations(pool);
  await expireStaleReservations(pool);
  assert.equal((await copyRow(c.id)).status, "in_stock");
});

// ------------------------------------------------------------- reminders

test("no reminder before day 11; one goes out at 11+ days with the title and name", async () => {
  const early = await reservedCopy({ age: "10 days 23 hours" });
  const due = await reservedCopy({ age: "11 days 1 minute", name: "Marie Curie" });
  await sendPickupReminders(pool);

  assert.equal(mailsTo(early.email).length, 0);
  assert.equal((await copyRow(early.id)).reminder_sent_at, null);

  const mails = mailsTo(due.email);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, new RegExp(`Reminder: your copy of "${due.title}" is waiting for pickup`));
  assert.match(mails[0].text, /^Hi Marie Curie,/);
  assert.ok(mails[0].text.includes(`"${due.title}"`));
  assert.ok((await copyRow(due.id)).reminder_sent_at, "marked as sent");
});

test("the reminder is sent only once, however often the backstop runs", async () => {
  const c = await reservedCopy({ age: "12 days" });
  await sendPickupReminders(pool);
  await sendPickupReminders(pool);
  await sendPickupReminders(pool);
  assert.equal(mailsTo(c.email).length, 1);
});

test("a reservation that already has reminder_sent_at is not reminded", async () => {
  const c = await reservedCopy({ age: "12 days", withReminder: true });
  await sendPickupReminders(pool);
  assert.equal(mailsTo(c.email).length, 0);
});

test("only reserved copies are reminded (in_stock/sold rows with a stale reserved_at are ignored)", async () => {
  const sold = await reservedCopy({ age: "12 days", status: "sold" });
  const stock = await reservedCopy({ age: "12 days", status: "in_stock" });
  await sendPickupReminders(pool);
  assert.equal(mailsTo(sold.email).length, 0);
  assert.equal(mailsTo(stock.email).length, 0);
});

test("a legacy 'Wishlist match' reservation is greeted with a plain 'Hi,'", async () => {
  const c = await reservedCopy({ age: "12 days", name: "Wishlist match" });
  await sendPickupReminders(pool);
  const [mail] = mailsTo(c.email);
  assert.match(mail.text, /^Hi,\n/);
  assert.doesNotMatch(mail.text, /Wishlist/);
});

test("a mail failure leaves the copy unmarked (so it is retried) and doesn't stop other reminders", async () => {
  const bad = await reservedCopy({ age: "12 days" });
  const good = await reservedCopy({ age: "12 days" });
  sendImpl = async (opts) => { if (opts.to === bad.email) throw new Error("smtp 421"); };
  await assert.doesNotReject(sendPickupReminders(pool));

  assert.equal((await copyRow(bad.id)).reminder_sent_at, null);
  assert.ok((await copyRow(good.id)).reminder_sent_at);
  assert.equal(mailsTo(good.email).length, 1);

  // next run (mail healthy again) retries the failed one and only that one
  sendImpl = async () => {};
  await sendPickupReminders(pool);
  assert.equal(mailsTo(bad.email).length, 2, "first failed attempt + successful retry");
  assert.equal(mailsTo(good.email).length, 1, "not re-sent");
  assert.ok((await copyRow(bad.id)).reminder_sent_at);
});

test("a reminder then expiry: after the copy is released and re-reserved, the new reservation is reminded afresh", async () => {
  const c = await reservedCopy({ age: "15 days", withReminder: true });
  await expireStaleReservations(pool);
  await pool.query(
    "UPDATE book_copies SET status='reserved', reserved_by_name='Second', reserved_by_email=$2, reserved_at = now() - interval '11 days 1 minute' WHERE id = $1",
    [c.id, `second-${c.email}`]
  );
  await sendPickupReminders(pool);
  assert.equal(mailsTo(`second-${c.email}`).length, 1);
});

test("two backstop runs at the same moment send a given reminder only once",
  async () => {
    const c = await reservedCopy({ age: "12 days" });
    sendImpl = () => new Promise((r) => setTimeout(r, 50));
    await Promise.all([sendPickupReminders(pool), sendPickupReminders(pool)]);
    assert.equal(mailsTo(c.email).length, 1);
  });
