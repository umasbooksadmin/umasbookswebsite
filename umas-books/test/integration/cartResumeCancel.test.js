// Backing out of HelloAsso used to lock the books for an hour with no way out:
// the cart is emptied before the redirect and the "back" link lands on an
// empty /cart. Now /cart lists the buyer's OWN unpaid orders with
// "Resume payment" (while HelloAsso's link is still valid) and
// "Cancel this order" (HelloAsso is asked first; an order that was in fact
// paid is never cancelled). Owner-only, in English and French.
// Own throwaway database; HelloAsso and the mailer are stubbed before the
// cart routes are loaded.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");
const { makeOrder } = require("../helpers/orderFixtures");

const db = prepareDatabase("cart_resume", { isolated: true });

const mailer = require("../../src/mailer");
mailer.sendMail = async () => {};
const helloasso = require("../../src/lib/helloasso");
const intents = new Map();
helloasso.isConfigured = () => true;
helloasso.getCheckoutIntent = async (id) => {
  if (!intents.has(String(id))) throw new Error(`unknown intent ${id}`);
  return intents.get(String(id));
};
let createdIntent = 0;
helloasso.createCheckoutIntent = async () => ({ id: `cart-resume-${++createdIntent}`, redirectUrl: `https://checkout.helloasso.com/pay/${createdIntent}` });

const { pool } = require("../../src/db");

let server;
let alice;
let bob;

before(async () => {
  db.create();
  const mk = async (name) => {
    const email = `${name}-${Date.now()}@example.test`;
    const { rows } = await pool.query(
      "INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, 'x', $2, now()) RETURNING id", [email, name]
    );
    return { id: rows[0].id, email, displayName: name, isAdmin: false, isMember: false, isVolunteer: false };
  };
  alice = await mk("Alice");
  bob = await mk("Bob");
  server = await listen(buildApp([require("../../src/routes/cart")]));
});
after(async () => {
  await server.close();
  await pool.end();
  db.drop();
});

const asUser = (user, extra = {}) => ({ "x-test-user": JSON.stringify(user), ...extra });
const get = async (path, user, headers = {}) => {
  const res = await fetch(`${server.base}${path}`, { redirect: "manual", headers: asUser(user, headers) });
  return { res, text: await res.text() };
};
const post = async (path, user, fields = {}, headers = {}) => {
  const res = await fetch(`${server.base}${path}`, {
    method: "POST", redirect: "manual",
    headers: { ...asUser(user, headers), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  return { res, text: await res.text() };
};
const pendingFor = async (user, opts = {}) => {
  const made = await makeOrder(pool, { status: "pending", userId: user.id, email: user.email, ...opts });
  if (opts.redirect !== null) {
    await pool.query("UPDATE orders SET checkout_redirect_url = $2 WHERE id = $1", [made.order.id, opts.redirect || "https://checkout.helloasso.com/pay/abc"]);
  }
  return made;
};
const orderRow = async (id) => (await pool.query("SELECT * FROM orders WHERE id = $1", [id])).rows[0];
const copyStatuses = async (ids) => (await pool.query("SELECT status FROM book_copies WHERE id = ANY($1::int[]) ORDER BY id", [ids])).rows.map((r) => r.status);

test("checkout stores the HelloAsso payment link; /cart then lists the buyer's unpaid order with Resume and Cancel", async () => {
  const { copyIds } = await makeOrder(pool, { status: "expired", books: 1 }); // a free copy
  const cookieOf = (res) => (res.headers.getSetCookie() || []).map((c) => c.split(";")[0]).join("; ");
  const add = await post("/cart/add", alice, { copyId: copyIds[0] });
  const cookie = cookieOf(add.res);
  const checkout = await post("/cart/checkout", alice, { name: "Alice Buyer", acceptCgv: "on" }, { cookie });
  assert.equal(checkout.res.status, 302, checkout.text.slice(0, 300));
  assert.match(checkout.res.headers.get("location"), /^https:\/\/checkout\.helloasso\.com\/pay\//);
  const { rows } = await pool.query("SELECT * FROM orders WHERE user_id = $1 AND status = 'pending' ORDER BY id DESC LIMIT 1", [alice.id]);
  assert.equal(rows[0].checkout_redirect_url, checkout.res.headers.get("location"));

  // Back out of HelloAsso: the session cart is empty, but the order is listed.
  const back = await get("/cart", alice, { cookie: cookieOf(checkout.res) || cookie });
  assert.match(back.text, /id="pending-orders"/);
  assert.match(back.text, new RegExp(`/cart/orders/${rows[0].id}/resume`));
  assert.match(back.text, new RegExp(`/cart/orders/${rows[0].id}/cancel`));
  assert.match(back.text, /Your cart is empty/);
});

test("the unpaid-orders block shows only the logged-in buyer's own orders, in French too", async () => {
  const mine = await pendingFor(alice);
  const theirs = await pendingFor(bob);
  const page = await get("/cart", alice);
  assert.ok(page.text.includes(`/cart/orders/${mine.order.id}/cancel`));
  assert.ok(!page.text.includes(`/cart/orders/${theirs.order.id}/`));
  const guest = await get("/cart", null);
  assert.ok(!guest.text.includes("pending-orders"));
  const fr = await get("/cart", alice, { "accept-language": "fr" });
  assert.match(fr.text, /Vos commandes non payées/);
  assert.match(fr.text, /Reprendre le paiement/);
  assert.match(fr.text, /Annuler cette commande/);
  assert.match(page.text, /Resume payment/);
  assert.match(page.text, /Cancel this order/);
});

test("resume sends the owner to HelloAsso's page while the link is fresh, and to nowhere for anyone else", async () => {
  const mine = await pendingFor(alice, { redirect: "https://checkout.helloasso.com/pay/mine" });
  const ok = await get(`/cart/orders/${mine.order.id}/resume`, alice);
  assert.equal(ok.res.status, 302);
  assert.equal(ok.res.headers.get("location"), "https://checkout.helloasso.com/pay/mine");

  const stranger = await get(`/cart/orders/${mine.order.id}/resume`, bob);
  assert.equal(stranger.res.status, 404);
  const guest = await get(`/cart/orders/${mine.order.id}/resume`, null);
  assert.equal(guest.res.status, 302);
  assert.match(guest.res.headers.get("location"), /^\/login/);
  assert.equal((await get("/cart/orders/abc/resume", alice)).res.status, 404);
  assert.equal((await post("/cart/orders/abc/cancel", alice)).res.status, 404);

  // Older than HelloAsso's link: no redirect, a clear message instead.
  const old = await pendingFor(alice, { createdMinutesAgo: 30, redirect: "https://checkout.helloasso.com/pay/old" });
  const expired = await get(`/cart/orders/${old.order.id}/resume`, alice);
  assert.match(expired.res.headers.get("location"), /^\/cart\?notice=resume-expired/);
  const page = await get("/cart", alice);
  assert.match(page.text, new RegExp(`/cart/orders/${old.order.id}/cancel`));
  assert.ok(!page.text.includes(`/cart/orders/${old.order.id}/resume`), "no Resume button for an expired link");

  // A stored link that is not a HelloAsso payment page is never followed.
  const evil = await pendingFor(alice, { redirect: "https://evil.example/pay" });
  const refused = await get(`/cart/orders/${evil.order.id}/resume`, alice);
  assert.match(refused.res.headers.get("location"), /^\/cart\?notice=resume-expired/);
});

test("cancel releases the owner's own unpaid order; someone else's is untouched", async () => {
  const mine = await pendingFor(alice, { intentId: "cr-cancel-1" });
  intents.set("cr-cancel-1", { id: 1, order: { payments: [{ state: "Pending" }] } });

  const stranger = await post(`/cart/orders/${mine.order.id}/cancel`, bob);
  assert.equal(stranger.res.status, 404);
  assert.equal((await orderRow(mine.order.id)).status, "pending");
  assert.deepEqual(await copyStatuses(mine.copyIds), ["in_cart"]);

  const done = await post(`/cart/orders/${mine.order.id}/cancel`, alice);
  assert.equal(done.res.status, 302);
  assert.match(done.res.headers.get("location"), /notice=order-cancelled/);
  assert.equal((await orderRow(mine.order.id)).status, "cancelled");
  assert.deepEqual(await copyStatuses(mine.copyIds), ["in_stock"]);

  // Repeating it is harmless.
  const again = await post(`/cart/orders/${mine.order.id}/cancel`, alice);
  assert.match(again.res.headers.get("location"), /notice=order-cancelled/);
  assert.equal((await orderRow(mine.order.id)).status, "cancelled");
});

test("cancel never cancels an order that HelloAsso says was paid", async () => {
  const paidMeanwhile = await pendingFor(alice, { intentId: "cr-cancel-paid" });
  intents.set("cr-cancel-paid", { id: 2, order: { id: 77, payments: [{ state: "Authorized" }] } });
  const r = await post(`/cart/orders/${paidMeanwhile.order.id}/cancel`, alice);
  assert.match(r.res.headers.get("location"), /notice=order-paid/);
  assert.equal((await orderRow(paidMeanwhile.order.id)).status, "paid");
  assert.deepEqual(await copyStatuses(paidMeanwhile.copyIds), ["sold"]);
});

test("the 'already have unpaid orders' error points at the block and the block is on the page", async () => {
  await pendingFor(bob);
  await pendingFor(bob);
  const { copyIds } = await makeOrder(pool, { status: "expired", books: 1 });
  const cookie = (await post("/cart/add", bob, { copyId: copyIds[0] })).res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const r = await post("/cart/checkout", bob, { name: "Bob", acceptCgv: "on" }, { cookie });
  assert.match(r.text, /Your unpaid orders/);
  assert.match(r.text, /id="pending-orders"/);
});
