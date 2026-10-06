// The terms of sale page (views/marketing/terms-of-sale.ejs): served, linked
// from the footer, and carrying the legally required consumer information.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startTestApp } = require("../helpers/testApp");

const PORT = 3491;
let app;
before(async () => { app = await startTestApp({ port: PORT, isolated: true }); });
after(() => app.stop());

test("terms of sale page is served with withdrawal, guarantees, mediator and no-VAT wording", async () => {
  const res = await fetch(`${app.base}/terms-of-sale.html`);
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const needle of ["L.221-18", "14 days", "L.217-3", "1641", "CM2C", "TVA non applicable", "109 441 147 00013", "HelloAsso", "06 98 95 67 91"]) {
    assert.ok(html.includes(needle), `missing ${needle}`);
  }
});

test("terms of sale carry the D211-2 legal-guarantee box and the 12-month second-hand presumption", async () => {
  const html = await (await fetch(`${app.base}/terms-of-sale.html`)).text();
  for (const needle of [
    "D211-2",
    "garantie légale de conformité",
    "deux ans à compter de la délivrance du bien",
    "trente jours",
    "L. 217-1 à L. 217-32",
    "articles 1641 à 1649 du code civil",
    "douze mois",
    "12 months",
    "courtesy translation",
  ]) {
    assert.ok(html.includes(needle), `missing ${needle}`);
  }
});

test("membership terms describe the instant HelloAsso flow, 12-month duration and email matching", async () => {
  const res = await fetch(`${app.base}/membership-terms.html`);
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const needle of ["HelloAsso", "12 months", "October 2026", "verified", "privacy-policy.html"]) {
    assert.ok(html.includes(needle), `missing ${needle}`);
  }
  assert.ok(!html.includes("payment instructions"), "old manual-review wording is gone");
  const src = fs.readFileSync(path.join(__dirname, "../../views/marketing/membership-terms.ejs"), "utf8");
  const dict = (name) => new Function(`return ${src.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n\\});`))[1]}`)();
  assert.deepStrictEqual(Object.keys(dict("pageI18nFr")).sort(), Object.keys(dict("pageI18nEn")).sort());
});

test("the footer links to the terms of sale, in both languages", async () => {
  const html = await (await fetch(`${app.base}/`)).text();
  assert.match(html, /href="\/terms-of-sale\.html"/);
  const siteJs = fs.readFileSync(path.join(__dirname, "../../../assets/site.js"), "utf8");
  assert.match(siteJs, /"foot\.terms": "Terms of Sale"/);
  assert.match(siteJs, /"foot\.terms": "Conditions générales de vente"/);
});

test("terms of sale: EN and FR dictionaries have the same keys and cover every section", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../views/marketing/terms-of-sale.ejs"), "utf8");
  const dict = (name) => new Function(`return ${src.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n\\});`))[1]}`)();
  const en = dict("pageI18nEn");
  const fr = dict("pageI18nFr");
  assert.deepStrictEqual(Object.keys(fr).sort(), Object.keys(en).sort());
  for (const k of [...src.matchAll(/data-i18n(?:-html)?="(ts\.[^"]+)"/g)].map((m) => m[1])) {
    assert.ok(k in en && k in fr, k);
  }
  assert.match(fr["ts.s5.p"], /L\.221-18/);
  assert.match(fr["ts.s8.p"], /CM2C/);
});

test("terms of sale (English and French): used-book no-returns clause that keeps the legal rights, new books at the publisher's price, no commercial guarantee, L.221-24 refund timing", async () => {
  for (const [lang, needles] of [
    ["en", [
      "Second-hand books: no returns",
      "Used books: no returns or exchanges for a change of mind in the shop. For online orders, your statutory 14-day right of withdrawal and the legal guarantees still apply.",
      "This does not affect your legal rights as a consumer, including the right of withdrawal for online orders described below and the legal guarantees.",
      "81-766 of 10 August 1981",
      "a discount of at most 5 %",
      "We give no commercial guarantee beyond the legal guarantees",
      "we may withhold the refund until we have the book back or you have shown proof that you returned it",
      "Tuesday to Saturday, 10:00–19:00",
      "Order with obligation to pay",
      "Prices are in euros and include all taxes",
    ]],
    ["fr", [
      "Livres d’occasion\u00a0: pas de reprise",
      "Livres d’occasion\u00a0: pas de reprise ni d’échange pour simple changement d’avis en boutique. Pour les achats en ligne, votre droit légal de rétractation de 14 jours (art. L.221-18) et les garanties légales de conformité et des vices cachés restent applicables.",
      "Cela ne porte pas atteinte à vos droits légaux de consommateur",
      "loi n°\u00a081-766 du 10 août 1981",
      "5\u00a0% au maximum",
      "Nous n’offrons aucune garantie commerciale en plus des garanties légales",
      "nous pouvons différer le remboursement jusqu’à la récupération du livre",
      "du mardi au samedi, de 10h à 19h",
      "Commander avec obligation de paiement",
      "toutes taxes comprises",
    ]],
  ]) {
    const html = (await (await fetch(`${app.base}/terms-of-sale.html`, { headers: { cookie: `umasbooks_lang=${lang}` } })).text()).replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    for (const n of needles) assert.ok(html.includes(n), `${lang}: missing ${n}`);
    assert.doesNotMatch(html, /waive|renounce|renonc/i, `${lang}: never says a legal right is waived`);
    assert.doesNotMatch(html, /Last updated: 5 October|mise à jour\u00a0: 5 octobre/, `${lang}: date updated`);
  }
});

test("terms of sale: the drop-in text no longer contradicts itself (no right of withdrawal under L.221-28 12°, the checkbox only confirms the date)", async () => {
  const html = await (await fetch(`${app.base}/terms-of-sale.html`)).text();
  assert.ok(html.includes("the right of withdrawal does not apply to them (art. L.221-28, 12°); at checkout you only confirm that you want the session to take place on the date booked"));
  assert.ok(!html.includes("because at checkout you expressly ask"));
});

test("footer: no placeholder social links while SOCIAL_LINKS is empty", async () => {
  const html = await (await fetch(`${app.base}/terms-of-sale.html`)).text();
  assert.ok(!/href="#"[^>]*aria-label="(Instagram|Facebook)"/.test(html));
  assert.ok(!html.includes("coming soon") || !html.includes("h-social"));
});

test("membership terms: statutes, neutral withdrawal statement, forum moderation (DSA), French kicker 'Informations légales'", async () => {
  const en = await (await fetch(`${app.base}/membership-terms.html`)).text();
  assert.ok(en.includes("governed by its statutes (available on request)"));
  assert.ok(en.includes("The legal right of withdrawal for distance contracts applies where the law provides for it."));
  assert.ok(en.includes("Forum moderation") && en.includes("Digital Services Act") && en.includes("Arcom"));
  const fr = await (await fetch(`${app.base}/membership-terms.html`, { headers: { cookie: "umasbooks_lang=fr" } })).text();
  assert.ok(fr.includes("Cotisation versée à l’association, régie par ses statuts (disponibles sur demande)."));
  assert.ok(fr.includes("Le droit légal de rétractation applicable aux contrats conclus à distance s’applique dans les cas prévus par la loi."));
  assert.ok(fr.includes("Modération du forum") && fr.includes("Arcom"));
  assert.ok(fr.includes(">Informations légales<") && !fr.includes(">Mentions légales</span>"));
  const mem = await (await fetch(`${app.base}/membership.html`, { headers: { cookie: "umasbooks_lang=fr" } })).text();
  assert.ok(mem.includes("Votez pour notre œuvre caritative trimestrielle") && !mem.includes("association trimestrielle"));
  assert.ok(mem.includes("rattachée au compte"), "the direct HelloAsso link says membership follows the account email");
});
