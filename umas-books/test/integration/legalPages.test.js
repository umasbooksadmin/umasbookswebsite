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
  assert.match(en, /data-i18n="visit\.hours\.time">10:00–19:00</);
  const d = dictOf(en);
  assert.equal(d.en["visit.hours.time"], "10:00–19:00");
  assert.equal(d.fr["visit.hours.time"], `10${NB}h–19${NB}h`);
  assert.equal(d.fr["visit.where.v"], "Rue Peyrolière, 81000 Albi");
  assert.ok(!JSON.stringify(d).includes("{shop"), "no placeholder is left in the dictionaries");
  const fr = await get("/visit.html", "fr");
  assert.ok(fr.includes(`10${NB}h–19${NB}h`));
  assert.doesNotMatch(fr, /10h00|\{shop/);
});

test("volunteer page: the shop shifts row uses the same hours", async () => {
  assert.match(await get("/volunteer.html"), /data-i18n="visit\.hours\.time">10:00–19:00</);
  assert.ok((await get("/volunteer.html", "fr")).includes(`10${NB}h–19${NB}h`));
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
  assert.equal(ld.openingHoursSpecification[0].opens, "10:00");
  assert.equal(ld.openingHoursSpecification[0].closes, "19:00");
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
