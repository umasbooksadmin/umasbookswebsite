// The map to the shop in the shared footer (views/partials/mkt_chrome_footer.ejs):
// alt text and caption in both languages, our own file only (CSP img-src 'self',
// no third-party request), sized to avoid layout shift, cached like other assets.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startTestApp } = require("../helpers/testApp");

const PORT = 4872;
const MAX_BYTES = 200 * 1024;
const NB = "\u00a0";
let app;
before(async () => { app = await startTestApp({ port: PORT, isolated: true }); });
after(async () => { await app.stop(); });

const get = async (p, lang) => fetch(`${app.base}${p}`, { headers: lang ? { cookie: `umasbooks_lang=${lang}` } : {} });
const footerOf = (html) => html.match(/<footer class="mkt-footer">.*?<\/footer>/s)[0];

for (const page of ["/", "/visit.html", "/books"]) {
  test(`footer map on ${page}: English alt text, own file only, sized, lazy, link to the full image`, async () => {
    const f = footerOf(await (await get(page, "en")).text());
    assert.match(f, /<img src="\/images\/shop-map-420\.jpg"[^>]*width="800" height="960" loading="lazy"/);
    assert.match(f, /alt="Map showing how to find Uma&#39;s Books and Adventures from Rue Peyrolière, Albi"/);
    assert.match(f, /<a href="\/images\/shop-map\.jpg"/);
    assert.match(f, /<figcaption[^>]*>Albi, France: Rue Peyrolière<\/figcaption>/);
    assert.ok(!/<img[^>]+src="https?:/.test(f), "no third-party image");
  });
  test(`footer map on ${page}: French alt text and caption with French typography`, async () => {
    const f = footerOf(await (await get(page, "fr")).text());
    assert.match(f, /alt="Plan pour trouver Uma’s Books and Adventures depuis la rue Peyrolière, Albi"/);
    assert.ok(f.includes(`>Albi, France${NB}: rue Peyrolière</figcaption>`));
    assert.ok(f.includes('aria-label="Ouvrir le plan en grand"'));
  });
}

test("the map files exist, are under the size cap, and are served as images with cache headers", async () => {
  for (const name of ["shop-map.jpg", "shop-map-420.jpg"]) {
    const file = path.join(__dirname, "..", "..", "public", "images", name);
    assert.ok(fs.statSync(file).size < MAX_BYTES, `${name} under ${MAX_BYTES} bytes`);
    const res = await get(`/images/${name}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    assert.match(res.headers.get("cache-control") || "", /max-age=\d+/);
  }
});

test("the CSP lets the page load the map from our own origin only", async () => {
  const csp = (await get("/visit.html")).headers.get("content-security-policy") || "";
  assert.match(csp, /img-src 'self'/);
  assert.ok(!/img-src[^;]*https?:/.test(csp));
});
