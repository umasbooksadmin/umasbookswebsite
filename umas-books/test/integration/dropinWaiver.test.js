// Drop-in withdrawal waiver at checkout (src/routes/cart.js): a cart with a
// drop-in seat needs the 'waiveWithdrawal' box; books-only carts don't;
// acceptance is recorded in orders.withdrawal_waiver_at.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");
const { makeCookieJar } = require("../helpers/httpClient");

const db = prepareDatabase("dropin_waiver");

const mailer = require("../../src/mailer");
mailer.sendMail = async () => {};
const helloasso = require("../../src/lib/helloasso");
helloasso.isConfigured = () => true;
const createdIntents = [];
let seq = 0;
helloasso.createCheckoutIntent = async (args) => {
  createdIntents.push(args);
  return { id: `waiver-intent-${Date.now()}-${++seq}`, redirectUrl: `https://pay.example.test/${seq}` };
};

const { pool } = require("../../src/db");

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
beforeEach(() => { createdIntents.length = 0; });

function guest() {
  const jar = makeCookieJar();
  const send = async (path, form) => {
    const res = await fetch(`${server.base}${path}`, {
      method: form ? "POST" : "GET",
      redirect: "manual",
      headers: { cookie: jar.header(), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    jar.capture(res);
    return { res, text: await res.text() };
  };
  return { get: (p) => send(p), post: send };
}

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
async function makeClass() {
  const { rows } = await pool.query(
    "INSERT INTO classes (title, starts_at, capacity, dropin_price) VALUES ($1, now() + interval '3 days', 5, 12.00) RETURNING id",
    [`Waiver Class ${uniq()}`]
  );
  return rows[0].id;
}
async function makeCopy() {
  const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'A') RETURNING id", [`Waiver Book ${uniq()}`]);
  const { rows } = await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', 5) RETURNING id", [b[0].id]);
  return rows[0].id;
}
const orders = async (email) => (await pool.query("SELECT * FROM orders WHERE buyer_email = $1", [email])).rows;
const checkout = (v, email, extra = {}) => v.post("/cart/checkout", { name: "Waiver Buyer", email, acceptCgv: "on", ...extra });

test("cart with a drop-in seat shows the waiver box; books-only cart does not", async () => {
  const v = guest();
  await v.post("/cart/add-dropin", { classId: await makeClass() });
  assert.match((await v.get("/cart")).text, /name="waiveWithdrawal"/);

  const b = guest();
  await b.post("/cart/add", { copyId: await makeCopy() });
  assert.doesNotMatch((await b.get("/cart")).text, /waiveWithdrawal/);
});

test("drop-in checkout without the box is refused: friendly error, no order, nothing locked", async () => {
  const v = guest();
  const classId = await makeClass();
  await v.post("/cart/add-dropin", { classId });
  const email = `nowaiver-${uniq()}@example.test`;
  const { res, text } = await checkout(v, email);
  assert.equal(res.status, 200);
  assert.match(text, /Please tick the box/);
  assert.equal((await orders(email)).length, 0);
  assert.equal(createdIntents.length, 0);
  const seats = await pool.query("SELECT 1 FROM class_dropin_seats WHERE class_id = $1", [classId]);
  assert.equal(seats.rowCount, 0);
});

test("drop-in checkout with the box is accepted and the waiver time is stored", async () => {
  const v = guest();
  await v.post("/cart/add-dropin", { classId: await makeClass() });
  const email = `waiver-${uniq()}@example.test`;
  const { res } = await checkout(v, email, { waiveWithdrawal: "on" });
  assert.equal(res.status, 302);
  assert.equal(createdIntents.length, 1);
  const [order] = await orders(email);
  assert.ok(order.withdrawal_waiver_at instanceof Date);
});

test("books-only checkout needs no box and stores no waiver time", async () => {
  const v = guest();
  await v.post("/cart/add", { copyId: await makeCopy() });
  const email = `books-${uniq()}@example.test`;
  const { res } = await checkout(v, email);
  assert.equal(res.status, 302);
  const [order] = await orders(email);
  assert.equal(order.withdrawal_waiver_at, null);
});
