// A drop-in seat is held until its OWN session is over, whatever else is in the reservation (review 6B, M1 and M2):
//  - books and a seat reserved together: at the book deadline only the books go back on sale; the seat carries on as
//    a reservation of its own (split_from_order_id), held until its session, and still gets its 24-hour reminder;
//    the "your reservation has ended" email lists only the books;
//  - collecting the books early leaves the seat on a reservation held until its session (not the book deadline);
//  - rescheduling a session (admin form) moves the deadline of the reservations that hold only seats for it.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { reserveHarness } = require("../helpers/reserveHarness");

const h = reserveHarness("seat_hold_deadlines", { routers: ["routes/admin/sessions"] });
// After the harness: it points DATABASE_URL at this file's own database first.
const { expireStaleReservations } = require("../../src/lib/reservations");
const { collectReservation } = require("../../src/lib/orderActions");
const { sendExpiryNotices, sendSeatReminders } = require("../../src/lib/orderSweeps");
before(() => h.start());
after(() => h.stop());

const DAY_HOURS = 24;
const seatOf = async (orderId) => (await h.pool.query("SELECT id, status, order_id FROM class_dropin_seats WHERE order_id = $1", [orderId])).rows;
const classEnd = async (classId) => (await h.pool.query("SELECT ends_at FROM classes WHERE id = $1", [classId])).rows[0].ends_at;
const splitOf = async (orderId) => (await h.pool.query("SELECT * FROM orders WHERE split_from_order_id = $1 ORDER BY id", [orderId])).rows;
// What the admin form's datetime-local field holds (parsed in the server's own time zone, lib/dates.js).
const localField = (d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

test("books + a seat for a later session: at the book deadline only the books go back; the seat stays held until its session", async () => {
  const buyer = await h.account();
  const copy = await h.copy({ price: 6, title: `Deadline Book ${h.uniq()}` });
  const cls = await h.session({ startsInHours: DAY_HOURS * 20, endsInHours: DAY_HOURS * 20 + 1, price: 8, title: `Later Session ${h.uniq()}` });
  const { order } = await h.reserve(buyer, { copyIds: [copy], classIds: [cls] });
  assert.ok(order, "reserved");
  assert.ok(new Date(order.reserved_until) < new Date(await classEnd(cls)), "the order deadline is the book deadline, before the session");

  // The day after the book deadline.
  await h.pool.query("UPDATE orders SET reserved_until = now() - interval '1 minute' WHERE id = $1", [order.id]);
  await expireStaleReservations(h.pool);

  assert.equal(await h.copyStatus(copy), "in_stock", "the book is back on sale");
  const original = await h.order(order.id);
  assert.equal(original.status, "expired");
  assert.equal(original.release_reason, "expired");
  assert.equal(Number(original.total_amount), 6, "the ended reservation keeps only the books");

  const [kept] = await splitOf(order.id);
  assert.ok(kept, "the seat moved to a reservation of its own");
  assert.equal(kept.status, "reserved");
  assert.equal(Number(kept.total_amount), 8);
  assert.equal(kept.user_id, buyer.id);
  assert.equal(new Date(kept.reserved_until).getTime(), new Date(await classEnd(cls)).getTime(), "held until its session is over");
  const seats = await seatOf(kept.id);
  assert.equal(seats.length, 1);
  assert.equal(seats[0].status, "reserved", "the seat is NOT released");
  assert.equal((await seatOf(order.id)).length, 0);

  // A second sweep changes nothing (the seat reservation is inside its deadline).
  await expireStaleReservations(h.pool);
  assert.equal((await h.order(kept.id)).status, "reserved");

  // The "has ended" email lists the book only, and says the seat is still reserved.
  h.sent.length = 0;
  await sendExpiryNotices(h.pool);
  const [ended] = h.emailsTo(buyer.email);
  assert.ok(ended, "the expiry notice went out");
  assert.match(ended.subject, new RegExp(`#${order.id} has ended`));
  assert.match(ended.text, /Deadline Book/);
  assert.doesNotMatch(ended.text, /Later Session/, "the seat is not listed as released");
  assert.match(ended.text, new RegExp(`drop-in seat is still reserved.*#${kept.id}`, "s"));

  // The 24-hour seat reminder is still sent (the session is now tomorrow).
  await h.pool.query("UPDATE classes SET starts_at = now() + interval '20 hours', ends_at = now() + interval '21 hours' WHERE id = $1", [cls]);
  h.sent.length = 0;
  assert.equal((await sendSeatReminders(h.pool)).sent, 1);
  assert.match(h.emailsTo(buyer.email)[0].subject, new RegExp(`drop-in seat tomorrow \\(reservation #${kept.id}\\)`));
});

test("a guest hold nobody confirmed still releases its seat with its books", async () => {
  const copy = await h.copy();
  const cls = await h.session({ startsInHours: DAY_HOURS * 20, endsInHours: DAY_HOURS * 20 + 1 });
  const v = h.visitor();
  await v.post("/cart/add", { copyId: copy });
  await v.post("/cart/add-dropin", { classId: cls });
  const r = await v.post("/cart/guest/reserve", { name: "Guest Buyer", email: `guest-${h.uniq()}@example.test`, acceptCgv: "on" });
  const token = (r.location || "").match(/order=([0-9a-f-]{36})/);
  assert.ok(token, `guest reservation made (${r.status} ${r.location})`);
  const { rows } = await h.pool.query("SELECT * FROM orders WHERE access_token = $1", [token[1]]);
  await h.pool.query("UPDATE orders SET reserved_until = now() - interval '1 minute' WHERE id = $1", [rows[0].id]);
  await expireStaleReservations(h.pool);
  const o = await h.order(rows[0].id);
  assert.equal(o.status, "expired");
  assert.equal(o.release_reason, "unconfirmed");
  assert.equal((await seatOf(o.id))[0].status, "released");
  assert.equal((await splitOf(o.id)).length, 0, "nothing is split off an unconfirmed hold");
});

test("a seat-only reservation is never released by a stale deadline while its session is ahead: the deadline follows the session", async () => {
  const buyer = await h.account();
  const cls = await h.session({ startsInHours: DAY_HOURS * 3, endsInHours: DAY_HOURS * 3 + 2 });
  const { order } = await h.reserve(buyer, { classIds: [cls] });
  await h.pool.query("UPDATE orders SET reserved_until = now() - interval '1 hour' WHERE id = $1", [order.id]);
  await expireStaleReservations(h.pool);
  const o = await h.order(order.id);
  assert.equal(o.status, "reserved");
  assert.equal(new Date(o.reserved_until).getTime(), new Date(await classEnd(cls)).getTime());
  assert.equal((await seatOf(order.id))[0].status, "reserved");
});

test("collecting the books early leaves the seat on a reservation held until its session, not the book deadline", async () => {
  const buyer = await h.account();
  const copy = await h.copy({ price: 5 });
  const cls = await h.session({ startsInHours: DAY_HOURS * 20, endsInHours: DAY_HOURS * 20 + 1 });
  const { order } = await h.reserve(buyer, { copyIds: [copy], classIds: [cls] });
  const { rows: bookLine } = await h.pool.query("SELECT id FROM order_items WHERE order_id = $1 AND book_copy_id IS NOT NULL", [order.id]);
  const r = await collectReservation(h.pool, order.id, { method: "card", itemIds: [bookLine[0].id] });
  assert.equal(r.outcome, "collected");
  assert.ok(r.newOrderId);
  const rest = await h.order(r.newOrderId);
  assert.equal(rest.status, "reserved");
  assert.equal(new Date(rest.reserved_until).getTime(), new Date(await classEnd(cls)).getTime(), "the seat's deadline is its session");
  // Past the old book deadline nothing happens to it.
  await h.pool.query("UPDATE orders SET reserved_until = now() - interval '1 minute' WHERE id = $1", [rest.id]);
  await expireStaleReservations(h.pool);
  assert.equal((await h.order(rest.id)).status, "reserved");
  assert.equal((await seatOf(rest.id))[0].status, "reserved");
});

test("collecting a seat early leaves the books with their own book deadline", async () => {
  const buyer = await h.account();
  const copy = await h.copy({ price: 5 });
  const cls = await h.session({ startsInHours: DAY_HOURS * 2, endsInHours: DAY_HOURS * 2 + 1 });
  const { order } = await h.reserve(buyer, { copyIds: [copy], classIds: [cls] });
  const { rows: seatLine } = await h.pool.query("SELECT id FROM order_items WHERE order_id = $1 AND class_dropin_seat_id IS NOT NULL", [order.id]);
  const r = await collectReservation(h.pool, order.id, { method: "card", itemIds: [seatLine[0].id] });
  assert.equal(r.outcome, "collected");
  assert.equal(new Date((await h.order(r.newOrderId)).reserved_until).getTime(), new Date(order.reserved_until).getTime());
});

test("rescheduling a session on the admin form moves the deadline of the reservations holding only its seats", async () => {
  const buyer = await h.account();
  const cls = await h.session({ startsInHours: 2, endsInHours: 3, capacity: 5, price: 8, title: `Moved Session ${h.uniq()}` });
  const { order: seatOnly } = await h.reserve(buyer, { classIds: [cls] });
  const other = await h.account();
  const copy = await h.copy();
  const { order: mixed } = await h.reserve(other, { copyIds: [copy], classIds: [cls] });
  // The 24-hour reminder already went out for the old time.
  await h.pool.query("UPDATE class_dropin_seats SET reminder_sent_at = now() WHERE class_id = $1", [cls]);

  const { rows } = await h.pool.query("SELECT starts_at, ends_at FROM classes WHERE id = $1", [cls]);
  const week = 7 * 24 * 3600 * 1000;
  const newStart = new Date(new Date(rows[0].starts_at).getTime() + week);
  const newEnd = new Date(new Date(rows[0].ends_at).getTime() + week);
  const admin = h.visitor(h.admin);
  const r = await admin.post(`/admin/sessions/${cls}`, {
    title: `Moved Session ${h.uniq()}`, startsAt: localField(newStart), endsAt: localField(newEnd), capacity: "5", dropinPrice: "8",
  });
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const end = await classEnd(cls);
  assert.ok(Math.abs(new Date(end).getTime() - newEnd.getTime()) < 60 * 1000, "the session moved");

  const o = await h.order(seatOnly.id);
  assert.equal(new Date(o.reserved_until).getTime(), new Date(end).getTime(), "the seat-only reservation now ends with the moved session");
  assert.equal(new Date((await h.order(mixed.id)).reserved_until).getTime(), new Date(mixed.reserved_until).getTime(), "a reservation holding books keeps its book deadline");
  const { rows: reminders } = await h.pool.query("SELECT reminder_sent_at FROM class_dropin_seats WHERE class_id = $1", [cls]);
  assert.ok(reminders.every((s) => s.reminder_sent_at === null), "the 24-hour reminder will be sent again for the new time");

  // Past the OLD end time nothing is released.
  await expireStaleReservations(h.pool);
  assert.equal((await h.order(seatOnly.id)).status, "reserved");

  // Saving the form again without changing the time leaves the reminders alone.
  await h.pool.query("UPDATE class_dropin_seats SET reminder_sent_at = now() WHERE class_id = $1", [cls]);
  const { rows: now } = await h.pool.query("SELECT title, starts_at, ends_at FROM classes WHERE id = $1", [cls]);
  await admin.post(`/admin/sessions/${cls}`, {
    title: `${now[0].title} (edited)`, startsAt: localField(new Date(now[0].starts_at)), endsAt: localField(new Date(now[0].ends_at)), capacity: "5", dropinPrice: "8",
  });
  const { rows: still } = await h.pool.query("SELECT reminder_sent_at FROM class_dropin_seats WHERE class_id = $1", [cls]);
  assert.ok(still.every((s) => s.reminder_sent_at !== null), "a title edit does not re-send the reminder");
});
