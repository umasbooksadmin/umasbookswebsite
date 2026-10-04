// Drop-in order lines are stored in English ("Éveil — 12 Dec, 18:00") but shown
// in the viewer's language, from the class row, on the cart, order-return and
// account pages. Falls back to the stored text when the class is gone.
// Port 3750.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3750;
const PASSWORD = "DropinLines1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const STORED = "12 Dec, 18:00";
const FRENCH = "12 déc., 18:00";

let app, pool, user, orderToken;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));

  const email = `dropin-${Date.now()}@example.test`;
  await pool.query(
    "INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, $2, 'Ana', now())",
    [email, await bcrypt.hash(PASSWORD, 10)]
  );
  user = { email };

  // 18:00 in Paris (UTC+1 in December)
  const { rows: cls } = await pool.query(
    "INSERT INTO classes (title, starts_at, capacity, dropin_price) VALUES ('Dropin Lines Class', '2092-12-12T17:00:00Z', 10, 5) RETURNING id"
  );
  orderToken = await makeOrder(cls[0].id, "Dropin Lines Class");
});
after(async () => {
  await pool.end();
  app.stop();
});

async function makeOrder(classId, title) {
  const { rows: o } = await pool.query(
    "INSERT INTO orders (buyer_name, buyer_email, total_amount, status, lang) VALUES ('Ana', $1, 5, 'paid', 'fr') RETURNING id, access_token",
    [user.email]
  );
  const { rows: s } = await pool.query(
    "INSERT INTO class_dropin_seats (class_id, status, order_id) VALUES ($1, 'sold', $2) RETURNING id",
    [classId, o[0].id]
  );
  await pool.query(
    "INSERT INTO order_items (order_id, class_dropin_seat_id, item_title, price) VALUES ($1, $2, $3, 5)",
    [o[0].id, s[0].id, `${title} — ${STORED}`]
  );
  return o[0].access_token;
}

const get = async (path, lang, jar) =>
  (await fetch(`${app.base}${path}`, { headers: { cookie: [jar && jar.header(), `umasbooks_lang=${lang}`].filter(Boolean).join("; ") } })).text();

async function loginJar(lang) {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: `${jar.header()}; umasbooks_lang=${lang}` },
    body: new URLSearchParams({ email: user.email, password: PASSWORD, _csrf: token }).toString(),
  });
  assert.equal(res.status, 302);
  jar.capture(res);
  return jar;
}

test("cart_return renders the drop-in line in the viewer's language", async () => {
  const fr = await get(`/cart/return?order=${orderToken}`, "fr");
  assert.ok(fr.includes(`Dropin Lines Class — ${FRENCH}`), "French month and Paris time");
  assert.ok(!fr.includes(STORED), "stored English label is not shown");
  const en = await get(`/cart/return?order=${orderToken}`, "en");
  assert.ok(en.includes(`Dropin Lines Class — ${STORED}`));
});

test("account order history renders the drop-in line in the viewer's language", async () => {
  const jar = await loginJar("fr");
  const fr = await get("/account", "fr", jar);
  assert.ok(fr.includes(`Dropin Lines Class — ${FRENCH}`));
  assert.ok(!fr.includes(`Dropin Lines Class — ${STORED}`));
  const en = await get("/account", "en", jar);
  assert.ok(en.includes(`Dropin Lines Class — ${STORED}`));
});

test("cart page shows the seat date in the viewer's language", async () => {
  const { rows } = await pool.query("SELECT id FROM classes WHERE title = 'Dropin Lines Class'");
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const add = await fetch(`${app.base}/cart/add-dropin`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ classId: String(rows[0].id), _csrf: token }).toString(),
  });
  assert.equal(add.status, 302);
  const fr = await get("/cart", "fr", jar);
  assert.ok(fr.includes("Dropin Lines Class") && fr.includes("Place drop-in"));
  assert.ok(!fr.includes(STORED));
});

test("falls back to the stored title when the class row is not there", async () => {
  // A seat cannot lose its class while an order line points at it (FK), so
  // drive the join with a seat whose class row is hidden by the query shape:
  // the label helper must use item_title whenever class_title is null.
  const { loadOrderItems, orderItemLabel } = require("../../src/lib/orderItems");
  const { rows: ord } = await pool.query("SELECT id FROM orders WHERE access_token = $1", [orderToken]);
  const [item] = await loadOrderItems(pool, ord[0].id);
  assert.equal(item.class_title, "Dropin Lines Class");
  assert.equal(orderItemLabel(item, "fr"), `Dropin Lines Class — ${FRENCH}`);
  const label = orderItemLabel({ ...item, class_title: null, class_starts_at: null }, "fr");
  assert.equal(label, `Dropin Lines Class — ${STORED}`);
});
