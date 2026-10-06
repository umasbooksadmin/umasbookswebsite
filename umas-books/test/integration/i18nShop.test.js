// French shop flow, in-process (HelloAsso and mail are stubbed): the checkout
// form with HelloAsso switched on, the server messages and the emails that
// follow the buyer's / member's language. The page-by-page "is every string
// translated" audit for the shop pages is in i18nCoverage.test.js.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");
const { makeCookieJar } = require("../helpers/httpClient");
const { createAccount, logInInProcess } = require("../helpers/accounts");
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

// Buying requires an account: sign this person in as a confirmed account.
async function signIn(v, email, displayName = "Test Buyer") {
  const account = await createAccount(pool, { email, displayName });
  await logInInProcess(server.base, v.jar, account);
  return account;
}

function guest(lang) {
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
  return { jar, get: (p) => send(p), post: (p, form) => send(p, { method: "POST", form }) };
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
    const v = guest(lang);
    await signIn(v, `form-${lang}-${uniq()}@example.test`);
    await v.post("/cart/add", { copyId: copy.copyId });
    await v.post("/cart/add-dropin", { classId });
    pages[lang] = (await v.get("/cart")).text;
  }
  assert.match(pages.en, /<button class="btn" type="submit">Order with obligation to pay<\/button>/);
  assert.match(pages.fr, /<button class="btn" type="submit">Commander avec obligation de paiement<\/button>/);
  assert.doesNotMatch(pages.fr, /Order with obligation to pay/);
  assert.match(pages.fr, /conditions de vente/);
  // No-returns notice (never a waiver of legal rights), tax line and pickup hours above the order button.
  assert.ok(pages.en.includes("Used books: no returns or exchanges for a change of mind in the shop. For online orders, your statutory 14-day right of withdrawal and the legal guarantees still apply."));
  assert.ok(pages.fr.includes("Livres d’occasion\u00a0: pas de reprise ni d’échange pour simple changement d’avis en boutique."));
  assert.ok(pages.en.includes("Price incl. tax, TVA non applicable") && pages.fr.includes("Prix TTC, TVA non applicable"));
  assert.ok(pages.en.includes("Pick up within 14 days, Tuesday to Saturday, 10:00–19:00, Rue Peyrolière, Albi."));
  assert.ok(pages.fr.includes("À retirer sous 14 jours, du mardi au samedi, 10\u00a0h–19\u00a0h, rue Peyrolière, Albi."));
  assert.ok(pages.en.indexOf("no-returns-note") < pages.en.indexOf("Order with obligation to pay</button>"), "the notice sits above the order button");
  assert.doesNotMatch(pages.en, /waive the|renounce/i);
  assert.ok(pages.en.includes("a drop-in session is a leisure activity on a fixed date, so the right of withdrawal does not apply to it (art. L.221-28, 12°)"));
  assert.match(pages.fr, /name="waiveWithdrawal"/);
  assert.deepEqual(untranslated(pages.en, pages.fr, ALLOW), []);
});

test("checkout errors: French for a French user, English otherwise", async () => {
  const copy = await makeBookCopy();
  for (const [lang, empty, noName, noTerms] of [
    ["fr", /Votre panier est vide/, /Veuillez indiquer votre nom\./, /Veuillez accepter les conditions de vente/],
    ["en", /Your cart is empty\./, /Please enter your name\./, /Please accept the terms of sale to continue\./],
    [undefined, /Your cart is empty\./, /Please enter your name/, /Please accept the terms of sale/],
  ]) {
    const v = guest(lang);
    // An account without a display name, so a blank name field really is a missing name.
    await signIn(v, `errs-${lang}-${uniq()}@example.test`, "");
    assert.match((await v.post("/cart/checkout", { name: "A", acceptCgv: "on" })).text, empty);
    await v.post("/cart/add", { copyId: copy.copyId });
    assert.match((await v.post("/cart/checkout", { name: "", acceptCgv: "on" })).text, noName);
    assert.match((await v.post("/cart/checkout", { name: "A" })).text, noTerms);
  }
});

test("the drop-in waiver error is French for a French user", async () => {
  const classId = await makeClass();
  const v = guest("fr");
  await signIn(v, `waiver-fr-${uniq()}@example.test`);
  await v.post("/cart/add-dropin", { classId });
  const r = await v.post("/cart/checkout", { name: "A", acceptCgv: "on" });
  assert.match(r.text, /Veuillez cocher la case confirmant/);
});

test("a French checkout stores lang=fr and the paid confirmation email is French (English buyer unchanged)", async () => {
  const pay = async (lang) => {
    const copy = await makeBookCopy();
    const v = guest(lang);
    await v.post("/cart/add", { copyId: copy.copyId });
    const email = `buyer-${lang}-${uniq()}@example.test`;
    await signIn(v, email);
    const r = await v.post("/cart/checkout", { name: "Marie", acceptCgv: "on" });
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
  const en = (await guest("en").get(`/cart/return?order=${rows[0].access_token}`)).text;
  const fr = (await guest("fr").get(`/cart/return?order=${rows[0].access_token}`)).text;
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
