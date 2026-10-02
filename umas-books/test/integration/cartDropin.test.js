// Drop-in session seats in the public cart (src/routes/cart.js): add-dropin
// (price/capacity/cart-size rules), how the cart page drops lines that are no
// longer sellable, removing a line, checkout creating in_cart seats + order
// items (alone and mixed with a book), the sold-out path, the empty-cart and
// validation messages, and /api/cart/count.
//
// Complements cartCheckout.test.js (books-only flows). In-process harness
// with HelloAsso stubbed before the routes load, same as that file.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
require("express-async-errors");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");
const { makeCookieJar } = require("../helpers/httpClient");

const db = prepareDatabase("cart_dropin");

const mailer = require("../../src/mailer");
mailer.sendMail = async () => {};

const helloasso = require("../../src/lib/helloasso");
let configured = true;
helloasso.isConfigured = () => configured;
const createdIntents = [];
let seq = 0;
helloasso.createCheckoutIntent = async (args) => {
  createdIntents.push(args);
  const n = ++seq;
  return { id: `dropin-intent-${Date.now()}-${n}`, redirectUrl: `https://pay.example.test/dropin/${n}` };
};

const { pool } = require("../../src/db");
const { checkoutLimiter, cartEditLimiter } = require("../../src/middleware/rateLimits");

let server;
before(async () => {
  db.create();
  server = await listen(buildApp([require("../../src/routes/cart")]));
});
after(async () => {
  await server.close();
  await pool.end();
  db.drop();
});
beforeEach(() => {
  configured = true;
  createdIntents.length = 0;
  checkoutLimiter.resetKey("127.0.0.1");
  cartEditLimiter.resetKey("127.0.0.1");
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function visitor() {
  const jar = makeCookieJar();
  const send = async (path, { method = "GET", form } = {}) => {
    const res = await fetch(`${server.base}${path}`, {
      method,
      redirect: "manual",
      headers: { cookie: jar.header(), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    jar.capture(res);
    return { res, status: res.status, location: res.headers.get("location"), text: await res.text() };
  };
  return {
    get: (p) => send(p),
    post: (p, form) => send(p, { method: "POST", form }),
    count: async () => JSON.parse((await send("/api/cart/count")).text).count,
  };
}

async function makeClass({ price = 8, capacity = null, title } = {}) {
  const { rows } = await pool.query(
    "INSERT INTO classes (title, starts_at, capacity, dropin_price) VALUES ($1, $2, $3, $4) RETURNING id",
    [title || `Dropin ${uniq()}`, new Date(Date.now() + 7 * 86400 * 1000), capacity, price]
  );
  return rows[0].id;
}
async function makeCopy(price = 6) {
  const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'A') RETURNING id", [`Mixed Book ${uniq()}`]);
  const { rows } = await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', $2) RETURNING id", [b[0].id, price]);
  return rows[0].id;
}
const seats = async (classId) => (await pool.query("SELECT * FROM class_dropin_seats WHERE class_id = $1 ORDER BY id", [classId])).rows;
const classTitle = async (id) => (await pool.query("SELECT title FROM classes WHERE id = $1", [id])).rows[0].title;

test("/api/cart/count: 0 for a fresh visitor (no session created), then reflects lines added", async () => {
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
  assert.match(page.text, /Total: <strong>&euro;17\.00/);
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

test("checkout of an empty cart re-renders the cart with an error and creates no order", async () => {
  const v = visitor();
  const email = `empty-${uniq()}@example.test`;
  const r = await v.post("/cart/checkout", { acceptCgv: "on", name: "Nobody", email });
  assert.equal(r.status, 200);
  assert.match(r.text, /Your cart is empty/);
  assert.equal(createdIntents.length, 0);
  assert.equal((await pool.query("SELECT 1 FROM orders WHERE buyer_email = $1", [email])).rowCount, 0);
});

test("checkout validation: missing name or bad email shows a message and holds nothing", async () => {
  const v = visitor();
  const cls = await makeClass({ capacity: 5 });
  await v.post("/cart/add-dropin", { classId: cls });
  for (const f of [{ name: "", email: "ok@example.test" }, { name: "Ok", email: "nope" }, { name: "Ok", email: "a@example.test, b@example.test" }]) {
    const r = await v.post("/cart/checkout", f);
    assert.match(r.text, /enter your name and a valid email/);
  }
  assert.equal((await seats(cls)).length, 0);
  assert.equal(createdIntents.length, 0);
});

test("checkout with HelloAsso unconfigured says so and holds nothing", async () => {
  configured = false;
  const v = visitor();
  const cls = await makeClass({ capacity: 5 });
  await v.post("/cart/add-dropin", { classId: cls });
  const r = await v.post("/cart/checkout", { acceptCgv: "on", name: "Pat", email: `pat-${uniq()}@example.test` });
  assert.match(r.text, /Online payment isn&#39;t set up yet/);
  assert.equal((await seats(cls)).length, 0);
});

test("checkout: drop-in seats become in_cart rows tied to one order, with labelled order items and the right total", async () => {
  const v = visitor();
  const cls = await makeClass({ price: 8.5, capacity: 5, title: `Readers ${uniq()}` });
  await v.post("/cart/add-dropin", { classId: cls });
  await v.post("/cart/add-dropin", { classId: cls });
  const email = `Seat-${uniq()}@Example.TEST`;
  const r = await v.post("/cart/checkout", { acceptCgv: "on", name: "Seat Buyer", email, phone: "0600000000" });
  assert.equal(r.status, 302);
  assert.match(r.location, /^https:\/\/pay\.example\.test\/dropin\/\d+$/);
  assert.equal(await v.count(), 0, "cart emptied once the payment link exists");

  const { rows: orders } = await pool.query("SELECT * FROM orders WHERE buyer_email = $1", [email.toLowerCase()]);
  assert.equal(orders.length, 1);
  assert.equal(Number(orders[0].total_amount), 17);
  assert.equal(orders[0].status, "pending");
  const held = await seats(cls);
  assert.equal(held.length, 2);
  assert.ok(held.every((s) => s.status === "in_cart" && s.order_id === orders[0].id));
  const { rows: items } = await pool.query("SELECT * FROM order_items WHERE order_id = $1", [orders[0].id]);
  assert.equal(items.length, 2);
  const title = await classTitle(cls);
  assert.ok(items.every((i) => i.item_title.startsWith(`${title} — `) && Number(i.price) === 8.5 && i.class_dropin_seat_id));
  assert.equal(createdIntents.length, 1);
  assert.equal(createdIntents[0].amountCents, 1700);
  assert.equal(createdIntents[0].metadata.orderId, orders[0].id);
});

test("checkout of a mixed cart locks the book copy and creates the seat in one order", async () => {
  const v = visitor();
  const cls = await makeClass({ price: 5, capacity: 3 });
  const copy = await makeCopy(6);
  await v.post("/cart/add", { copyId: copy });
  await v.post("/cart/add-dropin", { classId: cls });
  const email = `mix-${uniq()}@example.test`;
  const r = await v.post("/cart/checkout", { acceptCgv: "on", name: "Mixed Buyer", email });
  assert.equal(r.status, 302);
  const { rows: orders } = await pool.query("SELECT * FROM orders WHERE buyer_email = $1", [email]);
  assert.equal(Number(orders[0].total_amount), 11);
  assert.equal((await pool.query("SELECT status FROM book_copies WHERE id = $1", [copy])).rows[0].status, "in_cart");
  assert.equal((await seats(cls)).length, 1);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM order_items WHERE order_id = $1", [orders[0].id])).rows[0].n, 2);
});

test("checkout: a seat sold elsewhere after it was carted is pruned, so the buyer is charged only for what is still free", async () => {
  const v = visitor();
  const cls = await makeClass({ price: 5, capacity: 2 });
  await v.post("/cart/add-dropin", { classId: cls });
  await v.post("/cart/add-dropin", { classId: cls });
  const email = `late-${uniq()}@example.test`;
  // Both seats were in this cart; before checkout, one is bought elsewhere — the
  // pre-check prunes it, so the cart shrinks to the one seat still free and
  // checkout proceeds for that one rather than overselling.
  await pool.query("INSERT INTO class_dropin_seats (class_id, status) VALUES ($1, 'sold')", [cls]);
  const r = await v.post("/cart/checkout", { acceptCgv: "on", name: "Late Buyer", email });
  assert.equal(r.status, 302);
  const { rows: orders } = await pool.query("SELECT * FROM orders WHERE buyer_email = $1", [email]);
  assert.equal(Number(orders[0].total_amount), 5, "charged for one seat, not two");
  assert.equal((await seats(cls)).filter((s) => s.status === "in_cart").length, 1);
  assert.equal((await seats(cls)).length, 2, "never more seats than capacity");
});

test("checkout: when the last seat is taken after the cart check, the buyer is told and nothing is held or ordered", async () => {
  const v = visitor();
  const cls = await makeClass({ price: 5, capacity: 1 });
  await v.post("/cart/add-dropin", { classId: cls });
  const email = `race-${uniq()}@example.test`;
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
    r = await v.post("/cart/checkout", { acceptCgv: "on", name: "Race Buyer", email });
  } finally {
    pool.query = original;
  }
  assert.equal(r.status, 200);
  assert.match(r.text, /something in your cart was just taken by someone else/);
  assert.equal((await pool.query("SELECT 1 FROM orders WHERE buyer_email = $1", [email])).rowCount, 0, "order rolled back");
  assert.equal((await seats(cls)).filter((s) => s.status === "in_cart").length, 0);
  assert.equal(await v.count(), 0, "the no-longer-available seat was dropped from the cart");
});
