// French shop flow, in-process (the mailer is stubbed and HelloAsso must never
// be called): the reservation form, the server messages and the emails that
// follow the buyer's / member's language. The page-by-page "is every string
// translated" audit for the shop pages is in i18nCoverage.test.js.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { reserveHarness } = require("../helpers/reserveHarness");
const { untranslated } = require("../helpers/i18nAudit");

const h = reserveHarness("i18n_shop");
const { pool, uniq } = h;
const { sendPickupReminders } = require("../../src/lib/reservations");
const privacy = require("../../src/lib/privacy");

before(() => h.start());
after(() => h.stop());
// `sent` is the harness's mailer capture; tests below read it by recipient.
let sent = h.sent;
beforeEach(() => { h.sent.length = 0; sent = h.sent; });

const makeBookCopy = async () => ({ copyId: await h.copy({ price: 7.5, title: `I18n Shop Book ${uniq()}` }) });
const makeClass = () => h.session({ price: 8, capacity: 10, title: "I18n Shop Session" });

const ALLOW = [/^I18n Shop/, /^Fixture Author$/]; // fixture data, not interface text
const nb = (t) => t.replace(/[\u00a0\u202f]/g, " "); // French typography: no-break spaces compare as plain ones

test("reservation form (book + drop-in seat) is fully translated", async () => {
  const copy = await makeBookCopy();
  const classId = await makeClass();
  const pages = {};
  for (const lang of ["en", "fr"]) {
    const v = h.visitor(await h.account(), { lang });
    await v.post("/cart/add", { copyId: copy.copyId });
    await v.post("/cart/add-dropin", { classId });
    pages[lang] = (await v.get("/cart")).text;
  }
  assert.match(pages.en, /<button class="btn" type="submit">Reserve \(free, no commitment\)<\/button>/);
  assert.match(pages.fr, /<button class="btn" type="submit">Réserver \(gratuit, sans engagement\)<\/button>/);
  assert.doesNotMatch(pages.fr, /Reserve \(free, no commitment\)/);
  assert.match(pages.fr, /conditions de vente/);
  // Nothing is paid online (never an "order with obligation to pay"), no-returns notice that
  // never waives legal rights, tax line, pickup hours: all above the button.
  assert.ok(pages.en.includes("Nothing is paid online. We hold your books for 14 days: come to the shop and pay when you collect them."));
  assert.ok(nb(pages.fr).includes("Rien n’est payé en ligne. Nous gardons vos livres 14 jours : passez à la boutique et réglez-les au moment du retrait."));
  assert.doesNotMatch(pages.en, /obligation to pay|Order with/);
  assert.doesNotMatch(pages.fr, /obligation de paiement/);
  assert.ok(pages.en.includes("Used books are not taken back for a change of mind once bought in the shop; the legal guarantees still apply."));
  assert.ok(nb(pages.fr).includes("Les livres d’occasion ne sont ni repris ni échangés pour simple changement d’avis une fois achetés en boutique"));
  assert.ok(pages.en.includes("Price incl. tax, TVA non applicable") && pages.fr.includes("Prix TTC, TVA non applicable"));
  assert.ok(pages.en.includes("Pay and collect them at the shop, Tuesday to Saturday, 10:00–19:00, Rue Peyrolière, Albi."));
  assert.ok(pages.fr.includes("du mardi au samedi, 10h–19h, rue Peyrolière, Albi."));
  assert.ok(pages.en.indexOf("no-returns-note") < pages.en.indexOf("Reserve (free, no commitment)</button>"), "the notice sits above the reserve button");
  assert.doesNotMatch(pages.en, /waive the|renounce/i);
  assert.ok(pages.en.includes("Drop-in seats: you pay at the session. You can cancel a seat online until 24 hours before it starts."));
  assert.ok(nb(pages.fr).includes("Places « drop-in » : vous réglez à la séance. Vous pouvez annuler une place en ligne jusqu’à 24 heures avant le début."));
  assert.doesNotMatch(pages.fr, /waiveWithdrawal/, "the withdrawal-waiver box no longer exists");
  assert.deepEqual(untranslated(pages.en, pages.fr, ALLOW), []);
});

test("a seats-only cart offers 'Reserve (free, no commitment)' / « Réserver (gratuit, sans engagement) »", async () => {
  const classId = await makeClass();
  for (const [lang, label] of [["en", "Reserve (free, no commitment)"], ["fr", "Réserver (gratuit, sans engagement)"]]) {
    const v = h.visitor(await h.account(), { lang });
    await v.post("/cart/add-dropin", { classId });
    assert.ok((await v.get("/cart")).text.includes(`type="submit">${label}</button>`), lang);
  }
});

test("reservation errors: French for a French user, English otherwise", async () => {
  const copy = await makeBookCopy();
  for (const [lang, empty, noName, noTerms] of [
    ["fr", /Votre panier est vide/, /Veuillez indiquer votre nom\./, /Veuillez accepter les conditions de vente/],
    ["en", /Your cart is empty\./, /Please enter your name\./, /Please accept the terms of sale to continue\./],
    [undefined, /Your cart is empty\./, /Please enter your name/, /Please accept the terms of sale/],
  ]) {
    // An account without a display name, so a blank name field really is a missing name.
    const v = h.visitor(await h.account({ displayName: "" }), { lang });
    assert.match((await v.post("/cart/reserve", { name: "A", acceptCgv: "on" })).text, empty);
    await v.post("/cart/add", { copyId: copy.copyId });
    assert.match((await v.post("/cart/reserve", { name: "", acceptCgv: "on" })).text, noName);
    assert.match((await v.post("/cart/reserve", { name: "A" })).text, noTerms);
  }
});

test("the reservation limits and the sold-out message are French for a French user", async () => {
  const buyer = await h.account();
  for (let i = 0; i < 3; i++) await h.reserve(buyer, { copyIds: [(await makeBookCopy()).copyId] });
  const fr = h.visitor(buyer, { lang: "fr" });
  await fr.post("/cart/add", { copyId: (await makeBookCopy()).copyId });
  assert.match((await fr.post("/cart/reserve", { name: "A", acceptCgv: "on" })).text, /3 réservations en cours/);

  const taken = (await makeBookCopy()).copyId;
  const other = h.visitor(await h.account(), { lang: "fr" });
  await other.post("/cart/add", { copyId: taken });
  await h.pool.query("UPDATE book_copies SET status = 'sold' WHERE id = $1", [taken]);
  assert.match((await other.post("/cart/reserve", { name: "A", acceptCgv: "on" })).text, /Votre panier est vide/);
});

test("a French reservation stores lang=fr and its confirmation email is French (English buyer unchanged)", async () => {
  const reserve = async (lang) => {
    const copy = await makeBookCopy();
    const buyer = await h.account({ displayName: "Marie" });
    const { order, r } = await h.reserve(buyer, { copyIds: [copy.copyId], lang, name: "Marie" });
    assert.equal(r.status, 302);
    assert.equal(order.lang, lang);
    return sent.find((m) => m.to === buyer.email);
  };
  const fr = await reserve("fr");
  assert.equal(fr.subject, "Votre réservation chez Uma's Books");
  assert.match(fr.text, /^Bonjour Marie,/);
  assert.match(fr.text, /YOUR RIGHTS/, "legal block stays bilingual");
  const en = await reserve("en");
  assert.equal(en.subject, "Your reservation at Uma's Books");
  assert.match(en.text, /^Hi Marie,/);
});

test("the reservation page (reserved) and the page of a leftover 'pending' order are translated", async () => {
  const buyer = await h.account();
  const { order } = await h.reserve(buyer, { copyIds: [(await makeBookCopy()).copyId], classIds: [await makeClass()] });
  const en = (await h.visitor(buyer, { lang: "en" }).get(`/cart/return?order=${order.access_token}`)).text;
  const fr = (await h.visitor(buyer, { lang: "fr" }).get(`/cart/return?order=${order.access_token}`)).text;
  assert.match(en, /Reservation #\d+ recorded/);
  assert.match(fr, /Réservation n°\d+ enregistrée/);
  assert.match(nb(fr), /Rien n’est payé en ligne/);
  assert.match(fr, /Annuler la réservation/);
  assert.deepEqual(untranslated(en, fr, ALLOW), []);

  const { rows } = await pool.query(
    "INSERT INTO orders (buyer_name, buyer_email, total_amount, status) VALUES ('B', 'pending@example.test', 5, 'pending') RETURNING access_token"
  );
  const enOld = (await h.visitor(null, { lang: "en" }).get(`/cart/return?order=${rows[0].access_token}`)).text;
  const frOld = (await h.visitor(null, { lang: "fr" }).get(`/cart/return?order=${rows[0].access_token}`)).text;
  assert.match(frOld, /Commande non finalisée/);
  assert.deepEqual(untranslated(enOld, frOld, ALLOW), []);
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
