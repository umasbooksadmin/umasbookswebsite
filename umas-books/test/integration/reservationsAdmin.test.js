// What the staff do with a reservation, in /admin/orders (customers pay IN THE SHOP):
//  - "Mark collected and paid": one transaction (order paid at paid_at, how it was
//    paid, books and seats sold, collected_at/by, audit), amount only lowerable
//    with a note, repeat-safe, race-safe;
//  - "Collect selected items": a partial pickup moves the rest to a new reservation;
//  - extend (once), cancel, no-show; mark refunded still works after a pickup;
//  - the lists (default view, filters), the pickup list, the report, the dashboard;
//  - the shop's own "Sell in shop" refuses a copy that an order holds;
//  - nothing in any of it talks to HelloAsso.
// Real database, own throwaway database (see test/helpers/reserveHarness.js).

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { reserveHarness } = require("../helpers/reserveHarness");
const h = reserveHarness("reservations_admin");
const { salesStats, attentionCounts } = require("../../src/lib/dashboardStats");
let admin;
before(async () => { await h.start(); });
after(() => h.stop());
beforeEach(() => { h.sent.length = 0; admin = h.visitor(h.admin); });

const copyRow = async (id) => (await h.pool.query("SELECT status, cart_order_id, reserved_by_email FROM book_copies WHERE id = $1", [id])).rows[0];
const seatRow = async (id) => (await h.pool.query("SELECT status, order_id FROM class_dropin_seats WHERE id = $1", [id])).rows[0];
const items = async (orderId) => (await h.pool.query(
  "SELECT id, book_copy_id, class_dropin_seat_id, price FROM order_items WHERE order_id = $1 ORDER BY id", [orderId])).rows;
const collect = (id, fields = {}) => admin.post(`/admin/orders/${id}/collect`, { method: "cash", ...fields });

test("mark collected and paid: order paid now, method and amount kept, books sold, collected by the admin, audited, counted as revenue today", async () => {
  const buyer = await h.account();
  const a = await h.copy({ price: 6 });
  const b = await h.copy({ price: 4.5 });
  const { order } = await h.reserve(buyer, { copyIds: [a, b] });
  const statsBefore = await salesStats(h.pool);

  const r = await collect(order.id, { method: "card", amountReceived: "10.50" });
  assert.equal(r.status, 302);
  assert.match(r.location, /notice=collected-paid/);

  const after = await h.order(order.id);
  assert.equal(after.status, "paid");
  assert.ok(Math.abs(Date.now() - new Date(after.paid_at).getTime()) < 60000, "paid_at is now");
  assert.equal(after.payment_method, "card");
  assert.equal(Number(after.amount_received), 10.5);
  assert.equal(Number(after.total_amount), 10.5);
  assert.equal(after.reserved_total, null, "nothing was discounted");
  assert.equal(after.collected_by, h.admin.id);
  assert.ok(after.collected_at);
  for (const id of [a, b]) {
    const c = await copyRow(id);
    assert.equal(c.status, "sold");
    assert.equal(c.cart_order_id, null);
    assert.equal(c.reserved_by_email, null);
  }
  const log = await h.audit(order.id);
  assert.equal(log.length, 1);
  assert.equal(log[0].action, "order.collected_paid");
  assert.match(log[0].detail, /card, €10\.50 of €10\.50, 2 item/);

  const statsAfter = await salesStats(h.pool);
  assert.equal(statsAfter.ordersToday, statsBefore.ordersToday + 1, "revenue is counted at paid_at, today");
  assert.equal(Number((statsAfter.salesToday - statsBefore.salesToday).toFixed(2)), 10.5);

  // The customer's reservation page now says collected.
  const page = await h.visitor().get(`/cart/return?order=${order.access_token}`);
  assert.match(page.text, /collected/i);
  assert.deepEqual(h.helloassoCalls, []);
});

test("a reservation is NOT revenue until it is collected and paid; cancelled or expired ones never are", async () => {
  const before = await salesStats(h.pool);
  const buyer = await h.account();
  const { order } = await h.reserve(buyer, { copyIds: [await h.copy({ price: 20 })] });
  const mid = await salesStats(h.pool);
  assert.equal(mid.salesToday, before.salesToday, "reserved, not paid");
  await admin.post(`/admin/orders/${order.id}/cancel-reservation`);
  const end = await salesStats(h.pool);
  assert.equal(end.salesToday, before.salesToday, "cancelled, never paid");
});

test("collecting needs a payment method; the amount can only be lowered, and then a note is required; refusals change nothing", async () => {
  const buyer = await h.account();
  const copy = await h.copy({ price: 8 });
  const { order } = await h.reserve(buyer, { copyIds: [copy] });

  const noMethod = await admin.post(`/admin/orders/${order.id}/collect`, { amountReceived: "8" });
  assert.equal(noMethod.status, 400);
  assert.match(noMethod.text, /Choose how the customer paid/);
  const weird = await collect(order.id, { amountReceived: "abc" });
  assert.equal(weird.status, 400);
  assert.match(weird.text, /number of euros/);
  const tooHigh = await collect(order.id, { amountReceived: "9" });
  assert.equal(tooHigh.status, 400);
  assert.match(tooHigh.text, /cannot be more than the total/);
  const noNote = await collect(order.id, { amountReceived: "7" });
  assert.equal(noNote.status, 400);
  assert.match(noNote.text, /write a note/);
  const badMethod = await collect(order.id, { method: "bitcoin" });
  assert.equal(badMethod.status, 400);
  assert.equal((await h.order(order.id)).status, "reserved");
  assert.equal((await copyRow(copy)).status, "reserved");
  assert.deepEqual(await h.audit(order.id), []);

  const ok = await collect(order.id, { method: "cheque", amountReceived: "7", note: "Loyal customer discount" });
  assert.equal(ok.status, 302);
  const after = await h.order(order.id);
  assert.equal(after.status, "paid");
  assert.equal(Number(after.amount_received), 7);
  assert.equal(Number(after.total_amount), 7, "revenue is what was received");
  assert.equal(Number(after.reserved_total), 8, "the reserved total is kept");
  assert.equal(after.payment_note, "Loyal customer discount");
  assert.equal(after.payment_method, "cheque");
});

test("collecting twice (a double click, or two staff) pays once", async () => {
  const buyer = await h.account();
  const copy = await h.copy({ price: 5 });
  const { order } = await h.reserve(buyer, { copyIds: [copy] });
  const before = await salesStats(h.pool);
  const [x, y] = await Promise.all([collect(order.id), h.visitor(h.admin).post(`/admin/orders/${order.id}/collect`, { method: "cash" })]);
  const outcomes = [x, y].map((r) => r.location);
  assert.equal(outcomes.filter((l) => /collected-paid/.test(l)).length, 1, "one wins");
  assert.equal(outcomes.filter((l) => /not-reserved/.test(l)).length, 1, "the other is told it is no longer a reservation");
  const after = await salesStats(h.pool);
  assert.equal(after.ordersToday, before.ordersToday + 1);
  assert.equal((await h.audit(order.id)).length, 1);
});

test("collect racing a customer cancel: exactly one happens, the books are never both sold and released", async () => {
  const buyer = await h.account();
  const copy = await h.copy({ price: 5 });
  const { order, v } = await h.reserve(buyer, { copyIds: [copy] });
  await Promise.all([collect(order.id), v.post(`/cart/reservations/${order.id}/cancel`)]);
  const o = await h.order(order.id);
  const c = await copyRow(copy);
  assert.ok((o.status === "paid" && c.status === "sold") || (o.status === "cancelled" && c.status === "in_stock"), `consistent: order ${o.status}, copy ${c.status}`);
});

test("partial pickup: the ticked items are sold and paid, the rest moves to a new reservation with the same deadline; totals are recomputed and nothing is counted twice", async () => {
  const buyer = await h.account();
  const classId = await h.session({ capacity: 4, price: 9 });
  const [a, b, c] = [await h.copy({ price: 6 }), await h.copy({ price: 4 }), await h.copy({ price: 3 })];
  const { order } = await h.reserve(buyer, { copyIds: [a, b, c], classIds: [classId] });
  assert.equal(Number(order.total_amount), 22);
  const its = await items(order.id);
  const byCopy = (id) => its.find((i) => i.book_copy_id === id);
  const before = await salesStats(h.pool);

  const none = await admin.post(`/admin/orders/${order.id}/collect-selected`, { method: "cash" });
  assert.equal(none.status, 400);
  assert.match(none.text, /nothing to collect/);

  const r = await admin.post(`/admin/orders/${order.id}/collect-selected`, { method: "cash", itemIds: [byCopy(a).id, byCopy(b).id] });
  assert.match(r.location, /collected-partial/);

  const paid = await h.order(order.id);
  assert.equal(paid.status, "paid");
  assert.equal(Number(paid.total_amount), 10, "only what was taken");
  assert.equal((await copyRow(a)).status, "sold");
  assert.equal((await copyRow(b)).status, "sold");
  const rest = (await h.pool.query("SELECT * FROM orders WHERE split_from_order_id = $1", [order.id])).rows;
  assert.equal(rest.length, 1, "a new reservation for the rest");
  const child = rest[0];
  assert.equal(child.status, "reserved");
  assert.equal(Number(child.total_amount), 12, "book 3 + seat 9");
  assert.equal(child.user_id, buyer.id);
  assert.equal(new Date(child.reserved_until).getTime(), new Date(order.reserved_until).getTime(), "same deadline");
  assert.equal((await copyRow(c)).status, "reserved");
  assert.equal((await copyRow(c)).cart_order_id, child.id);
  assert.equal((await h.pool.query("SELECT order_id FROM class_dropin_seats WHERE class_id = $1", [classId])).rows[0].order_id, child.id);
  assert.equal((await items(order.id)).length, 2);
  assert.equal((await items(child.id)).length, 2);
  const mid = await salesStats(h.pool);
  assert.equal(Number((mid.salesToday - before.salesToday).toFixed(2)), 10);

  // The rest is collected later: paid in full, no double counting, no more splitting.
  const last = await collect(child.id, { method: "card" });
  assert.match(last.location, /collected-paid/);
  assert.equal((await copyRow(c)).status, "sold");
  assert.equal((await seatRow((await items(child.id)).find((i) => i.class_dropin_seat_id).class_dropin_seat_id)).status, "sold");
  const end = await salesStats(h.pool);
  assert.equal(Number((end.salesToday - before.salesToday).toFixed(2)), 22);
  assert.equal(end.ordersToday, before.ordersToday + 2);
});

test("an item that is no longer held (its book was sold elsewhere) is dropped from the order when it is collected, not charged", async () => {
  const buyer = await h.account();
  const [a, b] = [await h.copy({ price: 6 }), await h.copy({ price: 4 })];
  const { order } = await h.reserve(buyer, { copyIds: [a, b] });
  await h.pool.query("UPDATE book_copies SET status = 'sold', cart_order_id = NULL WHERE id = $1", [b]);
  const r = await collect(order.id);
  assert.match(r.location, /collected-paid/);
  const paid = await h.order(order.id);
  assert.equal(Number(paid.total_amount), 6, "only the held book");
  assert.equal((await items(order.id)).length, 1);
  assert.match((await h.audit(order.id))[0].detail, /dropped 1 no longer held/);
});

test("extend by 7 days: once only; a seat-only reservation cannot be extended", async () => {
  const buyer = await h.account();
  const { order } = await h.reserve(buyer, { copyIds: [await h.copy()] });
  const r = await admin.post(`/admin/orders/${order.id}/extend`);
  assert.match(r.location, /notice=reservation-extended/);
  const after = await h.order(order.id);
  assert.equal(Math.round((new Date(after.reserved_until) - new Date(order.reserved_until)) / 86400000), 7);
  assert.ok(after.reservation_extended_at);
  const again = await admin.post(`/admin/orders/${order.id}/extend`);
  assert.equal(again.status, 409);
  assert.match(again.text, /already extended once/);
  assert.equal(new Date((await h.order(order.id)).reserved_until).getTime(), new Date(after.reserved_until).getTime());
  assert.equal((await h.audit(order.id)).filter((a) => a.action === "order.reservation_extended").length, 1);

  const seatOnly = (await h.reserve(await h.account(), { classIds: [await h.session()] })).order;
  const refused = await admin.post(`/admin/orders/${seatOnly.id}/extend`);
  assert.equal(refused.status, 409);
  assert.match(refused.text, /held until its session/);
});

test("cancel reservation (admin): books back in stock, seats released, audited; no-show does the same and is recorded as such", async () => {
  const buyer = await h.account();
  const classId = await h.session();
  const copy = await h.copy();
  const { order } = await h.reserve(buyer, { copyIds: [copy], classIds: [classId] });
  const seatId = (await items(order.id)).find((i) => i.class_dropin_seat_id).class_dropin_seat_id;

  const r = await admin.post(`/admin/orders/${order.id}/cancel-reservation`);
  assert.match(r.location, /notice=reservation-cancelled/);
  const after = await h.order(order.id);
  assert.equal(after.status, "cancelled");
  assert.equal(after.release_reason, "admin");
  assert.equal((await copyRow(copy)).status, "in_stock");
  assert.equal((await seatRow(seatId)).status, "released");
  assert.equal((await h.audit(order.id))[0].action, "order.reservation_cancelled");
  assert.match((await admin.post(`/admin/orders/${order.id}/cancel-reservation`)).location, /not-reserved/, "second press changes nothing");

  const { order: o2 } = await h.reserve(buyer, { copyIds: [copy] });
  const ns = await admin.post(`/admin/orders/${o2.id}/no-show`);
  assert.match(ns.location, /notice=reservation-expired/);
  const after2 = await h.order(o2.id);
  assert.equal(after2.status, "expired");
  assert.equal(after2.release_reason, "no_show");
  assert.equal((await copyRow(copy)).status, "in_stock");
  assert.equal((await h.audit(o2.id))[0].action, "order.reservation_no_show");
});

test("mark refunded still works after a pickup: books back in stock, out of revenue, no HelloAsso wording", async () => {
  const buyer = await h.account();
  const copy = await h.copy({ price: 9 });
  const { order } = await h.reserve(buyer, { copyIds: [copy] });
  await collect(order.id, { method: "cash" });
  const before = await salesStats(h.pool);

  const form = await admin.get(`/admin/orders/${order.id}/refund`);
  assert.equal(form.status, 200);
  assert.doesNotMatch(form.text, /HelloAsso/);
  assert.match(form.text, /gave the money back/);
  const noTick = await admin.post(`/admin/orders/${order.id}/refund`, { note: "Customer returned the book" });
  assert.equal(noTick.status, 400);
  assert.equal((await h.order(order.id)).status, "paid");
  const r = await admin.post(`/admin/orders/${order.id}/refund`, { confirmRefunded: "on", note: "Refunded in cash at the shop" });
  assert.match(r.location, /notice=refunded/);
  assert.equal((await h.order(order.id)).status, "refunded");
  assert.equal((await copyRow(copy)).status, "in_stock");
  const after = await salesStats(h.pool);
  assert.equal(Number((before.salesToday - after.salesToday).toFixed(2)), 9, "no longer revenue");
});

test("/admin/orders: the default view is 'Reserved: awaiting pickup', with the 'Expiring in 3 days' and 'Expired' filters", async () => {
  const buyer = await h.account({ displayName: "List Person" });
  const soon = (await h.reserve(buyer, { copyIds: [await h.copy({ title: `Soon Book ${h.uniq()}` })] })).order;
  await h.pool.query("UPDATE orders SET reserved_until = now() + interval '2 days' WHERE id = $1", [soon.id]);
  const later = (await h.reserve(buyer, { copyIds: [await h.copy({ title: `Later Book ${h.uniq()}` })] })).order;
  const gone = (await h.reserve(buyer, { copyIds: [await h.copy({ title: `Gone Book ${h.uniq()}` })] })).order;
  await h.pool.query("UPDATE orders SET reserved_until = now() - interval '1 hour' WHERE id = $1", [gone.id]);

  const def = (await admin.get("/admin/orders")).text;
  assert.match(def, /Reserved: awaiting pickup/);
  assert.match(def, new RegExp(`Reservation #${soon.id}<`));
  assert.match(def, new RegExp(`Reservation #${later.id}<`));
  assert.doesNotMatch(def, new RegExp(`Reservation #${gone.id}<`), "expired ones are released as the list is read");
  assert.equal((await h.order(gone.id)).status, "expired");

  const expiring = (await admin.get("/admin/orders?show=expiring_soon")).text;
  assert.match(expiring, new RegExp(`Reservation #${soon.id}<`));
  assert.doesNotMatch(expiring, new RegExp(`Reservation #${later.id}<`));
  assert.match(expiring, /Expiring in 3 days/);
  const expired = (await admin.get("/admin/orders?show=expired")).text;
  assert.match(expired, new RegExp(`Reservation #${gone.id}<`));
  const all = (await admin.get("/admin/orders?show=all")).text;
  for (const o of [soon, later, gone]) assert.match(all, new RegExp(`Reservation #${o.id}<`));
});

test("the order page shows the held items, the deadline and every action; a collected order shows its payment", async () => {
  const buyer = await h.account();
  const [a, b] = [await h.copy({ price: 6, location: "B3" }), await h.copy({ price: 4 })];
  const { order } = await h.reserve(buyer, { copyIds: [a, b] });
  const page = (await admin.get(`/admin/orders/${order.id}`)).text;
  for (const text of ["Reserved: awaiting pickup", "Mark collected and paid", "Collect selected items", "Cancel reservation", "Extend by 7 days", "Mark no-show / expired", "Cash", "Card at the shop", "Cheque", "Other", "shelf B3", "Books held until the end of", "Nothing was paid online"]) {
    assert.ok(page.includes(text), text);
  }
  assert.doesNotMatch(page, /HelloAsso/);
  await collect(order.id, { method: "cheque" });
  const done = (await admin.get(`/admin/orders/${order.id}`)).text;
  assert.match(done, /Paid in the shop on .* by <strong>Cheque<\/strong>/);
  assert.doesNotMatch(done, /Mark collected and paid/);
});

test("the printable pickup list: reservations by customer with each book's shelf and the total to collect", async () => {
  const buyer = await h.account({ displayName: "Zed Pickup" });
  const [a, b] = [await h.copy({ price: 6, title: `Pick Alpha ${h.uniq()}`, location: "SHELF-A9" }), await h.copy({ price: 4, title: `Pick Beta ${h.uniq()}` })];
  const { order } = await h.reserve(buyer, { copyIds: [a, b], name: "Zed Pickup" });
  const page = await admin.get("/admin/orders/pickup-list");
  assert.equal(page.status, 200);
  assert.match(page.text, /Zed Pickup/);
  assert.match(page.text, /SHELF-A9/);
  assert.match(page.text, /shelf not recorded/);
  assert.match(page.text, /To collect: &euro;10\.00/);
  assert.match(page.text, new RegExp(`Reservation #${order.id}`));
  const print = await admin.get("/admin/orders/pickup-list?print=1");
  assert.match(print.text, /pickup-list-print/);
  // Not for the public.
  assert.notEqual((await h.visitor().get("/admin/orders/pickup-list")).status, 200);
  // Once collected it leaves the list.
  await collect(order.id);
  assert.doesNotMatch((await admin.get("/admin/orders/pickup-list")).text, /SHELF-A9/);
});

test("the Reservations report: counts by outcome and the conversion rate, no names or emails; CSV downloads", async () => {
  const buyer = await h.account({ displayName: "Report Person" });
  const make = async () => (await h.reserve(buyer, { copyIds: [await h.copy()] })).order;
  const collected = await make();
  await collect(collected.id);
  const cancelled = await make();
  await admin.post(`/admin/orders/${cancelled.id}/cancel-reservation`);
  const expired = await make();
  await admin.post(`/admin/orders/${expired.id}/no-show`);
  await make(); // still open
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
  const page = await admin.get(`/admin/reports/reservations?from=${day}&to=${day}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Reservations by month/);
  assert.doesNotMatch(page.text, new RegExp(buyer.email));
  const csv = (await admin.get(`/admin/reports/reservations.csv?from=${day}&to=${day}`)).text;
  const lines = csv.trim().split("\r\n");
  assert.match(lines[0], /Month","Reserved","Collected \(sold\)","Expired \/ no-show","Cancelled","Still open","Value collected","Conversion/);
  const total = lines[lines.length - 1].split(",");
  assert.equal(total[0], '"Total"');
  assert.ok(Number(total[1]) >= 4 && Number(total[2]) >= 1 && Number(total[3]) >= 1 && Number(total[4]) >= 1 && Number(total[5]) >= 1);
  // conversion = collected / (collected + expired + cancelled)
  const conv = Number(total[7]);
  assert.equal(conv, Number(((100 * Number(total[2])) / (Number(total[2]) + Number(total[3]) + Number(total[4]))).toFixed(1)));
  assert.match((await admin.get("/admin/reports")).text, /href="\/admin\/reports\/reservations"/);
});

test("dashboard 'Needs attention': reservations expiring in 3 days and ones already past the deadline are counted", async () => {
  const base = await attentionCounts(h.pool);
  const buyer = await h.account();
  const soon = (await h.reserve(buyer, { copyIds: [await h.copy()] })).order;
  await h.pool.query("UPDATE orders SET reserved_until = now() + interval '1 day' WHERE id = $1", [soon.id]);
  const late = (await h.reserve(buyer, { copyIds: [await h.copy()] })).order;
  await h.pool.query("UPDATE orders SET reserved_until = now() - interval '2 hours' WHERE id = $1", [late.id]);
  const now = await attentionCounts(h.pool);
  assert.equal(now.expiring_soon, base.expiring_soon + 1);
  assert.equal(now.past_deadline, base.past_deadline + 1);
  const html = (await admin.get("/admin")).text;
  assert.match(html, /reservation(s)? expiring in 3 days/);
  assert.match(html, /past the deadline/);
});

test("the retired 'Sell in shop' page sells nothing (a reserved copy stays reserved), and the copy page says where to go instead", async () => {
  const buyer = await h.account();
  const copy = await h.copy({ price: 7 });
  const { order } = await h.reserve(buyer, { copyIds: [copy] });
  const r = await admin.post("/admin/inventory/sell", { copyId: String(copy), price: "7", payment: "cash" });
  assert.equal(r.status, 302);
  assert.equal(r.location, "/admin/till?notice=sell-retired");
  assert.equal((await copyRow(copy)).status, "reserved");
  assert.equal((await h.order(order.id)).status, "reserved");

  const { rows: [{ book_id: bookId }] } = await h.pool.query("SELECT book_id FROM book_copies WHERE id = $1", [copy]);
  const cancel = await admin.post(`/admin/inventory/${bookId}/copies/${copy}/cancel-reservation`);
  assert.equal(cancel.status, 409);
  assert.match(cancel.text, new RegExp(`reserved by reservation #${order.id}`));
  assert.equal((await copyRow(copy)).status, "reserved");
  const shown = (await admin.get(`/admin/inventory/${bookId}`)).text;
  assert.match(shown, new RegExp(`href="/admin/orders/${order.id}"`));
});

test("an erased account's open reservations are cancelled: books back in stock, seats freed", async () => {
  const { eraseMember } = require("../../src/lib/privacy");
  const buyer = await h.account();
  const classId = await h.session();
  const copy = await h.copy();
  const { order } = await h.reserve(buyer, { copyIds: [copy], classIds: [classId] });
  await eraseMember(h.pool, buyer.id);
  const after = await h.order(order.id);
  assert.equal(after.status, "cancelled");
  assert.equal(after.release_reason, "account_erased");
  assert.equal((await copyRow(copy)).status, "in_stock");
  const seats = (await h.pool.query("SELECT status FROM class_dropin_seats WHERE order_id = $1", [order.id])).rows;
  assert.deepEqual(seats.map((s) => s.status), ["released"]);
  assert.match(after.buyer_email, /@erased\.invalid$/);
});

test("no HelloAsso call anywhere in the reserve / collect / partial / extend / cancel / refund flows above", () => {
  assert.deepEqual(h.helloassoCalls, []);
});
