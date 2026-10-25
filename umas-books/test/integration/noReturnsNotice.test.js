// The short "second-hand books are not taken back or refunded" notice (legalText.NO_RETURNS_SHORT): ONE
// wording, shown (EN + FR) on the reservation receipt and the account's reservations, and in the reminder and
// expiry e-mails to the customer; the confirmation e-mail, the cart and the book page carry the fuller
// sentence (legalText.NO_RETURNS). It is NOT in the shop's own e-mails, the seat reminder or the membership
// pages, it never waives a legal right, and it says nothing about new books.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { reserveHarness } = require("../helpers/reserveHarness");

process.env.APP_BASE_URL = "https://shop.example.test";
const h = reserveHarness("no_returns_notice");
const sweeps = require("../../src/lib/orderSweeps");
const legalText = require("../../src/lib/legalText");
const { pool } = h;
before(() => h.start());
after(() => h.stop());
beforeEach(() => { h.sent.length = 0; });

const NB = "\u00a0";
const EN = "Second-hand books are not taken back or refunded for a change of mind. Your legal guarantees still apply.";
const FR = `Les livres d’occasion ne sont ni repris ni remboursés pour simple changement d’avis. Vos garanties légales restent applicables.`;
const EN_URL = "https://shop.example.test/terms-of-sale.html";
const FR_URL = "https://shop.example.test/fr/terms-of-sale.html";

const reservedOne = async (lang) => {
  const buyer = await h.account({ displayName: "Notice Person", lang });
  const copy = await h.copy({ title: `Notice Book ${h.uniq()}` });
  const { order, v } = await h.reserve(buyer, { copyIds: [copy], lang });
  return { buyer, copy, order, v };
};

test("the notice wording is the agreed one, in one place, with the right terms-of-sale address in each language", () => {
  assert.equal(legalText.NO_RETURNS_SHORT.en, EN);
  assert.equal(legalText.NO_RETURNS_SHORT.fr, FR);
  assert.equal(legalText.noReturnsShortPlain("en", "https://x.test/"), `${EN} See our Terms of sale: https://x.test/terms-of-sale.html`);
  assert.equal(legalText.noReturnsShortPlain("fr", "https://x.test"), `${FR} Voir nos conditions de vente${NB}: https://x.test/fr/terms-of-sale.html`);
  assert.equal(legalText.noReturnsShortPlain("fr", ""), FR, "without a public address: the sentence, no relative link");
  const fr = legalText.legalFor("fr");
  const en = legalText.legalFor("en");
  assert.equal(fr.noReturnsLinkPath, "/fr/terms-of-sale.html");
  assert.equal(en.noReturnsLinkPath, "/terms-of-sale.html");
  for (const t of [EN, FR]) {
    assert.doesNotMatch(t, /waive|renonc|new book|livres neufs/i);
    assert.match(t, /legal guarantees|garanties légales/);
  }
});

test("the full sentence says 'refunded' too, and the terms of sale clause starts with exactly it", () => {
  assert.match(legalText.NO_RETURNS.en, /not taken back, exchanged or refunded for a change of mind/);
  assert.match(legalText.NO_RETURNS.fr, /ni repris, ni échangés, ni remboursés pour simple changement d’avis/);
});

for (const lang of ["en", "fr"]) {
  const short = lang === "fr" ? FR : EN;
  const label = lang === "fr" ? "conditions de vente" : "Terms of sale";
  const href = lang === "fr" ? "/fr/terms-of-sale.html" : "/terms-of-sale.html";
  const norm = (s) => s.replace(/&#39;/g, "'").replace(/\s+/g, " ");

  test(`${lang}: the reservation receipt and the account's reservations carry the notice and link to the ${lang} terms`, async () => {
    const { buyer, order, v } = await reservedOne(lang);
    const receipt = await v.get(`/cart/return?order=${order.access_token}`);
    assert.equal(receipt.status, 200);
    const account = await h.visitor(buyer, { lang }).get("/account");
    assert.equal(account.status, 200);
    for (const page of [receipt, account]) {
      const text = norm(page.text);
      assert.ok(text.includes(lang === "fr" ? short.replace(/ ([;:!?])/g, `${NB}$1`) : short), `${lang} notice missing`);
      assert.ok(page.text.includes(`<a href="${href}">${label}</a>`), `link to ${href}`);
      assert.equal(page.text.split("no-returns-note").length - 1, 1, "once per page");
    }
  });

  test(`${lang}: the reminder and expiry e-mails carry the notice with the plain ${lang} terms address; the seat reminder and shop mails do not`, async () => {
    const due = await reservedOne(lang);
    const lapsed = await reservedOne(lang);
    await pool.query("UPDATE orders SET reserved_until = now() + interval '3 days' WHERE id = $1", [due.order.id]);
    await pool.query("UPDATE orders SET reserved_until = now() - interval '1 minute' WHERE id = $1", [lapsed.order.id]);
    h.sent.length = 0;
    await sweeps.runOrderFollowUps(pool);
    const url = lang === "fr" ? FR_URL : EN_URL;
    const expected = legalText.noReturnsShortPlain(lang, "https://shop.example.test");
    assert.ok(expected.endsWith(url));
    for (const who of [due, lapsed]) {
      const mails = h.emailsTo(who.buyer.email);
      assert.equal(mails.length, 1);
      assert.ok(mails[0].text.includes(expected), `${lang}: notice in "${mails[0].subject}"`);
    }
    // The shop's own mails (digest to the shop) never carry it.
    await pool.query("UPDATE orders SET reserved_until = now() + interval '1 day' WHERE id = $1", [due.order.id]);
    h.sent.length = 0;
    await sweeps.sendAdminReservationDigest(pool);
    assert.ok(h.sent.length >= 1);
    for (const m of h.sent) assert.doesNotMatch(m.text, /Second-hand books are not taken back|livres d’occasion ne sont ni repris ni remboursés/);
  });

  test(`${lang}: the confirmation e-mail carries the full sentence with 'refunded', and the cart page the same`, async () => {
    const { buyer, v } = await reservedOne(lang);
    const mail = h.emailsTo(buyer.email)[0];
    const full = legalText.NO_RETURNS[lang];
    assert.ok(mail.text.includes(full), "full no-returns sentence in the confirmation");
    assert.match(mail.text, lang === "fr" ? /ni remboursés/ : /exchanged or refunded/);
    const cart = await v.get("/cart");
    assert.equal(cart.status, 200);
  });
}

test("seat-only reminder gets no notice (no books)", () => {
  const { buildSeatReminder } = require("../../src/lib/orderEmail");
  const m = buildSeatReminder({ id: 1, lang: "en", buyer_name: "A" }, { class_dropin_seat_id: 1, label: "Seat" });
  assert.doesNotMatch(m.text, /Second-hand/);
});
