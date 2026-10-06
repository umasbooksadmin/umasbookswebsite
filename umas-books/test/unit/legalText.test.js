// The "no returns" wording: one source (src/lib/legalText.js), the same sentence
// in the terms of sale, the order email, the cart and the book page; it never
// says legal rights are waived; the VAT line follows one constant.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const legalText = require("../../src/lib/legalText");
const legal = require("../../src/lib/legal");
const { buildOrderConfirmationText, LEGAL_RIGHTS } = require("../../src/lib/orderEmail");

const NB = " ";
const view = (f) => fs.readFileSync(path.join(__dirname, "../../views", f), "utf8");

function dict(file, name) {
  const m = view(file).match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n\\});`));
  return new Function(`return ${m[1]}`)();
}

test("the no-returns notice is the agreed wording, in English and in French", () => {
  assert.equal(
    legalText.NO_RETURNS.en,
    "Used books: no returns or exchanges for a change of mind in the shop. For online orders, your statutory 14-day right of withdrawal and the legal guarantees still apply."
  );
  assert.equal(
    legalText.NO_RETURNS.fr,
    `Livres d’occasion${NB}: pas de reprise ni d’échange pour simple changement d’avis en boutique. Pour les achats en ligne, votre droit légal de rétractation de 14 jours (art. L.221-18) et les garanties légales de conformité et des vices cachés restent applicables.`
  );
});

test("the terms of sale dictionaries, the order email and the legal strings carry the same notice", () => {
  const en = dict("marketing/terms-of-sale.ejs", "pageI18nEn");
  const fr = dict("marketing/terms-of-sale.ejs", "pageI18nFr");
  assert.ok(en["ts.nr.p"].startsWith(legalText.NO_RETURNS.en), "EN terms clause starts with the notice");
  assert.ok(fr["ts.nr.p"].startsWith(legalText.NO_RETURNS.fr), "FR terms clause starts with the notice");
  assert.match(en["ts.nr.p"], /This does not affect your legal rights as a consumer, including the right of withdrawal for online orders described below and the legal guarantees\.$/);
  assert.match(fr["ts.nr.p"], /Cela ne porte pas atteinte à vos droits légaux de consommateur/);
  assert.ok(LEGAL_RIGHTS.includes(legalText.NO_RETURNS.en) && LEGAL_RIGHTS.includes(legalText.NO_RETURNS.fr));
  // The English body of the page is the English dictionary (no second copy that can drift).
  const body = view("marketing/terms-of-sale.ejs");
  assert.ok(body.includes(`<p data-i18n="ts.nr.p">${en["ts.nr.p"]}</p>`));
});

test("EN and FR terms dictionaries have the same keys", () => {
  for (const f of ["terms-of-sale", "membership-terms", "mentions-legales"]) {
    const en = Object.keys(dict(`marketing/${f}.ejs`, "pageI18nEn")).sort();
    const fr = Object.keys(dict(`marketing/${f}.ejs`, "pageI18nFr")).sort();
    assert.deepEqual(fr, en, f);
  }
});

test("no customer-facing text says a legal right is waived, and none promises returns, refunds on request or exchanges", () => {
  const files = ["marketing/terms-of-sale.ejs", "marketing/membership-terms.ejs", "book_detail.ejs", "cart.ejs"];
  const texts = [JSON.stringify(legalText.legalFor("en")), JSON.stringify(legalText.legalFor("fr")), LEGAL_RIGHTS, ...files.map(view)];
  for (const t of texts) {
    assert.doesNotMatch(t, /waive[sd]? (your|any|the)|renonc|you give up your/i);
    assert.doesNotMatch(t, /money.back|satisfaction guarantee|not satisfied|satisfait ou remboursé|you may return (it|the book) within|full refund (if|when) you/i);
  }
});

test("French strings use no-break spaces before : and %", () => {
  for (const v of Object.values(legalText.legalFor("fr"))) assert.doesNotMatch(v, / [:;!?%]/);
});

test("the VAT line is 'TVA non applicable' until VAT_NOTICE_ARTICLE is set, then names the article, everywhere", () => {
  assert.equal(legal.VAT_NOTICE_ARTICLE, "", "ships empty until the accountant answers");
  assert.equal(legalText.vatNotice(), "TVA non applicable");
  assert.equal(legalText.priceLine("fr"), "Prix TTC, TVA non applicable");
  assert.equal(legalText.priceLine("en"), "Price incl. tax, TVA non applicable");
  const order = { id: 1, buyer_name: "A", total_amount: 5, created_at: new Date() };
  const before = buildOrderConfirmationText(order, [{ item_title: "B", price: 5 }], "");
  assert.match(before, /\nTVA non applicable$/);
  legal.VAT_NOTICE_ARTICLE = "293 B";
  try {
    assert.equal(legalText.vatNotice(), "TVA non applicable, art. 293 B du CGI");
    assert.equal(legalText.priceLine("fr"), "Prix TTC, TVA non applicable, art. 293 B du CGI");
    assert.match(buildOrderConfirmationText(order, [{ item_title: "B", price: 5 }], ""), /\nTVA non applicable, art\. 293 B du CGI$/);
    const filled = legalText.fillVat({ a: "x (<em>{vat}</em>)", b: 3 });
    assert.deepEqual(filled, { a: "x (<em>TVA non applicable, art. 293 B du CGI</em>)", b: 3 });
  } finally {
    legal.VAT_NOTICE_ARTICLE = "";
  }
});

test("the order email gives the pickup days and hours, in both languages", () => {
  const o = { id: 1, buyer_name: "A", total_amount: 5, created_at: new Date() };
  assert.match(buildOrderConfirmationText(o, [{ item_title: "B", price: 5 }], ""), /Pick up within 14 days, Tuesday to Saturday, 10:00–19:00, Rue Peyrolière, Albi\./);
  assert.match(buildOrderConfirmationText({ ...o, lang: "fr" }, [{ item_title: "B", price: 5 }], ""), /À retirer sous 14 jours, du mardi au samedi, 10\u00a0h–19\u00a0h, rue Peyrolière, Albi\./);
});

test("the pickup hours match the opening hours in the home page's structured data", () => {
  const home = view("marketing/index.ejs");
  assert.match(home, /dayOfWeek: \["Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"\]/);
  // The home page reads the same constants as the pickup line (lib/legal.js SHOP_OPENS / SHOP_CLOSES / SHOP_HOURS_*).
  assert.match(home, /opens: legalText\.shopOpens/);
  assert.match(home, /closes: legalText\.shopCloses/);
  assert.equal(`${legal.SHOP_OPENS}–${legal.SHOP_CLOSES}`, legal.SHOP_HOURS_EN);
});

test("the terms of sale version was bumped for this change", () => {
  assert.equal(legal.TERMS_OF_SALE_VERSION, "2026-10-06");
});
