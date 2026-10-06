const test = require("node:test");
const assert = require("node:assert/strict");
const { buildOrderConfirmationText } = require("../../src/lib/orderEmail");

const order = { id: 42, buyer_name: "Ada", total_amount: "12.50", created_at: "2026-03-05T23:30:00Z" };
const items = [{ item_title: "Emma", price: "12.50" }];

test("order email states order number, Paris date, payment method, seller identity and VAT", () => {
  const t = buildOrderConfirmationText(order, items, "https://shop.test/");
  assert.match(t, /Order #42/);
  assert.match(t, /06\/03\/2026/); // 23:30 UTC is already 6 March in Paris
  assert.match(t, /Paid online via HelloAsso/);
  assert.match(t, /RNA W811011706/);
  assert.match(t, /SIRET 109 441 147 00013/);
  assert.match(t, /5 rue Hippolyte Savary, 81000 Albi/);
  assert.match(t, /TVA non applicable/);
  assert.match(t, /06 98 95 67 91/);
  assert.match(t, /admin@umasbooks\.org\nTVA non applicable/, "contact email sits in the seller block");
  assert.match(t, /https:\/\/shop\.test\/terms-of-sale\.html/);
  assert.match(t, /Pick up within 14 days, Tuesday to Saturday, 10:00–19:00, Rue Peyrolière, Albi\./, "pickup is at the shop (with the hours), not the registered office");
  assert.match(t, /- Emma — €12\.50/);
});

test("order email carries the withdrawal information and model form itself, in French and English (L.221-13)", () => {
  const t = buildOrderConfirmationText({ id: 7, buyer_name: "A", total_amount: 5, created_at: new Date() }, [{ item_title: "B", price: 5 }], "");
  for (const needle of ["L.221-18", "FORMULAIRE DE RÉTRACTATION", "WITHDRAWAL FORM", "Droit de rétractation", "Right of withdrawal", "CM2C", "1641", "TVA non applicable"]) {
    assert.ok(t.includes(needle), `missing ${needle}`);
  }
});

// ------------------------------------------------------------ languages

const { orderConfirmationSubject, LEGAL_RIGHTS, WITHDRAWAL_FORM, SELLER_LINES } = require("../../src/lib/orderEmail");

test("French order: French subject and body, prices, date and addresses unchanged", () => {
  const t = buildOrderConfirmationText({ ...order, lang: "fr" }, items, "https://shop.test/");
  assert.equal(orderConfirmationSubject("fr"), "Votre commande chez Uma's Books est confirmée");
  assert.match(t, /^Bonjour Ada,/);
  assert.match(t, /Merci pour votre commande — paiement reçu/);
  assert.match(t, /Commande n° 42 — 06\/03\/2026/);
  assert.match(t, /Payée en ligne via HelloAsso/);
  assert.match(t, /Total : 12,50\u00a0€/);
  assert.match(t, /- Emma — 12,50\u00a0€/);
  assert.doesNotMatch(t, /€\d/, "no English-style price in a French email");
  assert.match(t, /À retirer sous 14 jours, du mardi au samedi, 10h–19h, rue Peyrolière, Albi\./);
  assert.match(t, /Conditions de vente et votre droit de rétractation de 14 jours pour les livres : https:\/\/shop\.test\/terms-of-sale\.html/);
  assert.doesNotMatch(t, /Thanks for your order|Pick up within|^Hi /m);
});

test("French order keeps the bilingual legal block, withdrawal form and seller identity verbatim", () => {
  const t = buildOrderConfirmationText({ ...order, lang: "fr" }, items, "");
  for (const block of [LEGAL_RIGHTS, WITHDRAWAL_FORM, SELLER_LINES]) assert.ok(t.includes(block));
  assert.match(t, /YOUR RIGHTS/);
  assert.match(t, /VOS DROITS/);
});

test("English order is unchanged and a missing or unknown order.lang means English", () => {
  assert.equal(orderConfirmationSubject("en"), "Your order at Uma's Books is confirmed");
  const base = buildOrderConfirmationText(order, items, "https://shop.test/");
  assert.match(base, /^Hi Ada,\n\nThanks for your order — payment received:/);
  assert.match(base, /Total: €12\.50/);
  for (const lang of [undefined, null, "", "de", "FR"]) {
    assert.equal(buildOrderConfirmationText({ ...order, lang }, items, "https://shop.test/"), base, `lang ${String(lang)}`);
    assert.equal(orderConfirmationSubject(lang), "Your order at Uma's Books is confirmed");
  }
  assert.equal(buildOrderConfirmationText({ ...order, lang: "en" }, items, "https://shop.test/"), base);
});


// ------------------------------------------------------------ drop-in lines

const dropin = {
  item_title: "Éveil — 12 Dec, 18:00", price: "5.00", class_dropin_seat_id: 1,
  class_title: "Éveil", class_starts_at: "2092-12-12T17:00:00Z", // 18:00 in Paris
};

test("order email renders a drop-in line in the order's language, Paris time", () => {
  const fr = buildOrderConfirmationText({ ...order, lang: "fr" }, [dropin], "");
  assert.match(fr, /- Éveil — 12 déc\., 18:00 — 5,00\u00a0€/);
  assert.ok(!fr.includes("12 Dec"));
  const en = buildOrderConfirmationText({ ...order, lang: "en" }, [dropin], "");
  assert.match(en, /- Éveil — 12 Dec, 18:00 — €5\.00/);
  const none = buildOrderConfirmationText(order, [dropin], "");
  assert.match(none, /12 Dec, 18:00/);
});

test("order email falls back to the stored title when the class is gone", () => {
  const gone = { ...dropin, item_title: "Old session — 12 Dec, 18:00", class_title: null, class_starts_at: null };
  const fr = buildOrderConfirmationText({ ...order, lang: "fr" }, [gone], "");
  assert.match(fr, /- Old session — 12 Dec, 18:00 — 5,00\u00a0€/);
});

// ------------------------------------------------- terms-of-sale acceptance

test("order email states when the terms of sale were accepted (Paris date) and which version, in EN and FR", () => {
  const accepted = { ...order, cgv_accepted_at: "2026-03-05T23:30:00Z", cgv_version: "2026-10-04" };
  const en = buildOrderConfirmationText({ ...accepted, lang: "en" }, items, "");
  assert.match(en, /Terms of sale accepted on 6 March 2026 \(version 2026-10-04\)\./);
  const fr = buildOrderConfirmationText({ ...accepted, lang: "fr" }, items, "");
  assert.match(fr, /Conditions générales de vente acceptées le 6 mars 2026 \(version 2026-10-04\)\./);
});

test("order email has no acceptance line for an order placed before it was recorded", () => {
  const t = buildOrderConfirmationText(order, items, "");
  assert.doesNotMatch(t, /accepted on|acceptées le/);
});
