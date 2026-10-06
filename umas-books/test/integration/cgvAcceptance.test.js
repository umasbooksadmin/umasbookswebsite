// Proof of acceptance of the terms of sale: checkout stores when (and which
// version) in orders.cgv_accepted_at / cgv_version, in the same transaction
// that creates the order; without the checkbox no order exists; the proof is
// in the member data export and survives erasure (anonymised orders keep it).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");
const { makeCookieJar } = require("../helpers/httpClient");
const { createAccount, logInInProcess } = require("../helpers/accounts");

const db = prepareDatabase("cgv_acceptance", { isolated: true });

const sent = [];
const mailer = require("../../src/mailer");
mailer.sendMail = async (m) => { sent.push(m); };
const helloasso = require("../../src/lib/helloasso");
helloasso.isConfigured = () => true;
let seq = 0;
helloasso.createCheckoutIntent = async () => ({ id: `cgv-intent-${Date.now()}-${++seq}`, redirectUrl: `https://pay.example.test/${seq}` });

const { pool } = require("../../src/db");
const { TERMS_OF_SALE_VERSION } = require("../../src/lib/legal");
const { markOrderPaid } = require("../../src/lib/cart");

let server;
before(async () => {
  db.create();
  const app = buildApp([require("../../src/routes/cart")]);
  app.set("trust proxy", true);
  server = await listen(app);
});
after(async () => {
  await server.close();
  await pool.end();
  db.drop();
});

// CI runs every test file against ONE shared database, concurrently, and
// pending orders keep client_ip for the per-IP unpaid-order cap in
// routes/cart.js. So this file's checkouts come from their own made-up client
// addresses (trusted X-Forwarded-For) instead of 127.0.0.1: they can neither
// hit nor fill the cap other files' 127.0.0.1 checkouts depend on.
let ipSeq = Math.floor(Math.random() * 200) * 250;
const nextIp = () => { ipSeq += 1; return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`; };

// Buying requires an account: sign this person in as a confirmed account.
async function signIn(v, email, displayName = "Test Buyer") {
  const account = await createAccount(pool, { email, displayName });
  await logInInProcess(server.base, v.jar, account);
  return account;
}

function guest(lang) {
  const jar = makeCookieJar();
  const ip = nextIp();
  const send = async (path, form) => {
    const res = await fetch(`${server.base}${path}`, {
      method: form ? "POST" : "GET",
      redirect: "manual",
      headers: { "x-forwarded-for": ip, cookie: [jar.header(), lang ? `umasbooks_lang=${lang}` : ""].filter(Boolean).join("; "), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    jar.capture(res);
    return { res, text: await res.text() };
  };
  return { jar, get: (p) => send(p), post: send };
}

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
async function makeCopy() {
  const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'A') RETURNING id", [`Cgv Book ${uniq()}`]);
  const { rows } = await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', 5) RETURNING id", [b[0].id]);
  return rows[0].id;
}
const orders = async (email) => (await pool.query("SELECT * FROM orders WHERE buyer_email = $1", [email])).rows;

test("TERMS_OF_SALE_VERSION is a date string", () => {
  assert.match(TERMS_OF_SALE_VERSION, /^\d{4}-\d{2}-\d{2}$/);
});

test("checkout stores cgv_accepted_at and the current cgv_version on the new order", async () => {
  const v = guest();
  await v.post("/cart/add", { copyId: await makeCopy() });
  const email = `cgv-${uniq()}@example.test`;
  await signIn(v, email);
  const before = Date.now();
  const { res } = await v.post("/cart/checkout", { name: "Cgv Buyer", acceptCgv: "on" });
  assert.equal(res.status, 302);
  const [order] = await orders(email);
  assert.ok(order.cgv_accepted_at instanceof Date);
  assert.ok(Math.abs(order.cgv_accepted_at.getTime() - before) < 60_000);
  assert.equal(order.cgv_version, TERMS_OF_SALE_VERSION);
});

test("checkout without the terms checkbox is refused: no order, nothing stored", async () => {
  const v = guest();
  const copyId = await makeCopy();
  await v.post("/cart/add", { copyId });
  const email = `nocgv-${uniq()}@example.test`;
  await signIn(v, email);
  const { res, text } = await v.post("/cart/checkout", { name: "No Cgv" });
  assert.equal(res.status, 200);
  assert.match(text, /Please accept the terms of sale/);
  assert.equal((await orders(email)).length, 0);
  const { rows } = await pool.query("SELECT status FROM book_copies WHERE id = $1", [copyId]);
  assert.equal(rows[0].status, "in_stock");
});

// The version string changes whenever the terms change in substance. 2026-10-06:
// the terms now say buying (books and drop-in seats) requires an account.
test("the paid confirmation email carries the acceptance line, in English and in French", async () => {
  for (const [lang, line] of [
    ["en", /Terms of sale accepted on \d{1,2} \w+ \d{4} \(version 2026-10-06\)\./],
    ["fr", /Conditions générales de vente acceptées le \d{1,2} \S+ \d{4} \(version 2026-10-06\)\./],
  ]) {
    const v = guest(lang);
    await v.post("/cart/add", { copyId: await makeCopy() });
    const email = `cgvmail-${lang}-${uniq()}@example.test`;
    await signIn(v, email);
    await v.post("/cart/checkout", { name: "Mail Buyer", acceptCgv: "on" });
    const [order] = await orders(email);
    assert.equal(order.lang, lang);
    assert.equal(await markOrderPaid(pool, order), true);
    for (let i = 0; i < 50 && !sent.find((m) => m.to === email); i++) await new Promise((r) => setTimeout(r, 20));
    const mail = sent.find((m) => m.to === email);
    assert.ok(mail, "confirmation sent");
    assert.match(mail.text, line, lang);
  }
});

test("the proof is in the member data export and survives erasure (anonymised order keeps it)", async () => {
  const v = guest();
  await v.post("/cart/add", { copyId: await makeCopy() });
  const email = `cgvexp-${uniq()}@example.test`;
  const account = await signIn(v, email, "Export Buyer");
  await v.post("/cart/checkout", { name: "Export Buyer", acceptCgv: "on" });
  const u = [{ id: account.id }];
  const { buildMemberExport } = require("../../src/lib/memberExport");
  const data = await buildMemberExport(pool, u[0].id);
  assert.equal(data.orders.length, 1);
  assert.equal(data.orders[0].cgv_version, TERMS_OF_SALE_VERSION);
  assert.ok(data.orders[0].cgv_accepted_at);

  const privacy = require("../../src/lib/privacy");
  await privacy.eraseMember(pool, u[0].id);
  const { rows } = await pool.query("SELECT buyer_email, cgv_accepted_at, cgv_version FROM orders WHERE id = $1", [data.orders[0].id]);
  assert.notEqual(rows[0].buyer_email, email);
  assert.equal(rows[0].cgv_version, TERMS_OF_SALE_VERSION);
  assert.ok(rows[0].cgv_accepted_at);
});
