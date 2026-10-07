// Collecting an online reservation at the till (lib/tillReservations.js): scan
// ORDER-<n> (or the label of a book a reservation holds), the lines come in at the
// reserved prices, the customer pays cash or card, and the order is paid by the
// SAME function as the admin's "Mark collected and paid" (partial pickups and
// drop-in seats included). Real app, real database.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { tillHarness } = require("../helpers/tillHarness");

let h;
let cart;
before(async () => {
  h = await tillHarness({ port: 4205, ip: "10.80.5.5" });
  cart = require("../../src/lib/cart");
});
after(async () => { await h.stop(); });

async function account() {
  const { rows } = await h.pool.query(
    "INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, 'x', 'Till Reserver', now()) RETURNING id, email",
    [`till-res-${h.uniq()}@example.test`]
  );
  return rows[0];
}
// A real reservation (the same function the cart uses): books by price, optional seat.
async function reserve({ prices = [6], seat = null, user = null } = {}) {
  const u = user || await account();
  const items = [];
  const copyIds = [];
  for (const price of prices) {
    const book = await h.seedBook(`Till Reserved ${h.uniq()}`);
    const copy = await h.seedCopy(book.id, { price, location: "R7" });
    copyIds.push(copy);
    items.push({ kind: "book", copyId: copy, title: `Till Reserved ${copy}`, price });
  }
  let classId = null;
  if (seat) {
    classId = (await h.pool.query("INSERT INTO classes (title, starts_at, capacity, dropin_price) VALUES ($1, now() + interval '5 days', 4, $2) RETURNING id", [`Till Seat ${h.uniq()}`, seat])).rows[0].id;
    items.push({ kind: "dropin", classId, title: "Till Seat", startsAt: new Date(Date.now() + 5 * 86400000), price: seat });
  }
  const order = await cart.createReservation(h.pool, { user: u, name: "Till Reserver", items, acceptedVersion: "v", hasDropin: false });
  const lines = (await h.pool.query("SELECT id, book_copy_id, class_dropin_seat_id, price FROM order_items WHERE order_id = $1 ORDER BY id", [order.id])).rows;
  return { order, user: u, copyIds, classId, lines };
}
const orderRow = async (id) => (await h.pool.query("SELECT * FROM orders WHERE id = $1", [id])).rows[0];
const asLines = (order, lines) => lines.map((l) => ({ kind: "reserved", orderId: order.id, itemId: l.id }));

test("scan ORDER-<n>: the reservation's lines come in at the reserved prices (books and seat), with the customer's name", async () => {
  const r = await reserve({ prices: [6, 4.5], seat: 9 });
  const s = await h.scan(`ORDER-${r.order.id}`);
  assert.equal(s.body.type, "reservation");
  assert.equal(s.body.order.id, r.order.id);
  assert.equal(s.body.order.name, "Till Reserver");
  assert.equal(s.body.lines.length, 3);
  assert.deepEqual(s.body.lines.map((l) => l.priceCents), [600, 450, 900]);
  const book = s.body.lines[0];
  assert.equal(book.kind, "book");
  assert.equal(book.reserved, true);
  assert.equal(book.orderId, r.order.id);
  assert.equal(book.location, "R7");
  assert.equal(s.body.lines[2].kind, "seat");
  // lower case, a space or an underscore are fine too
  assert.equal((await h.scan(`order ${r.order.id}`)).body.type, "reservation");
});

test("scanning the label of a book that a reservation holds opens that reservation (no 'reserved for a customer' dead end)", async () => {
  const r = await reserve({ prices: [7, 3] });
  const s = await h.scan(`UB-${r.copyIds[1]}`);
  assert.equal(s.body.type, "reservation");
  assert.equal(s.body.order.id, r.order.id);
  assert.equal(s.body.lines.length, 2);
  // a copy held WITHOUT an order still gets the old message
  const book = await h.seedBook(`Held ${h.uniq()}`);
  const loose = await h.seedCopy(book.id, { status: "reserved" });
  const old = await h.scan(`UB-${loose}`);
  assert.equal(old.body.type, "error");
  assert.match(old.body.message, /reserved for a customer/);
});

test("scanning an order that is not open says why: paid, cancelled, expired, unknown", async () => {
  const paid = await reserve();
  await h.sale(asLines(paid.order, paid.lines));
  assert.match((await h.scan(`ORDER-${paid.order.id}`)).body.message, new RegExp(`Reservation #${paid.order.id} was already collected and paid`));
  const gone = await reserve();
  await require("../../src/lib/reservations").releaseReservation(h.pool, gone.order.id, { status: "cancelled", reason: "admin" });
  assert.match((await h.scan(`ORDER-${gone.order.id}`)).body.message, /was cancelled/);
  const late = await reserve();
  await h.pool.query("UPDATE orders SET reserved_until = now() - interval '1 hour' WHERE id = $1", [late.order.id]);
  assert.match((await h.scan(`ORDER-${late.order.id}`)).body.message, /expired and was released/);
  assert.match((await h.scan("ORDER-999999")).body.message, /No reservation 999999/);
});

test("cash sale of a whole reservation: order paid through the shared collection (method, paid_at, books sold), till rows tagged, no shop_sales row, audited", async () => {
  const r = await reserve({ prices: [6, 4.5], seat: 9 });
  const sale = await h.sale(asLines(r.order, r.lines), { method: "cash", received: "50" });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  assert.equal(sale.body.totalCents, 1950);
  assert.equal(sale.body.changeCents, 3050);

  const o = await orderRow(r.order.id);
  assert.equal(o.status, "paid");
  assert.equal(o.payment_method, "cash");
  assert.equal(Number(o.total_amount), 19.5);
  assert.ok(Math.abs(Date.now() - new Date(o.paid_at).getTime()) < 60000);
  assert.equal(o.collected_by, h.adminId);
  for (const c of r.copyIds) assert.equal((await h.copy(c)).status, "sold");
  assert.equal((await h.pool.query("SELECT status FROM class_dropin_seats WHERE order_id = $1", [r.order.id])).rows[0].status, "sold");

  const items = (await h.pool.query("SELECT kind, copy_id, category, unit_price_cents, reservation_order_id FROM till_sale_items WHERE sale_id = $1 ORDER BY id", [sale.body.saleId])).rows;
  assert.deepEqual(items.map((i) => i.unit_price_cents), [600, 450, 900]);
  assert.ok(items.every((i) => i.reservation_order_id === r.order.id));
  assert.deepEqual(items.map((i) => i.kind), ["book", "book", "manual"]);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM shop_sales WHERE till_sale_id = $1", [sale.body.saleId])).rows[0].n, 0, "the order is the sale: not counted twice");
  const log = (await h.audit("order.collected_paid")).filter((a) => a.target_id === r.order.id);
  assert.equal(log.length, 1);
  assert.match(log[0].detail, /cash at the till/);
});

test("card sale of a reservation records the card method on the order", async () => {
  const r = await reserve({ prices: [8] });
  const sale = await h.sale(asLines(r.order, r.lines), { method: "card" });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  assert.equal((await orderRow(r.order.id)).payment_method, "card");
  assert.equal((await h.pool.query("SELECT payment_method FROM till_sales WHERE id = $1", [sale.body.saleId])).rows[0].payment_method, "card");
});

test("partial collection: only the lines on the sale are sold and paid; the rest stays reserved on a new order with the same deadline", async () => {
  const r = await reserve({ prices: [6, 4, 3], seat: 9 });
  const taken = [r.lines[0], r.lines[1]];
  const sale = await h.sale(asLines(r.order, taken), { method: "cash", received: "10" });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  assert.equal(sale.body.totalCents, 1000);
  const paid = await orderRow(r.order.id);
  assert.equal(paid.status, "paid");
  assert.equal(Number(paid.total_amount), 10);
  const child = (await h.pool.query("SELECT * FROM orders WHERE split_from_order_id = $1", [r.order.id])).rows[0];
  assert.equal(child.status, "reserved");
  assert.equal(Number(child.total_amount), 12);
  assert.equal(new Date(child.reserved_until).getTime(), new Date(r.order.reserved_until).getTime());
  assert.equal((await h.copy(r.copyIds[2])).status, "reserved");
  assert.equal((await h.copy(r.copyIds[2])).cart_order_id, child.id);
  // The rest is then collected at the till through its NEW order number.
  const again = await h.scan(`ORDER-${child.id}`);
  assert.equal(again.body.type, "reservation");
  assert.equal(again.body.lines.length, 2);
});

test("a reservation can be mixed with a walk-in book and a manual item in one sale; each part is recorded the right way", async () => {
  const r = await reserve({ prices: [5] });
  const book = await h.seedBook(`Walk-in ${h.uniq()}`);
  const walkIn = await h.seedCopy(book.id, { price: 3 });
  const items = [...asLines(r.order, r.lines), h.book(walkIn), { kind: "manual", description: "Bookmark", price: "1.50", quantity: 2, category: "merchandise" }];
  const sale = await h.sale(items, { method: "cash", received: "20" });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  assert.equal(sale.body.totalCents, 1100);
  assert.equal((await orderRow(r.order.id)).status, "paid");
  assert.equal(Number((await orderRow(r.order.id)).total_amount), 5, "the order is paid for its own items only");
  assert.equal((await h.copy(walkIn)).status, "sold");
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM shop_sales WHERE till_sale_id = $1", [sale.body.saleId])).rows[0].n, 1, "only the walk-in book is a shop sale");
});

test("a reservation cancelled or collected elsewhere while the sale was being built: refused (409), nothing is sold, no till sale", async () => {
  const r = await reserve({ prices: [6, 4] });
  await require("../../src/lib/reservations").releaseReservation(h.pool, r.order.id, { status: "cancelled", reason: "admin" });
  const before = (await h.pool.query("SELECT count(*)::int AS n FROM till_sales")).rows[0].n;
  const sale = await h.sale(asLines(r.order, r.lines));
  assert.equal(sale.status, 409);
  assert.match(sale.body.error, /no longer open/);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM till_sales")).rows[0].n, before);
  for (const c of r.copyIds) assert.equal((await h.copy(c)).status, "in_stock");

  // One book sold elsewhere (the shop's own Sell in shop): that line is refused, the other is not paid either.
  const q = await reserve({ prices: [6, 4] });
  await h.pool.query("UPDATE book_copies SET status = 'sold', cart_order_id = NULL WHERE id = $1", [q.copyIds[1]]);
  const sale2 = await h.sale(asLines(q.order, q.lines));
  assert.equal(sale2.status, 409);
  assert.equal((await orderRow(q.order.id)).status, "reserved");
  assert.equal((await h.copy(q.copyIds[0])).status, "reserved");
});

test("tampered lines are refused: an item of another order, a made-up item, the same item twice, and a reserved copy sent as a plain book", async () => {
  const a = await reserve({ prices: [6] });
  const b = await reserve({ prices: [4] });
  const wrong = await h.sale([{ kind: "reserved", orderId: a.order.id, itemId: b.lines[0].id }]);
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /does not belong to reservation/);
  const missing = await h.sale([{ kind: "reserved", orderId: a.order.id, itemId: 999999 }]);
  assert.equal(missing.status, 400);
  const twice = await h.sale([...asLines(a.order, a.lines), ...asLines(a.order, a.lines)]);
  assert.equal(twice.status, 400);
  assert.match(twice.body.error, /twice/);
  const plain = await h.sale([h.book(a.copyIds[0])]);
  assert.equal(plain.status, 409);
  assert.match(plain.body.error, /reserved for a customer/);
  assert.equal((await orderRow(a.order.id)).status, "reserved");
  assert.equal((await orderRow(b.order.id)).status, "reserved");
});

test("pressing pay twice (the same sale token) collects the reservation once", async () => {
  const r = await reserve({ prices: [6] });
  const token = h.token();
  const one = await h.sale(asLines(r.order, r.lines), { token });
  const two = await h.sale(asLines(r.order, r.lines), { token });
  assert.equal(one.body.saleId, two.body.saleId);
  assert.equal(two.body.duplicate, true);
  assert.equal((await h.audit("order.collected_paid")).filter((a) => a.target_id === r.order.id).length, 1);
  // Two tills racing on the same reservation with different tokens: one wins.
  const q = await reserve({ prices: [6] });
  const [x, y] = await Promise.all([h.sale(asLines(q.order, q.lines)), h.sale(asLines(q.order, q.lines))]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  assert.equal(Number((await orderRow(q.order.id)).total_amount), 6);
});

test("a till sale that collected a reservation cannot be voided there: it points to Mark refunded; the order stays paid", async () => {
  const r = await reserve({ prices: [6] });
  const sale = await h.sale(asLines(r.order, r.lines));
  const res = await h.post(`/admin/till/sales/${sale.body.saleId}/void`, { reason: "oops" });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get("location")), /collected reservation #\d+: it cannot be voided here/);
  assert.equal((await orderRow(r.order.id)).status, "paid");
  assert.equal((await h.copy(r.copyIds[0])).status, "sold");
  assert.equal((await h.pool.query("SELECT status FROM till_sales WHERE id = $1", [sale.body.saleId])).rows[0].status, "completed");
});

test("the day's totals include the reservation money taken at the till, and the receipt lists its lines", async () => {
  const till = require("../../src/lib/till");
  const { todayParis } = require("../../src/lib/reports");
  const before = await till.daySummary(h.pool, todayParis());
  const r = await reserve({ prices: [6.5] });
  const sale = await h.sale(asLines(r.order, r.lines), { method: "cash", received: "10" });
  const after = await till.daySummary(h.pool, todayParis());
  assert.equal(after.cash.total - before.cash.total, 650);
  const receipt = await h.get(`/admin/till/sales/${sale.body.saleId}/receipt`);
  assert.equal(receipt.res.status, 200);
  assert.match(receipt.text, /Till Reserved/);
});
