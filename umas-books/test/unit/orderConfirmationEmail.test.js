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
  assert.match(t, /https:\/\/shop\.test\/terms-of-sale\.html/);
  assert.match(t, /Rue Peyrolière, 81000 Albi\) during opening hours/, "pickup is at the shop, not the registered office");
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
  assert.match(t, /Total : €12\.50/);
  assert.match(t, /- Emma — €12\.50/);
  assert.match(t, /Rue Peyrolière, 81000 Albi\) pendant les heures d’ouverture/);
  assert.match(t, /Conditions de vente et votre droit de rétractation de 14 jours pour les livres : https:\/\/shop\.test\/terms-of-sale\.html/);
  assert.doesNotMatch(t, /Thanks for your order|Come by Uma's Books|^Hi /m);
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

