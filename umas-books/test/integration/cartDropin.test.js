// Drop-in session seats in the public cart (src/routes/cart.js): add-dropin
// (price/capacity/cart-size rules), how the cart page drops lines that are no
// longer sellable, removing a line, RESERVING creating 'reserved' seats + order
// items (alone and mixed with a book), the sold-out path, the empty-cart and
// validation messages, and /api/cart/count.
//
// Complements cartCheckout.test.js (books-only flows). Real routes on the
// reserveHarness: nothing is paid online and HelloAsso is never called (any
// call would throw; the reservation tests assert there was none).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { reserveHarness } = require("../helpers/reserveHarness");

const h = reserveHarness("cart_dropin");
const { pool, uniq } = h;
before(() => h.start());
after(() => h.stop());

// A browser (guest by default; pass an account to be logged in as it) with a cart-count helper.
function visitor(account) {
  const v = h.visitor(account);
  return { ...v, count: async () => JSON.parse((await v.get("/api/cart/count")).text).count };
}

const makeClass = ({ price = 8, capacity = null, title } = {}) => h.session({ price, capacity, title: title || `Dropin ${uniq()}` });
const makeCopy = (price = 6) => h.copy({ price, title: `Mixed Book ${uniq()}` });
const seats = async (classId) => (await pool.query("SELECT * FROM class_dropin_seats WHERE class_id = $1 ORDER BY id", [classId])).rows;
const classTitle = async (id) => (await pool.query("SELECT title FROM classes WHERE id = $1", [id])).rows[0].title;

test("/api/cart/count: 0 for a fresh guest (no session created), then reflects lines added", async () => {
  const v = visitor();
  const first = await v.get("/api/cart/count");
  assert.equal(first.res.headers.get("cache-control"), "no-store");
  assert.equal(JSON.parse(first.text).count, 0);
  assert.equal(first.res.headers.getSetCookie().length, 0, "counting must not create a session");
  const cls = await makeClass();
  await v.post("/cart/add-dropin", { classId: cls });
  await v.post("/cart/add-dropin", { classId: cls });
  assert.equal(await v.count(), 2);
});

test("add-dropin: a priced class goes in the cart (several seats allowed) and shows on /cart with its price and a label", async () => {
  const v = visitor();
  const cls = await makeClass({ price: 8.5, title: `Little Explorers <i>${uniq()}</i>` });
  const r = await v.post("/cart/add-dropin", { classId: cls });
  assert.equal(r.status, 302);
  assert.equal(r.location, "/sessions", "default redirect");
  await v.post("/cart/add-dropin", { classId: cls, backTo: "/sessions?month=2093-01" });
  assert.equal(await v.count(), 2);
  const page = await v.get("/cart");
  assert.equal(page.status, 200);
  assert.equal((page.text.match(/Drop-in seat/g) || []).length, 2);
  assert.match(page.text, /8\.50/);
  assert.match(page.text, /Total: <strong>€17\.00/);
  assert.ok(!page.text.includes("<i>"), "class title escaped");
  assert.equal((await seats(cls)).length, 0, "adding to the cart holds nothing in the database");
});

test("add-dropin: backTo is honoured only for local paths; unknown, unpriced, zero and junk class ids add nothing", async () => {
  const v = visitor();
  const cls = await makeClass();
  assert.equal((await v.post("/cart/add-dropin", { classId: cls, backTo: "/sessions?x=1" })).location, "/sessions?x=1");
  for (const evil of ["//evil.example", "/\\evil.example", "https://evil.example"]) {
    assert.equal((await v.post("/cart/add-dropin", { classId: cls, backTo: evil })).location, "/sessions", evil);
  }
  const before = await v.count();
  const { rows } = await pool.query("INSERT INTO classes (title, starts_at) VALUES ($1, now() + interval '1 day') RETURNING id", [`Info only ${uniq()}`]);
  for (const classId of [rows[0].id, 99999999, 0, "abc", ""]) await v.post("/cart/add-dropin", { classId });
  assert.equal(await v.count(), before);
});

test("add-dropin: stops at the seats left, counting sold and in-cart seats and what's already in this cart", async () => {
  const cls = await makeClass({ capacity: 3 });
  await pool.query("INSERT INTO class_dropin_seats (class_id, status) VALUES ($1, 'sold')", [cls]);
  const v = visitor();
  for (let i = 0; i < 4; i++) await v.post("/cart/add-dropin", { classId: cls });
  assert.equal(await v.count(), 2, "3 capacity - 1 sold = 2 seats");

  const full = await makeClass({ capacity: 1 });
  await pool.query("INSERT INTO class_dropin_seats (class_id, status) VALUES ($1, 'in_cart')", [full]);
  const w = visitor();
  await w.post("/cart/add-dropin", { classId: full });
  assert.equal(await w.count(), 0, "an in-cart hold by someone else also takes the seat");

  const reserved = await makeClass({ capacity: 1 });
  await pool.query("INSERT INTO class_dropin_seats (class_id, status) VALUES ($1, 'reserved')", [reserved]);
  const x = visitor();
  await x.post("/cart/add-dropin", { classId: reserved });
  assert.equal(await x.count(), 0, "a seat reserved by someone else takes the seat too");
});

test("add-dropin: a cart holds at most 20 lines", async () => {
  const cls = await makeClass();
  const v = visitor();
  for (let i = 0; i < 23; i++) await v.post("/cart/add-dropin", { classId: cls });
  assert.equal(await v.count(), 20);
});

test("cart page drops drop-in lines that stopped being sellable (price removed, class full, class deleted)", async () => {
  const v = visitor();
  const gonePrice = await makeClass();
  const filled = await makeClass({ capacity: 2 });
  const deleted = await makeClass();
  const stays = await makeClass();
  for (const id of [gonePrice, filled, deleted, stays]) await v.post("/cart/add-dropin", { classId: id });
  await v.post("/cart/add-dropin", { classId: filled });
  assert.equal(await v.count(), 5);

  await pool.query("UPDATE classes SET dropin_price = NULL WHERE id = $1", [gonePrice]);
  await pool.query("INSERT INTO class_dropin_seats (class_id, status) VALUES ($1, 'sold')", [filled]); // 1 left, cart holds 2
  await pool.query("DELETE FROM classes WHERE id = $1", [deleted]);
  const page = await v.get("/cart");
  assert.equal((page.text.match(/Drop-in seat/g) || []).length, 2, "stays + one of the two 'filled' seats");
  assert.ok(page.text.includes(await classTitle(stays)));
  assert.equal(await v.count(), 2, "the session cart was pruned to match");
});

test("remove: deletes just that drop-in line and a lineId that isn't in the cart is harmless", async () => {
  const v = visitor();
  const a = await makeClass();
  const b = await makeClass();
  await v.post("/cart/add-dropin", { classId: a });
  await v.post("/cart/add-dropin", { classId: b });
  const ids = [...(await v.get("/cart")).text.matchAll(/name="lineId" value="(\d+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 2);
  const r = await v.post("/cart/remove", { lineId: ids[0] });
  assert.equal(r.location, "/cart");
  assert.equal(await v.count(), 1);
  await v.post("/cart/remove", { lineId: "99999" });
  await v.post("/cart/remove", { lineId: "abc" });
  assert.equal(await v.count(), 1);
  assert.ok((await v.get("/cart")).text.includes(await classTitle(b)));
});

test("reserving an empty cart re-renders the cart with an error and creates no order", async () => {
  const account = await h.account();
  const v = visitor(account);
  const r = await v.post("/cart/reserve", { acceptCgv: "on", name: "Nobody" });
  assert.equal(r.status, 200);
  assert.match(r.text, /Your cart is empty/);
  assert.equal((await h.ordersOf(account)).length, 0);
});

test("reserve validation: no name anywhere shows a message and holds nothing; a posted email is ignored", async () => {
  const account = await h.account({ displayName: "" });
  const v = visitor(account);
  const cls = await makeClass({ capacity: 5 });
  await v.post("/cart/add-dropin", { classId: cls });
  const r = await v.post("/cart/reserve", { name: "", acceptCgv: "on", email: "someone-else@example.test" });
  assert.match(r.text, /Please enter your name\./);
  assert.equal((await seats(cls)).length, 0);
  assert.equal((await h.ordersOf(account)).length, 0);
});

test("reserving without the terms box is refused for a drop-in seat too, and holds nothing (no withdrawal-waiver box exists any more)", async () => {
  const account = await h.account();
  const v = visitor(account);
  const cls = await makeClass({ capacity: 5 });
  await v.post("/cart/add-dropin", { classId: cls });
  const page = (await v.get("/cart")).text;
  assert.doesNotMatch(page, /waiveWithdrawal/);
  const r = await v.post("/cart/reserve", { name: "Pat", acceptCgv: "" });
  assert.match(r.text, /accept the terms of sale/);
  assert.equal((await seats(cls)).length, 0);
});

test("reserve: drop-in seats become 'reserved' rows tied to one order, with labelled order items and the right total; nothing is paid or asked of HelloAsso", async () => {
  const account = await h.account({ email: `Seat-${uniq()}@Example.TEST` });
  const v = visitor(account);
  const cls = await makeClass({ price: 8.5, capacity: 5, title: `Readers ${uniq()}` });
  await v.post("/cart/add-dropin", { classId: cls });
  await v.post("/cart/add-dropin", { classId: cls });
  const r = await v.post("/cart/reserve", { acceptCgv: "on", name: "Seat Buyer", phone: "0600000000" });
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/cart\/return\?order=[0-9a-f-]{36}$/);
  assert.equal(await v.count(), 0, "cart emptied once the seats are held");

  const orders = await h.ordersOf(account);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].buyer_email, account.email);
  assert.equal(Number(orders[0].total_amount), 17);
  assert.equal(orders[0].status, "reserved");
  assert.equal(orders[0].paid_at, null);
  assert.equal(orders[0].withdrawal_waiver_at, null, "no waiver is asked: nothing is paid online");
  const held = await seats(cls);
  assert.equal(held.length, 2);
  assert.ok(held.every((s) => s.status === "reserved" && s.order_id === orders[0].id));
  const { rows: items } = await pool.query("SELECT * FROM order_items WHERE order_id = $1", [orders[0].id]);
  assert.equal(items.length, 2);
  const title = await classTitle(cls);
  assert.ok(items.every((i) => i.item_title.startsWith(`${title} — `) && Number(i.price) === 8.5 && i.class_dropin_seat_id));
  assert.deepEqual(h.helloassoCalls, [], "HelloAsso was never called");
});

test("reserving a mixed cart holds the book copy and creates the seat in one order", async () => {
  const account = await h.account();
  const v = visitor(account);
  const cls = await makeClass({ price: 5, capacity: 3 });
  const copy = await makeCopy(6);
  await v.post("/cart/add", { copyId: copy });
  await v.post("/cart/add-dropin", { classId: cls });
  const r = await v.post("/cart/reserve", { acceptCgv: "on", name: "Mixed Buyer" });
  assert.equal(r.status, 302);
  const [order] = await h.ordersOf(account);
  assert.equal(Number(order.total_amount), 11);
  assert.equal(await h.copyStatus(copy), "reserved");
  assert.equal((await seats(cls)).length, 1);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM order_items WHERE order_id = $1", [order.id])).rows[0].n, 2);
});

test("reserve: a seat sold elsewhere after it was carted is pruned, so only what is still free is reserved", async () => {
  const account = await h.account();
  const v = visitor(account);
  const cls = await makeClass({ price: 5, capacity: 2 });
  await v.post("/cart/add-dropin", { classId: cls });
  await v.post("/cart/add-dropin", { classId: cls });
  // Both seats were in this cart; before reserving, one is bought elsewhere: the
  // pre-check prunes it, so the cart shrinks to the one seat still free and the
  // reservation proceeds for that one rather than overselling.
  await pool.query("INSERT INTO class_dropin_seats (class_id, status) VALUES ($1, 'sold')", [cls]);
  const r = await v.post("/cart/reserve", { acceptCgv: "on", name: "Late Buyer" });
  assert.equal(r.status, 302);
  const [order] = await h.ordersOf(account);
  assert.equal(Number(order.total_amount), 5, "one seat, not two");
  assert.equal((await seats(cls)).filter((s) => s.status === "reserved").length, 1);
  assert.equal((await seats(cls)).length, 2, "never more seats than capacity");
});

test("reserve: when the last seat is taken after the cart check, the buyer is told and nothing is held or ordered", async () => {
  const account = await h.account();
  const v = visitor(account);
  const cls = await makeClass({ price: 5, capacity: 1 });
  await v.post("/cart/add-dropin", { classId: cls });
  // Make the pre-check see a free seat but the locked re-check see none: steal the
  // seat right after the cart's availability read, before the order transaction.
  const original = pool.query.bind(pool);
  let armed = true;
  pool.query = async (...args) => {
    const result = await original(...args);
    // After the cart's availability read (a SELECT from classes), steal the seat.
    if (armed && typeof args[0] === "string" && /FROM classes c WHERE c\.id = ANY/.test(args[0])) {
      armed = false;
      await original("INSERT INTO class_dropin_seats (class_id, status) VALUES ($1, 'sold')", [cls]);
    }
    return result;
  };
  let r;
  try {
    r = await v.post("/cart/reserve", { acceptCgv: "on", name: "Race Buyer" });
  } finally {
    pool.query = original;
  }
  assert.equal(r.status, 200);
  assert.match(r.text, /something in your cart was just taken by someone else/);
  assert.equal((await h.ordersOf(account)).length, 0, "order rolled back");
  assert.equal((await seats(cls)).filter((s) => s.status === "reserved").length, 0);
  assert.equal(await v.count(), 0, "the no-longer-available seat was dropped from the cart");
});

test("a seat reserved by one account counts against capacity for everyone: the last seat can only be reserved once", async () => {
  const cls = await makeClass({ price: 5, capacity: 1 });
  const [a, b] = [await h.account(), await h.account()];
  assert.equal((await h.reserve(a, { classIds: [cls] })).order.status, "reserved");
  const v = visitor(b);
  await v.post("/cart/add-dropin", { classId: cls });
  assert.equal(await v.count(), 0, "full: not even added to the cart");
  assert.equal((await seats(cls)).length, 1);
});
