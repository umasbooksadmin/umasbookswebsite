// French shop flow, in-process (HelloAsso and mail are stubbed): the checkout
// form with HelloAsso switched on, the server messages and the emails that
// follow the buyer's / member's language. The page-by-page "is every string
// translated" audit for the shop pages is in i18nCoverage.test.js.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");
const { makeCookieJar } = require("../helpers/httpClient");
const { untranslated } = require("../helpers/i18nAudit");

const db = prepareDatabase("i18n_shop", { isolated: true });

const mailer = require("../../src/mailer");
let sent = [];
mailer.sendMail = async (opts) => { sent.push(opts); };

const helloasso = require("../../src/lib/helloasso");
helloasso.isConfigured = () => true;
let intentSeq = 0;
helloasso.createCheckoutIntent = async () => ({ id: `i18n-intent-${Date.now()}-${++intentSeq}`, redirectUrl: "https://pay.example.test/x" });

const { pool } = require("../../src/db");
const { checkoutLimiter } = require("../../src/middleware/rateLimits");
const { sendPickupReminders } = require("../../src/lib/reservations");
const { markOrderPaid } = require("../../src/lib/cart");
const privacy = require("../../src/lib/privacy");

let server;
before(async () => {
  db.create();
  server = await listen(buildApp([require("../../src/routes/cart"), require("../../src/routes/books")]));
});
after(async () => {
  await server.close();
  await pool.end();
  db.drop();
});

beforeEach(async () => {
  sent = [];
  await pool.query("UPDATE orders SET client_ip = NULL WHERE client_ip IS NOT NULL");
  for (const key of ["127.0.0.1", "::ffff:127.0.0.1", "::1"]) checkoutLimiter.resetKey(key);
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function visitor(lang) {
  const jar = makeCookieJar();
  const send = async (path, { method = "GET", form } = {}) => {
    const cookie = [jar.header(), lang ? `umasbooks_lang=${lang}` : ""].filter(Boolean).join("; ");
    const res = await fetch(`${server.base}${path}`, {
      method,
      redirect: "manual",
      headers: { cookie, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    jar.capture(res);
    return { res, text: await res.text() };
  };
  return { get: (p) => send(p), post: (p, form) => send(p, { method: "POST", form }) };
}

async function makeBookCopy() {
  const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'I18n Shop Author') RETURNING id", [`I18n Shop Book ${uniq()}`]);
  const { rows } = await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', 7.5) RETURNING id", [b[0].id]);
  return { bookId: b[0].id, copyId: rows[0].id, title: `I18n Shop Book` };
}
async function makeClass() {
  const { rows } = await pool.query(
    "INSERT INTO classes (title, starts_at, capacity, dropin_price) VALUES ('I18n Shop Session', $1, 10, 8) RETURNING id",
    [new Date(Date.now() + 7 * 86400 * 1000)]
  );
  return rows[0].id;
}

const ALLOW = [/^I18n Shop/];

test("checkout form (HelloAsso on, book + drop-in seat) is fully translated", async () => {
  const copy = await makeBookCopy();
  const classId = await makeClass();
  const pages = {};
  for (const lang of ["en", "fr"]) {
    const v = visitor(lang);
    await v.post("/cart/add", { copyId: copy.copyId });
    await v.post("/cart/add-dropin", { classId });
    pages[lang] = (await v.get("/cart")).text;
  }
  assert.match(pages.en, /Pay &amp; Buy/);
  assert.match(pages.fr, /<button class="btn" type="submit">Commander et payer<\/button>/);
  assert.doesNotMatch(pages.fr, /Pay &amp; Buy/);
  assert.match(pages.fr, /conditions de vente/);
  assert.match(pages.fr, /name="waiveWithdrawal"/);
  assert.deepEqual(untranslated(pages.en, pages.fr, ALLOW), []);
});

test("checkout errors: French for a French visitor, English otherwise", async () => {
  const copy = await makeBookCopy();
  for (const [lang, empty, badEmail, noTerms] of [
    ["fr", /Votre panier est vide/, /Veuillez indiquer votre nom et une adresse e-mail valide/, /Veuillez accepter les conditions de vente/],
    ["en", /Your cart is empty\./, /Please enter your name and a valid email address\./, /Please accept the terms of sale to continue\./],
    [undefined, /Your cart is empty\./, /Please enter your name/, /Please accept the terms of sale/],
  ]) {
    const v = visitor(lang);
    assert.match((await v.post("/cart/checkout", { name: "A", email: "a@example.test", acceptCgv: "on" })).text, empty);
    await v.post("/cart/add", { copyId: copy.copyId });
    assert.match((await v.post("/cart/checkout", { name: "", email: "nope", acceptCgv: "on" })).text, badEmail);
    assert.match((await v.post("/cart/checkout", { name: "A", email: "a@example.test" })).text, noTerms);
  }
});

test("the drop-in waiver error is French for a French visitor", async () => {
  const classId = await makeClass();
  const v = visitor("fr");
  await v.post("/cart/add-dropin", { classId });
  const r = await v.post("/cart/checkout", { name: "A", email: "a@example.test", acceptCgv: "on" });
  assert.match(r.text, /Veuillez cocher la case confirmant/);
});

test("a French checkout stores lang=fr and the paid confirmation email is French (English buyer unchanged)", async () => {
  const pay = async (lang) => {
    const copy = await makeBookCopy();
    const v = visitor(lang);
    await v.post("/cart/add", { copyId: copy.copyId });
    const email = `buyer-${lang}-${uniq()}@example.test`;
    const r = await v.post("/cart/checkout", { name: "Marie", email, acceptCgv: "on" });
    assert.equal(r.res.status, 302);
    const { rows } = await pool.query("SELECT * FROM orders WHERE buyer_email = $1", [email]);
    assert.equal(rows[0].lang, lang);
    assert.equal(await markOrderPaid(pool, rows[0]), true);
    return sent.find((m) => m.to === email);
  };
  const fr = await pay("fr");
  assert.equal(fr.subject, "Votre commande chez Uma's Books est confirmée");
  assert.match(fr.text, /^Bonjour Marie,/);
  assert.match(fr.text, /YOUR RIGHTS/, "legal block stays bilingual");
  const en = await pay("en");
  assert.equal(en.subject, "Your order at Uma's Books is confirmed");
  assert.match(en.text, /^Hi Marie,/);
});

test("cart_return (pending, payment provider silent) is translated", async () => {
  const { rows } = await pool.query(
    "INSERT INTO orders (buyer_name, buyer_email, total_amount, status) VALUES ('B', 'pending@example.test', 5, 'pending') RETURNING access_token"
  );
  const en = (await visitor("en").get(`/cart/return?order=${rows[0].access_token}`)).text;
  const fr = (await visitor("fr").get(`/cart/return?order=${rows[0].access_token}`)).text;
  assert.match(fr, /Confirmation de votre paiement/);
  assert.deepEqual(untranslated(en, fr, ALLOW), []);
});

async function makeUser(lang) {
  const email = `i18n-shop-${uniq()}@example.test`;
  await pool.query(
    "INSERT INTO users (email, password_hash, display_name, email_verified_at, lang) VALUES ($1, 'x', 'Jean Dupont', now(), $2)",
    [email, lang]
  );
  return email;
}

test("reserve confirmation email: member language, else the language chosen on the site, else English", async () => {
  const reserve = async ({ email, cookieLang }) => {
    const { bookId, copyId } = await makeBookCopy();
    await visitor(cookieLang).post(`/books/${bookId}/reserve`, { copyId, name: "Jean Dupont", email });
    for (let i = 0; i < 50 && !sent.find((m) => m.to === email); i++) await new Promise((r) => setTimeout(r, 20));
    return sent.find((m) => m.to === email);
  };
  const frMember = await makeUser("fr");
  const m1 = await reserve({ email: frMember, cookieLang: "en" });
  assert.match(m1.subject, /^Vous avez réservé « I18n Shop Book/);
  assert.match(m1.text, /^Bonjour Jean Dupont,/);

  const m2 = await reserve({ email: `anon-${uniq()}@example.test`, cookieLang: "fr" });
  assert.match(m2.subject, /^Vous avez réservé/);

  const m3 = await reserve({ email: `anon-${uniq()}@example.test`, cookieLang: undefined });
  assert.match(m3.subject, /^You've reserved "I18n Shop Book/);
  assert.match(m3.text, /^Hi Jean Dupont,/);

  const enMember = await makeUser("en");
  const m4 = await reserve({ email: enMember, cookieLang: "fr" });
  assert.match(m4.subject, /^You've reserved/);
});

test("pickup reminder follows the member's language (English when unknown)", async () => {
  const remind = async (email) => {
    const { copyId } = await makeBookCopy();
    await pool.query(
      "UPDATE book_copies SET status = 'reserved', reserved_by_name = 'Jean Dupont', reserved_by_email = $2, reserved_at = now() - interval '12 days' WHERE id = $1",
      [copyId, email]
    );
    await sendPickupReminders(pool);
    return sent.find((m) => m.to === email);
  };
  const fr = await remind(await makeUser("fr"));
  assert.match(fr.subject, /^Rappel : votre exemplaire de « I18n Shop Book/);
  assert.match(fr.text, /^Bonjour Jean Dupont,/);
  const none = await remind(`nobody-${uniq()}@example.test`);
  assert.match(none.subject, /^Reminder: your copy of/);
  assert.match(none.text, /^Hi Jean Dupont,/);
});

test("inactivity warning follows the member's language", async () => {
  const frEmail = await makeUser("fr");
  const enEmail = await makeUser(null);
  await pool.query(
    "UPDATE users SET last_login_at = now() - interval '4 years', created_at = now() - interval '4 years' WHERE email = ANY($1)",
    [[frEmail, enEmail]]
  );
  await privacy.purgeExpiredPersonalData(pool);
  const fr = sent.find((m) => m.to === frEmail);
  const en = sent.find((m) => m.to === enEmail);
  assert.equal(fr.subject, "Votre compte Uma's Books sera supprimé dans 30 jours");
  assert.match(fr.text, /^Bonjour Jean Dupont,/);
  assert.equal(en.subject, "Your Uma's Books account will be deleted in 30 days");
  assert.match(en.text, /^Hi Jean Dupont,/);
});
