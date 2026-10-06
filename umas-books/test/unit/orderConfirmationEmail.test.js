const test = require("node:test");
const assert = require("node:assert/strict");
const { buildOrderConfirmationText } = require("../../src/lib/orderEmail");

// created_at 23:30 UTC on 5 March is already 6 March in Paris; reserved_until is
// the midnight (Paris) that ENDS the last day, so the day shown is 19 March.
const order = { id: 42, buyer_name: "Ada", total_amount: "12.50", created_at: "2026-03-05T23:30:00Z", reserved_until: "2026-03-19T23:00:00Z" };
const items = [{ item_title: "Emma", price: "12.50" }];

test("EN reservation confirmation: number, Paris date, items, prices, total, pay at the shop, deadline, address and hours, how to cancel", () => {
  const t = buildOrderConfirmationText(order, items, "https://shop.test/");
  assert.match(t, /^Hi Ada,\n\nThanks for your reservation\. Nothing has been paid online: you pay at the shop when you collect\./);
  assert.match(t, /Reservation #42 — 06\/03\/2026/); // 23:30 UTC is already 6 March in Paris
  assert.match(t, /- Emma — €12\.50/);
  assert.match(t, /Total to pay at the shop: €12\.50/);
  assert.match(t, /PAY AT THE SHOP WHEN YOU COLLECT/);
  assert.match(t, /We hold your books until the end of 19 March 2026 \(Paris time\)\. After that they go back on sale\./);
  assert.match(t, /Uma's Books, Rue Peyrolière, 81000 Albi — open Tuesday to Saturday, 10:00 to 19:00\. Please quote reservation #42\. Cash, card and cheque are accepted\./, "pickup is at the shop (with the hours), not the registered office");
  assert.match(t, /TO CANCEL\nLog in and open your account page, then press “Cancel reservation”: https:\/\/shop\.test\/account/);
  assert.match(t, /Terms of sale: https:\/\/shop\.test\/terms-of-sale\.html/);
});

test("the confirmation never speaks of an online payment: no HelloAsso, no 'payment received', no 'paid online via'", () => {
  for (const lang of ["en", "fr"]) {
    const t = buildOrderConfirmationText({ ...order, lang }, items, "https://shop.test/");
    assert.doesNotMatch(t, /HelloAsso|[Pp]ayment received|paiement reçu|Paid online via|Payée en ligne/, lang);
    assert.doesNotMatch(buildOrderConfirmationText({ ...order, lang }, items, "https://shop.test/") + orderConfirmationSubject(lang), /\bOrder #|Commande n°/, `${lang}: it is a reservation`);
  }
});

test("seller identity: RNA, SIRET, registered office, phone, e-mail, and 'TVA non applicable'", () => {
  const t = buildOrderConfirmationText(order, items, "https://shop.test/");
  assert.match(t, /RNA W811011706/);
  assert.match(t, /SIRET 109 441 147 00013/);
  assert.match(t, /5 rue Hippolyte Savary, 81000 Albi/);
  assert.match(t, /TVA non applicable/);
  assert.match(t, /06 98 95 67 91/);
  assert.match(t, /admin@umasbooks\.org\nTVA non applicable/, "contact email sits in the seller block");
});

test("the confirmation carries the withdrawal information, the model form, guarantees and the mediator (CM2C), in French and English (L.221-13)", () => {
  const t = buildOrderConfirmationText({ id: 7, buyer_name: "A", total_amount: 5, created_at: new Date() }, [{ item_title: "B", price: 5 }], "");
  for (const needle of ["L.221-18", "FORMULAIRE DE RÉTRACTATION", "WITHDRAWAL FORM", "Droit de rétractation", "Right of withdrawal", "CM2C", "1641", "TVA non applicable", "YOUR RIGHTS", "VOS DROITS"]) {
    assert.ok(t.includes(needle), `missing ${needle}`);
  }
  // The right of withdrawal is stated as "where the law provides for it", never as a blanket promise to online orders.
  assert.match(t, /this right applies where the law provides for it/);
  assert.match(t, /ce droit s’applique lorsque la loi le prévoit/);
  assert.match(t, /The legal guarantees still apply, and so does the statutory right of withdrawal where the law provides for it\./);
});

test("a reservation without a base URL still says where to cancel, and omits the terms link it cannot build", () => {
  const t = buildOrderConfirmationText(order, items, "");
  assert.match(t, /press “Cancel reservation”: \/account/);
  assert.doesNotMatch(t, /terms-of-sale\.html/);
});

// ------------------------------------------------------------ languages

const { orderConfirmationSubject, LEGAL_RIGHTS, WITHDRAWAL_FORM, SELLER_LINES } = require("../../src/lib/orderEmail");

test("French reservation: French subject and body, prices, date, deadline, shop address and hours, how to cancel", () => {
  const t = buildOrderConfirmationText({ ...order, lang: "fr" }, items, "https://shop.test/");
  assert.equal(orderConfirmationSubject("fr"), "Votre réservation chez Uma's Books est confirmée");
  assert.match(t, /^Bonjour Ada,/);
  assert.match(t, /Merci pour votre réservation\. Rien n’a été payé en ligne : vous réglez à la boutique au moment du retrait\./);
  assert.match(t, /Réservation n° 42 — 06\/03\/2026/);
  assert.match(t, /Total à régler à la boutique : 12,50\u00a0€/);
  assert.match(t, /- Emma — 12,50\u00a0€/);
  assert.doesNotMatch(t, /€\d/, "no English-style price in a French email");
  assert.match(t, /À RÉGLER À LA BOUTIQUE AU RETRAIT/);
  assert.match(t, /Nous gardons vos livres jusqu’à la fin de la journée du 19 mars 2026 \(heure de Paris\)\. Passé ce délai, ils sont remis en vente\./);
  assert.match(t, /Uma's Books, rue Peyrolière, 81000 Albi — ouvert du mardi au samedi, de 10 h à 19 h\. Merci d’indiquer la réservation n° 42\. Espèces, carte bancaire et chèque sont acceptés\./);
  assert.match(t, /POUR ANNULER\nConnectez-vous, ouvrez votre page de compte puis appuyez sur « Annuler la réservation » : https:\/\/shop\.test\/account/);
  assert.match(t, /Conditions de vente : https:\/\/shop\.test\/terms-of-sale\.html/);
  assert.doesNotMatch(t, /Thanks for your reservation|Pay at the shop|^Hi /im);
});

test("French reservation keeps the bilingual legal block, withdrawal form and seller identity verbatim", () => {
  const t = buildOrderConfirmationText({ ...order, lang: "fr" }, items, "");
  for (const block of [LEGAL_RIGHTS, WITHDRAWAL_FORM, SELLER_LINES]) assert.ok(t.includes(block));
  assert.match(t, /YOUR RIGHTS/);
  assert.match(t, /VOS DROITS/);
});

test("English is the default: a missing or unknown order.lang means English", () => {
  assert.equal(orderConfirmationSubject("en"), "Your reservation at Uma's Books is confirmed");
  const base = buildOrderConfirmationText(order, items, "https://shop.test/");
  assert.match(base, /^Hi Ada,\n\nThanks for your reservation\./);
  assert.match(base, /Total to pay at the shop: €12\.50/);
  for (const lang of [undefined, null, "", "de", "FR"]) {
    assert.equal(buildOrderConfirmationText({ ...order, lang }, items, "https://shop.test/"), base, `lang ${String(lang)}`);
    assert.equal(orderConfirmationSubject(lang), "Your reservation at Uma's Books is confirmed");
  }
  assert.equal(buildOrderConfirmationText({ ...order, lang: "en" }, items, "https://shop.test/"), base);
});

test("a seat-only reservation has no book deadline; it says you pay at the session and how late a seat can be cancelled", () => {
  const seat = { item_title: "Éveil — 12 Dec, 18:00", price: "5.00", class_dropin_seat_id: 1, class_title: "Éveil", class_starts_at: "2092-12-12T17:00:00Z" };
  const seatOrder = { ...order, reserved_until: "2092-12-13T23:00:00Z", total_amount: "5.00" };
  const en = buildOrderConfirmationText(seatOrder, [seat], "https://shop.test/");
  assert.doesNotMatch(en, /We hold your books/);
  assert.match(en, /Drop-in seats: you pay at the session\. A seat can be cancelled online until \d+ hours before the session/);
  const fr = buildOrderConfirmationText({ ...seatOrder, lang: "fr" }, [seat], "https://shop.test/");
  assert.doesNotMatch(fr, /Nous gardons vos livres/);
  assert.match(fr, /Places « drop-in » : vous réglez sur place, à la séance\./);
  // Books and a seat together carry both notes.
  const both = buildOrderConfirmationText(order, [...items, seat], "https://shop.test/");
  assert.match(both, /We hold your books until the end of 19 March 2026/);
  assert.match(both, /Drop-in seats: you pay at the session/);
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
