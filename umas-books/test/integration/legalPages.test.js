// Rendered legal pages follow the constants in src/lib/legal.js (street, hours,
// membership price) in English and French, and the membership page shows no
// price while MEMBERSHIP_PRICE_EUR is empty.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");

const PORT = 4871;
const NB = " ";
let app;
before(async () => { app = await startTestApp({ port: PORT, isolated: true }); });
after(async () => { await app.stop(); });

const get = async (p, lang) => (await fetch(`${app.base}${p}`, { headers: lang ? { cookie: `umasbooks_lang=${lang}` } : {} })).text();
const dictOf = (html) => JSON.parse(html.match(/window\.PAGE_I18N = (\{.*?\});\s*<\/script>/s)[1]);

test("visit page: street and hours from the constants, in the page and in both dictionaries", async () => {
  const en = await get("/visit.html");
  assert.match(en, /<span class="value" data-i18n="visit\.where\.v">Rue Peyrolière, 81000 Albi<\/span>/);
  assert.match(en, /data-i18n="visit\.hours\.time">14:00–19:00</);
  const d = dictOf(en);
  assert.equal(d.en["visit.hours.time"], "14:00–19:00");
  assert.equal(d.fr["visit.hours.time"], `14${NB}h–19${NB}h`);
  assert.equal(d.fr["visit.where.v"], "Rue Peyrolière, 81000 Albi");
  assert.ok(!JSON.stringify(d).includes("{shop"), "no placeholder is left in the dictionaries");
  const fr = await get("/visit.html", "fr");
  assert.ok(fr.includes(`14${NB}h–19${NB}h`));
  assert.doesNotMatch(fr, /10h00|\{shop/);
});

test("volunteer page: the shop shifts row uses the same hours", async () => {
  assert.match(await get("/volunteer.html"), /data-i18n="visit\.hours\.time">14:00–19:00</);
  assert.ok((await get("/volunteer.html", "fr")).includes(`14${NB}h–19${NB}h`));
});

test("legal notice: the shop line follows the street constant; no placeholder leaks", async () => {
  const en = await get("/mentions-legales.html");
  assert.ok(en.includes("<strong>Shop:</strong> Rue Peyrolière, 81000 Albi, France"));
  assert.ok(!en.includes("{shop"));
  const fr = await get("/mentions-legales.html", "fr");
  assert.ok(fr.includes(`<strong>Boutique${NB}:</strong> Rue Peyrolière, 81000 Albi, France`));
  assert.ok(!fr.includes("{shop"));
});

test("home page structured data: street and opening hours from the constants", async () => {
  const html = await get("/");
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(ld.address.streetAddress, "Rue Peyrolière");
  assert.equal(ld.openingHoursSpecification.length, 1, "the regular hours only: no extras in structured data");
  assert.deepEqual(ld.openingHoursSpecification[0].dayOfWeek, ["Wednesday", "Thursday", "Friday", "Saturday"]);
  assert.equal(ld.openingHoursSpecification[0].opens, "14:00");
  assert.equal(ld.openingHoursSpecification[0].closes, "19:00");
});

test("visit and volunteer pages show the SHORT hours text (regular hours + extra openings when volunteers are available), in EN and FR", async () => {
  const legal = require("../../src/lib/legal");
  for (const page of ["/visit.html", "/volunteer.html"]) {
    const en = await get(page);
    assert.ok(en.includes('Open Wednesday to Saturday, 14:00–19:00. Extra opening hours when volunteers are available: see our <a href="https://www.instagram.com/umas_books_adventures/" target="_blank" rel="noopener noreferrer">Instagram</a>.'), `${page} EN`);
    const fr = await get(page, "fr");
    assert.ok(fr.includes(legal.shopHoursShort("fr", true)), `${page} FR`);
    assert.ok(fr.includes(`Ouvert du mercredi au samedi, de 14${NB}h à 19${NB}h. Ouvertures supplémentaires selon la disponibilité des bénévoles${NB}: voir notre <a href=`));
    assert.doesNotMatch(en + fr, /Tuesday|mardi|Tue &ndash;/);
  }
});

test("membership page: no price and no placeholder while MEMBERSHIP_PRICE_EUR is empty", async () => {
  for (const lang of [undefined, "fr"]) {
    const html = await get("/membership.html", lang);
    assert.ok(!html.includes('class="mem-widget-note mem-price"'), `no price paragraph (${lang || "en"})`);
    assert.ok(!html.includes("{membershipPrice}"));
    assert.match(html, /mem-widget-wrap/);
  }
  const d = dictOf(await get("/membership.html"));
  assert.equal(d.en["mem.price"], "Membership fee: <strong></strong> for 12 months, paid on the HelloAsso form.");
});
