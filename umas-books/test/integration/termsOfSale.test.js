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
