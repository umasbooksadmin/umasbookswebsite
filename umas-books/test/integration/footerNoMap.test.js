// The shared footer no longer shows the map to the shop (it was removed at the
// maintainer's request): no <img>, <figure> or map files on the main pages.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");

const PORT = 4872;
let app;
before(async () => { app = await startTestApp({ port: PORT, isolated: true }); });
after(async () => { await app.stop(); });

const footerOf = (html) => html.match(/<footer class="mkt-footer">.*?<\/footer>/s)[0];

for (const lang of ["en", "fr"]) {
  for (const page of ["/", "/visit.html", "/books"]) {
    test(`footer on ${page} (${lang}) has no map image, but keeps the Albi, France link`, async () => {
      const res = await fetch(`${app.base}${page}`, { headers: { cookie: `umasbooks_lang=${lang}` } });
      const html = await res.text();
      const f = footerOf(html);
      assert.ok(!/<img\b|<figure\b|<figcaption\b|shop-map|footer-map/i.test(f), "no map in the footer");
      assert.ok(!/shop-map/.test(html), "no reference to the removed map files");
      assert.match(f, /<a href="\/visit\.html">Albi, France<\/a>/);
    });
  }
}
