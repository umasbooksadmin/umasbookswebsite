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

test("terms of sale page is served with guarantees, mediator, HelloAsso (membership only) and no-VAT wording, and no withdrawal notice for books", async () => {
  const res = await fetch(`${app.base}/terms-of-sale.html`);
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const needle of ["L.217-3", "1641", "CM2C", "TVA non applicable", "109 441 147 00013", "HelloAsso", "+33 6 07 41 70 60"]) {
    assert.ok(html.includes(needle), `missing ${needle}`);
  }
  // A reservation is a free hold and the sale is made in the shop: no distance-selling withdrawal notice or form for books and seats.
  for (const banned of ["L.221-18", "L.221-24", "L.221-28", "Withdrawal form", "withdraw from a book purchase"]) {
    assert.ok(!html.includes(banned), `must not contain ${banned}`);
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
  const siteJs = fs.readFileSync(path.join(__dirname, "../../../assets/i18n-common.js"), "utf8");
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
  assert.match(fr["ts.s8.p"], /CM2C/);
});

test("terms of sale (English and French): free non-binding reservation, price honoured, hold and limits, payment and condition check in the shop, no-returns clause that keeps the legal guarantees, new books at the publisher's price, no commercial guarantee", async () => {
  for (const [lang, needles] of [
    ["en", [
      "Second-hand books: no returns",
      "Reserving is free and commits you to nothing. You pay and the sale is made in the shop, after you have seen the book. Used books are not taken back, exchanged or refunded for a change of mind once bought in the shop; the legal guarantees still apply.",
      "This does not affect your legal rights as a consumer, including the legal guarantees.",
      "The price shown when you reserve is honoured for the whole time the reservation is held.",
      "released automatically, with no fee and no penalty",
      "you pay there, in cash or by card, when you collect your books",
      "You can check the condition of each book on the spot, and you are free to decline it: nothing is then due.",
      "kept for 30 days after it ends",
      "each a single copy",
      "Nothing is paid online, and reserving does not oblige you to buy.",
      "We hold your books for 14 days",
      "extend the hold once, by 7 days",
      "at most 10 books and 3 open reservations",
      "until 24 hours before the session starts",
      "Only membership is",
      "81-766 of 10 August 1981",
      "a discount of at most 5 %",
      "We give no commercial guarantee beyond the legal guarantees",
      "Collect your books during our regular hours, Wednesday to Saturday, 14:00–19:00. We are sometimes open at other times when volunteers are available, but only the regular hours are guaranteed.",
      "Prices are in euros and include all taxes",
    ]],
    ["fr", [
      "Livres d’occasion\u00a0: pas de reprise",
      "Réserver est gratuit et ne vous engage à rien. Vous payez et la vente est conclue en boutique, après avoir vu le livre. Les livres d’occasion ne sont ni repris, ni échangés, ni remboursés pour simple changement d’avis une fois achetés en boutique\u00a0; les garanties légales restent applicables.",
      "Cela ne porte pas atteinte à vos droits légaux de consommateur",
      "Le prix affiché au moment de la réservation est garanti pendant toute la durée de la réservation.",
      "sans frais ni pénalité",
      "vous y payez, en espèces ou par carte",
      "vous êtes libre de le refuser\u00a0: rien n’est alors dû",
      "conservées 30 jours après sa fin",
      "Rien n’est payé en ligne, et réserver ne vous oblige pas à acheter.",
      "Nous gardons vos livres 14 jours",
      "Seule l’adhésion se paie en ligne",
      "loi n°\u00a081-766 du 10 août 1981",
      "5\u00a0% au maximum",
      "Nous n’offrons aucune garantie commerciale en plus des garanties légales",
      "Venez retirer vos livres pendant nos horaires habituels, du mercredi au samedi, de 14\u00a0h à 19\u00a0h. Nous sommes parfois ouverts à d’autres moments selon la disponibilité des bénévoles, mais seuls les horaires habituels sont garantis.",
      "toutes taxes comprises",
    ]],
  ]) {
    const html = (await (await fetch(`${app.base}/terms-of-sale.html`, { headers: { cookie: `umasbooks_lang=${lang}` } })).text()).replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    for (const n of needles) assert.ok(html.includes(n), `${lang}: missing ${n}`);
    assert.doesNotMatch(html, /waive|renounce|renonc/i, `${lang}: never says a legal right is waived`);
    assert.doesNotMatch(html, /obligation to pay|obligation de paiement|one hour|une heure|pay online by card/i, `${lang}: no online-payment wording for books`);
    assert.doesNotMatch(html, /Last updated: 5 October|mise à jour\u00a0: 5 octobre/, `${lang}: date updated`);
  }
});

test("terms of sale: the drop-in text has no waiver, checkout or withdrawal wording (the seat is reserved free and paid at the session)", async () => {
  const html = await (await fetch(`${app.base}/terms-of-sale.html`)).text();
  assert.ok(html.includes("A drop-in seat is held until the session is over."));
  assert.ok(html.includes("For a drop-in seat, come at the session time and pay there."));
  assert.ok(!html.includes("at checkout"));
  assert.ok(!html.includes("right of withdrawal does not apply"));
});

test("footer: the Instagram icon links to the real page (new tab, noopener noreferrer, named 'Instagram', clean URL); Facebook icon beside it (EN/FR labels); no placeholder links", async () => {
  for (const headers of [{}, { cookie: "umasbooks_lang=fr" }]) {
    const html = await (await fetch(`${app.base}/terms-of-sale.html`, { headers })).text();
    assert.ok(html.includes('<a href="https://www.instagram.com/umas_books_adventures/" target="_blank" rel="noopener noreferrer" aria-label="Instagram">'));
    assert.ok(!html.includes("instagram.com/umas_books_adventures/?"), "no tracking query string");
    const fr = !!headers.cookie;
    const label = fr ? "Uma’s Books and Adventures sur Facebook" : "Uma&#39;s Books and Adventures on Facebook";
    assert.ok(html.includes(`<a href="https://www.facebook.com/share/1CgAM7gwey/" target="_blank" rel="noopener noreferrer" aria-label="${label}">`));
    assert.ok(!html.includes("mibextid"), "no tracking query string");
    assert.ok(html.indexOf('aria-label="Instagram"') < html.indexOf("facebook.com/share"), "Facebook sits beside Instagram, after it");
    assert.ok(!/href="#"[^>]*aria-label="(Instagram|Facebook)"/.test(html));
  }
});

test("footer partial: an empty Facebook address renders no Facebook link (Instagram still shows)", async () => {
  const ejs = require("ejs");
  const file = path.join(__dirname, "..", "..", "views", "partials", "mkt_chrome_footer.ejs");
  const render = (facebook) => ejs.renderFile(file, { socialLinks: { instagram: "https://www.instagram.com/x/", facebook }, tr: (en) => en });
  const without = await render("");
  assert.ok(!/facebook/i.test(without), "empty constant: no Facebook link");
  assert.ok(without.includes('aria-label="Instagram"'));
  assert.ok((await render("https://www.facebook.com/share/abc/")).includes('href="https://www.facebook.com/share/abc/"'));
});

test("membership terms: statutes, interim withdrawal statement (14 days, refund, membership ends), forum moderation (DSA), French kicker 'Informations légales'", async () => {
  const en = await (await fetch(`${app.base}/membership-terms.html`)).text();
  assert.ok(en.includes("governed by its statutes (available on request)"));
  assert.ok(en.includes("If you join online you may withdraw within 14 days by writing to admin@umasbooks.org; we will refund your payment and the membership then ends."));
  assert.ok(en.includes("Last updated: 6 October 2026."), "the date has the day");
  assert.ok(en.includes("Forum moderation") && en.includes("Digital Services Act") && en.includes("Arcom"));
  const fr = await (await fetch(`${app.base}/membership-terms.html`, { headers: { cookie: "umasbooks_lang=fr" } })).text();
  assert.ok(fr.includes("La cotisation est versée à l’association et régie par ses statuts (disponibles sur demande)."));
  assert.ok(!fr.includes("Cotisation versée à l’association, régie"), "the sentence fragment is gone");
  assert.ok(fr.includes("voter pour l’œuvre caritative que nous soutenons") && !fr.includes("voter pour l’association"));
  assert.ok(fr.includes("Dernière mise à jour\u00a0: 6 octobre 2026."));
  assert.ok(fr.includes("Si vous adhérez en ligne, vous pouvez vous rétracter dans les 14 jours en écrivant à admin@umasbooks.org\u00a0; nous vous remboursons et l’adhésion prend fin."));
  assert.ok(fr.includes("Modération du forum") && fr.includes("Arcom"));
  assert.ok(fr.includes(">Informations légales<") && !fr.includes(">Mentions légales</span>"));
  const mem = await (await fetch(`${app.base}/membership.html`, { headers: { cookie: "umasbooks_lang=fr" } })).text();
  assert.ok(mem.includes("Votez pour notre œuvre caritative trimestrielle") && !mem.includes("association trimestrielle"));
  assert.ok(mem.includes("rattachée au compte"), "the direct HelloAsso link says membership follows the account email");
});
