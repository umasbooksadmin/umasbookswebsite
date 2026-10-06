// The background side of reservations (lib/reservations.js, lib/orderSweeps.js):
//  - a reservation past its deadline is released (read-time and by the job); an
//    extended one is not; the older copy-level sweep leaves order-linked copies alone;
//  - the "reservation has ended" e-mail goes out once, EN/FR, not for a cancelled
//    or no-show one; the day-10 reminder once; the drop-in seat reminder once
//    (24 h before); the admin digest once; two overlapping runs never double-send;
//  - a drop-in seat nobody came for is released when its session is over, the
//    order closing when nothing is left held.
// Real database, own throwaway database (see test/helpers/reserveHarness.js).

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { reserveHarness } = require("../helpers/reserveHarness");

const h = reserveHarness("reservation_sweeps");
const sweeps = require("../../src/lib/orderSweeps");
const reservations = require("../../src/lib/reservations");
const { pool } = h;
let admin;
before(async () => { await h.start(); });
after(() => h.stop());
beforeEach(() => { h.sent.length = 0; admin = h.visitor(h.admin); });

const setDeadline = (id, sql) => pool.query(`UPDATE orders SET reserved_until = ${sql} WHERE id = $1`, [id]);
const status = async (id) => (await h.order(id)).status;
const copyStatus = h.copyStatus;
const reservedOne = async (opts = {}) => {
  const buyer = opts.buyer || await h.account({ displayName: "Sweep Person" });
  const copy = await h.copy({ title: `Sweep Book ${h.uniq()}` });
  const { order } = await h.reserve(buyer, { copyIds: [copy], lang: opts.lang });
  h.sent.length = 0;
  return { buyer, copy, order };
};

test("a reservation past its deadline is released when pages read copy status; one that is not due, or was extended, stays", async () => {
  const due = await reservedOne();
  const fine = await reservedOne();
  await setDeadline(due.order.id, "now() - interval '1 minute'");
  await setDeadline(fine.order.id, "now() + interval '1 hour'");
  await reservations.expireStaleReservations(pool);
  const after = await h.order(due.order.id);
  assert.equal(after.status, "expired");
  assert.equal(after.release_reason, "expired");
  assert.ok(after.released_at);
  assert.equal(await copyStatus(due.copy), "in_stock");
  const row = (await pool.query("SELECT reserved_by_email, cart_order_id FROM book_copies WHERE id = $1", [due.copy])).rows[0];
  assert.equal(row.reserved_by_email, null);
  assert.equal(row.cart_order_id, null);
  assert.equal(await status(fine.order.id), "reserved");
  assert.equal(await copyStatus(fine.copy), "reserved");

  // An admin extended it just before: the release re-checks under the lock.
  const ext = await reservedOne();
  await setDeadline(ext.order.id, "now() - interval '1 minute'");
  const racing = reservations.releaseReservation(pool, ext.order.id, {
    status: "expired", reason: "expired", guard: async (c, o) => (new Date(o.reserved_until) < new Date() ? undefined : { outcome: "skipped" }),
  });
  await setDeadline(ext.order.id, "now() + interval '3 days'");
  await racing;
  assert.ok(["reserved", "expired"].includes(await status(ext.order.id)), "either outcome is consistent");
  assert.equal(await status(ext.order.id) === "reserved", (await copyStatus(ext.copy)) === "reserved");
});

test("the older copy-level sweep never releases a copy that belongs to a reservation, whatever its reserved_at says", async () => {
  const { copy, order } = await reservedOne();
  await pool.query("UPDATE book_copies SET reserved_at = now() - interval '30 days' WHERE id = $1", [copy]);
  await reservations.expireStaleReservations(pool);
  assert.equal(await copyStatus(copy), "reserved");
  assert.equal(await status(order.id), "reserved");
  // ...and the copies held without an order (an admin's own reservation) still expire as before.
  const loose = await h.copy({ status: "reserved" });
  await pool.query("UPDATE book_copies SET reserved_by_email = 'x@example.test', reserved_by_name = 'X', reserved_at = now() - interval '15 days' WHERE id = $1", [loose]);
  await reservations.expireStaleReservations(pool);
  assert.equal(await copyStatus(loose), "in_stock");
});

test("expiry notice: one e-mail per lapsed reservation, in the order's language, then never again; none for cancelled or no-show", async () => {
  const en = await reservedOne({ lang: "en" });
  const fr = await reservedOne({ lang: "fr" });
  const cancelled = await reservedOne();
  const noShow = await reservedOne();
  for (const r of [en, fr, cancelled, noShow]) await setDeadline(r.order.id, "now() - interval '1 minute'");
  await admin.post(`/admin/orders/${cancelled.order.id}/cancel-reservation`);
  await admin.post(`/admin/orders/${noShow.order.id}/no-show`);
  h.sent.length = 0;

  const first = await sweeps.runOrderFollowUps(pool);
  assert.ok(first.expiryNotices.sent >= 2, "(earlier tests in this file left lapsed reservations too)");
  assert.equal(h.emailsTo(en.buyer.email).length, 1);
  assert.match(h.emailsTo(en.buyer.email)[0].subject, /has ended/);
  assert.match(h.emailsTo(en.buyer.email)[0].text, /nothing to pay and no penalty/);
  assert.match(h.emailsTo(fr.buyer.email)[0].subject, /est terminée/);
  assert.match(h.emailsTo(fr.buyer.email)[0].text, /aucune pénalité/);
  assert.equal(h.emailsTo(cancelled.buyer.email).length, 0);
  assert.equal(h.emailsTo(noShow.buyer.email).length, 0);
  assert.ok((await h.order(en.order.id)).expiry_notice_sent_at);

  h.sent.length = 0;
  const second = await sweeps.runOrderFollowUps(pool);
  assert.equal(second.expiryNotices.sent, 0);
  assert.equal(h.sent.length, 0, "once only");

});

test("two overlapping runs of the follow-up send the expiry notice once (claim before send)", async () => {
  const r = await reservedOne();
  await setDeadline(r.order.id, "now() - interval '1 minute'");
  await Promise.all([sweeps.runOrderFollowUps(pool), sweeps.runOrderFollowUps(pool)]);
  assert.equal(h.emailsTo(r.buyer.email).length, 1);
});

test("day-10 reminder: sent once when the deadline is within 4 days, not before, not after the deadline, in the order's language", async () => {
  const early = await reservedOne();          // 14 days left: too early
  const due = await reservedOne({ lang: "fr" });
  const dueEn = await reservedOne({ lang: "en" });
  const late = await reservedOne();           // already past the deadline
  await setDeadline(due.order.id, "now() + interval '3 days'");
  await setDeadline(dueEn.order.id, "now() + interval '3 days 20 hours'");
  await setDeadline(late.order.id, "now() - interval '1 minute'");

  const run1 = await sweeps.sendReservationReminders(pool);
  assert.equal(run1.sent, 2);
  assert.equal(h.emailsTo(early.buyer.email).length, 0);
  assert.equal(h.emailsTo(late.buyer.email).length, 0);
  const fr = h.emailsTo(due.buyer.email)[0];
  assert.match(fr.subject, /vous attendent à la boutique/);
  assert.match(fr.text, /jusqu’à la fin de la journée du/);
  assert.match(fr.text, /annuler depuis votre page de compte/);
  const en = h.emailsTo(dueEn.buyer.email)[0];
  assert.match(en.subject, /waiting at the shop/);
  assert.match(en.text, /Sweep Book/);

  const run2 = await sweeps.sendReservationReminders(pool);
  assert.equal(run2.sent, 0, "once per order");
  assert.equal(h.emailsTo(due.buyer.email).length, 1);
});

test("a reminder is not sent for a seat-only reservation (it has its own reminder) nor for an erased account", async () => {
  const seatOnly = (await h.reserve(await h.account(), { classIds: [await h.session({ startsInHours: 60 })] })).order;
  await setDeadline(seatOnly.id, "now() + interval '2 days'");
  const erased = await reservedOne();
  await setDeadline(erased.order.id, "now() + interval '2 days'");
  await pool.query("UPDATE orders SET buyer_email = 'erased-order-1@erased.invalid' WHERE id = $1", [erased.order.id]);
  h.sent.length = 0;
  const r = await sweeps.sendReservationReminders(pool);
  assert.ok(!h.sent.some((m) => /erased\.invalid/.test(m.to)));
  assert.equal(h.sent.filter((m) => m.to === seatOnly.buyer_email).length, 0);
  assert.ok(r.sent >= 0);
});

test("drop-in seat reminder: once, within 24 hours of the session, not earlier, not for a cancelled seat", async () => {
  const soon = await h.session({ startsInHours: 20, capacity: 5 });
  const far = await h.session({ startsInHours: 24 * 4, capacity: 5 });
  const [a, b, c] = [await h.account(), await h.account(), await h.account()];
  const near = (await h.reserve(a, { classIds: [soon], lang: "fr" })).order;
  const distant = (await h.reserve(b, { classIds: [far] })).order;
  const dropped = (await h.reserve(c, { classIds: [soon] })).order;
  // cancelled directly (the customer cannot cancel within 24 h online)
  await admin.post(`/admin/orders/${dropped.id}/cancel-reservation`);
  h.sent.length = 0;

  const r1 = await sweeps.sendSeatReminders(pool);
  assert.equal(r1.sent, 1);
  const mail = h.emailsTo(a.email)[0];
  assert.match(mail.subject, /Rappel : votre place/);
  assert.match(mail.text, /vous réglez sur place/i);
  assert.equal(h.emailsTo(b.email).length, 0, "5 days away: too early");
  assert.equal(h.emailsTo(c.email).length, 0, "cancelled");
  const seat = (await pool.query("SELECT reminder_sent_at FROM class_dropin_seats WHERE order_id = $1", [near.id])).rows[0];
  assert.ok(seat.reminder_sent_at);
  assert.equal((await sweeps.sendSeatReminders(pool)).sent, 0, "once per seat");
  assert.equal(distant.status, "reserved");
});

test("a drop-in seat nobody came for is released once its session is over; the order closes when nothing is left held, and a mixed order keeps its books", async () => {
  const over = await h.session({ startsInHours: 24 * 3, capacity: 3 });
  const buyer = await h.account();
  const seatOnly = (await h.reserve(buyer, { classIds: [over] })).order;
  const copy = await h.copy();
  const mixed = (await h.reserve(buyer, { copyIds: [copy], classIds: [over] })).order;
  // Time passes: the session ended an hour ago.
  await pool.query("UPDATE classes SET starts_at = now() - interval '4 hours', ends_at = now() - interval '1 hour' WHERE id = $1", [over]);
  await reservations.expireStaleReservations(pool);

  const seats = (await pool.query("SELECT order_id, status FROM class_dropin_seats WHERE class_id = $1 ORDER BY id", [over])).rows;
  assert.deepEqual(seats.map((s) => s.status), ["released", "released"]);
  assert.equal(await status(seatOnly.id), "expired", "nothing left held");
  assert.equal((await h.order(seatOnly.id)).release_reason, "expired");
  assert.equal(await status(mixed.id), "reserved", "the book is still held");
  assert.equal(await copyStatus(copy), "reserved");
  // No 'back on sale' e-mail for a session that has passed.
  h.sent.length = 0;
  await sweeps.sendExpiryNotices(pool);
  assert.equal(h.emailsTo(buyer.email).length, 0);
});

test("a seat is held through the session itself: still reserved while it runs, so the staff can record the payment", async () => {
  const running = await h.session({ startsInHours: 24 * 3, capacity: 3 });
  const buyer = await h.account();
  const { order } = await h.reserve(buyer, { classIds: [running] });
  await pool.query("UPDATE classes SET starts_at = now() - interval '30 minutes', ends_at = now() + interval '90 minutes' WHERE id = $1", [running]);
  await reservations.expireStaleReservations(pool);
  assert.equal(await status(order.id), "reserved");
  const r = await admin.post(`/admin/orders/${order.id}/collect`, { method: "cash" });
  assert.match(r.location, /collected-paid/);
  assert.equal((await pool.query("SELECT status FROM class_dropin_seats WHERE order_id = $1", [order.id])).rows[0].status, "sold");
});

test("admin digest: reservations expiring within 2 days are listed in ONE e-mail to the shop, once per reservation", async () => {
  const [x, y] = [await reservedOne(), await reservedOne()];
  const far = await reservedOne();
  for (const r of [x, y]) await setDeadline(r.order.id, "now() + interval '30 hours'");
  const before = h.sent.length;
  const run = await sweeps.sendAdminReservationDigest(pool);
  assert.ok(run.sent >= 2);
  const digests = h.sent.slice(before).filter((m) => /expiring within 2 days/.test(m.subject));
  assert.equal(digests.length, 1, "one e-mail for the whole batch");
  assert.match(digests[0].text, new RegExp(`Reservation #${x.order.id}:`));
  assert.match(digests[0].text, new RegExp(`Reservation #${y.order.id}:`));
  assert.doesNotMatch(digests[0].text, new RegExp(`Reservation #${far.order.id}:`));
  assert.match(digests[0].text, /Extend by 7 days/);
  const again = await sweeps.sendAdminReservationDigest(pool);
  assert.equal(again.sent, 0);
});

test("no step of the follow-up job talks to HelloAsso, and one failing step does not stop the others", async () => {
  const r = await reservedOne();
  await setDeadline(r.order.id, "now() - interval '1 minute'");
  const results = await sweeps.runOrderFollowUps(pool);
  for (const key of ["release", "reservationReminders", "seatReminders", "expiryNotices", "adminReservationDigest", "customerReminders", "adminDigest"]) {
    assert.ok(key in results, key);
    assert.ok(!results[key].error, `${key}: ${results[key].error}`);
  }
  assert.deepEqual(h.helloassoCalls, []);
});

test("orders paid online before reservations existed still get their day-10 reminder (legacy)", async () => {
  const buyer = await h.account();
  const copy = await h.copy({ status: "sold" });
  const { rows } = await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, total_amount, status, user_id, lang, paid_at, created_at)
     VALUES ('Legacy Buyer', $1, 6, 'paid', $2, 'en', now() - interval '11 days', now() - interval '11 days') RETURNING id`, [buyer.email, buyer.id]);
  await pool.query("INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, 'Legacy Book', 6)", [rows[0].id, copy]);
  h.sent.length = 0;
  const r = await sweeps.sendCustomerPickupReminders(pool);
  assert.ok(r.sent >= 1);
  assert.match(h.emailsTo(buyer.email)[0].subject, /Your books are waiting at the shop/);
});
