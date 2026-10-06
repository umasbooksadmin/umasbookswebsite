// Preview mode (PREVIEW_MODE=true, src/lib/preview.js): the "coming soon"
// banner on every customer page, checkout and the membership widget switched
// off, search engines kept out, the admin reminder, and the contact topic.
// A second app without the variable proves normal mode is unchanged.
//
// Ports 3810 (preview) and 3811 (normal) are reserved for this file.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { Client } = require("pg");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken, waitForCartCount } = require("../helpers/httpClient");
const { untranslated } = require("../helpers/i18nAudit");

const PREVIEW_PORT = 3810;
const NORMAL_PORT = 3811;
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const PASSWORD = "PreviewMode1!Test";

const EN_TEXT = "Preview — Uma’s Books is opening soon. You’re looking at a test version with sample books: nothing here is real yet and no payment is taken.";
const FR_TEXT = "Aperçu — Uma’s Books ouvre bientôt. Vous découvrez une version de test avec des livres d’exemple\u00a0: rien n’est réel pour l’instant et aucun paiement n’est pris.";
const PAGES = ["/", "/books.html", "/membership.html", "/cart", "/login", "/contact", "/no-such-page"];

let preview, normal, db, copyId;

before(async () => {
  preview = await startTestApp({
    port: PREVIEW_PORT,
    isolated: true,
    // Credentials that look real: only preview mode may stop a checkout.
    env: { PREVIEW_MODE: "true", HELLOASSO_CLIENT_ID: "x", HELLOASSO_CLIENT_SECRET: "y", HELLOASSO_ORG_SLUG: "z", HELLOASSO_API_BASE: "http://127.0.0.1:9" },
  });
  normal = await startTestApp({ port: NORMAL_PORT, isolated: true, env: { PREVIEW_MODE: "" } });
  db = new Client({ connectionString: preview.databaseUrl });
  await db.connect();
  const { rows: b } = await db.query("INSERT INTO books (title, authors) VALUES ('Preview Book', 'Preview Author') RETURNING id");
  const { rows: c } = await db.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 6.5, 'very_good') RETURNING id", [b[0].id]);
  copyId = c[0].id;
});

after(async () => {
  await db.end();
  await preview.stop();
  await normal.stop();
});

const get = (app, path, lang) => fetch(`${app.base}${path}`, { headers: lang ? { cookie: `umasbooks_lang=${lang}` } : {} });
const bannerOf = (html) => (html.match(/<div class="preview-banner"[\s\S]*?<\/div>/) || [""])[0];
const unescape = (s) => s.replace(/&#39;/g, "'").replace(/&amp;/g, "&");

test("banner is on every customer page, in English and in French", async () => {
  for (const path of PAGES) {
    const en = await (await get(preview, path, "en")).text();
    const fr = await (await get(preview, path, "fr")).text();
    for (const [html, text, lang] of [[en, EN_TEXT, "en"], [fr, FR_TEXT, "fr"]]) {
      const banner = bannerOf(html);
      assert.match(banner, /role="region"/, `${path} ${lang}: region role`);
      assert.match(banner, /aria-label="[^"]+"/, `${path} ${lang}: aria-label`);
      assert.ok(unescape(banner).includes(text), `${path} ${lang}: banner text`);
      assert.match(banner, /href="\/contact\?topic=feedback"/, `${path} ${lang}: feedback link`);
      assert.match(html, /<meta name="robots" content="noindex, nofollow">/, `${path} ${lang}: robots meta`);
      // At the very top: before the site header.
      assert.ok(html.indexOf("preview-banner") < html.indexOf("<header"), `${path} ${lang}: banner before header`);
    }
    // The banner text itself differs between the two renders.
    assert.notEqual(bannerOf(en), bannerOf(fr));
  }
});

test("banner-bearing pages have no untranslated text in preview mode (EN vs FR audit)", async () => {
  for (const path of ["/", "/membership.html", "/cart", "/contact?topic=feedback", "/no-such-page"]) {
    const en = await (await get(preview, path, "en")).text();
    const fr = await (await get(preview, path, "fr")).text();
    const left = untranslated(en, fr).filter((t) => !/^(Uma.?s Books|Preview Book|Preview Author)/i.test(t));
    // Marketing pages carry their text in client-side dictionaries; only the
    // preview strings must be translated server-side everywhere.
    const preview_ = left.filter((t) => /preview|aperçu|opening soon|ouvre bientôt|Tell us|Dites-nous|launch|lancement/i.test(t));
    assert.deepEqual(preview_, [], `${path}: preview text identical in EN and FR`);
  }
});

test("without PREVIEW_MODE there is no banner, no robots meta and no X-Robots-Tag", async () => {
  for (const path of PAGES) {
    const res = await get(normal, path, "en");
    const html = await res.text();
    assert.ok(!html.includes("preview-banner"), `${path}: no banner`);
    assert.ok(!/noindex, nofollow/.test(html), `${path}: no robots meta`);
    assert.equal(res.headers.get("x-robots-tag"), null, `${path}: no X-Robots-Tag`);
  }
  const robots = await (await get(normal, "/robots.txt")).text();
  assert.match(robots, /Allow: \//);
  const sitemap = await (await get(normal, "/sitemap.xml")).text();
  assert.match(sitemap, /<loc>/);
  // Normal mode: a guest gets the join form (the payment widget follows it, or
  // shows directly for a logged-in account: see membershipAccount.test.js).
  const guestMembership = await (await get(normal, "/membership.html")).text();
  assert.match(guestMembership, /action="\/membership\/join"/);
  assert.doesNotMatch(guestMembership, /id="haWidget"/);
});

test("search engines: X-Robots-Tag, robots.txt, empty sitemap", async () => {
  for (const path of ["/", "/cart", "/robots.txt", "/sitemap.xml", "/style.css", "/no-such-page"]) {
    assert.equal((await get(preview, path)).headers.get("x-robots-tag"), "noindex, nofollow", path);
  }
  const robots = await (await get(preview, "/robots.txt")).text();
  assert.equal(robots, "User-agent: *\nDisallow: /\n");
  const sitemap = await (await get(preview, "/sitemap.xml")).text();
  assert.match(sitemap, /<urlset[^>]*>\s*<\/urlset>/);
  assert.ok(!sitemap.includes("<url>"));
});

test("membership page replaces the HelloAsso widget with a notice", async () => {
  for (const [lang, h] of [["en", "Membership opens at launch"], ["fr", "L’adhésion ouvrira au lancement"]]) {
    const html = await (await get(preview, "/membership.html", lang)).text();
    assert.ok(!html.includes("haWidget"), "no widget element");
    assert.ok(!html.includes("<iframe"), "no iframe");
    assert.ok(!/<a [^>]*href="https:\/\/www\.helloasso\.com/.test(html), "no link into HelloAsso");
    assert.ok(html.includes(h), `${lang}: notice`);
  }
});

async function cartJar() {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(preview.base, jar);
  const add = await fetch(`${preview.base}/cart/add`, {
    method: "POST", redirect: "manual", headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ copyId: String(copyId), _csrf: token }).toString(),
  });
  assert.equal(add.status, 302, "adding to the cart still works");
  jar.capture(add);
  await waitForCartCount(preview.base, jar, 1); // the 302 can arrive before the session write lands
  return jar;
}

test("cart: no checkout form, friendly notice; checkout POST is refused and creates nothing", async () => {
  const jar = await cartJar();
  const page = await (await fetch(`${preview.base}/cart`, { headers: { cookie: jar.header() } })).text();
  assert.ok(page.includes("Preview Book"), "cart still lists the item");
  assert.ok(page.includes("Online ordering opens when we launch."));
  assert.ok(!page.includes('action="/cart/checkout"'), "no checkout form");
  assert.ok(page.includes('action="/cart/remove"'), "remove still works");

  const fr = await (await fetch(`${preview.base}/cart`, { headers: { cookie: `${jar.header()}; umasbooks_lang=fr` } })).text();
  assert.ok(fr.includes("La commande en ligne ouvrira au lancement."));

  const token = await fetchCsrfToken(preview.base, jar);
  const res = await fetch(`${preview.base}/cart/checkout`, {
    method: "POST", redirect: "manual", headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ name: "Buyer", email: "buyer@example.test", acceptCgv: "on", _csrf: token }).toString(),
  });
  const body = await res.text();
  assert.equal(res.status, 403);
  assert.ok(body.includes("Online ordering opens when we launch."));
  const { rows: orders } = await db.query("SELECT count(*)::int AS n FROM orders");
  assert.equal(orders[0].n, 0, "no order row (so no HelloAsso call either)");
  const { rows: copy } = await db.query("SELECT status FROM book_copies WHERE id = $1", [copyId]);
  assert.equal(copy[0].status, "in_stock", "copy was not locked");
});

test("contact: feedback topic offered, pre-selected by ?topic=feedback, stored in English", async () => {
  const html = await (await get(preview, "/contact?topic=feedback", "fr")).text();
  assert.match(html, /<option value="Feedback on the preview" selected>Avis sur l’aperçu<\/option>/);
  const plain = await (await get(preview, "/contact", "en")).text();
  assert.match(plain, /<option value="Feedback on the preview">Feedback on the preview<\/option>/);
  assert.ok(!/value="Feedback on the preview" selected/.test(plain));
  // Normal mode does not offer it.
  assert.ok(!(await (await get(normal, "/contact?topic=feedback")).text()).includes("Feedback on the preview"));
});

async function adminJar(app, connectionString) {
  const c = new Client({ connectionString });
  await c.connect();
  const email = `preview-admin-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  await c.query(
    "INSERT INTO users (email, password_hash, display_name, is_admin, email_verified_at) VALUES ($1, $2, 'Admin', true, now())",
    [email, await bcrypt.hash(PASSWORD, 10)]
  );
  await c.end();
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual", headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ email, password: PASSWORD, _csrf: token }).toString(),
  });
  jar.capture(res);
  assert.equal(res.status, 302);
  return jar;
}

test("admin screens show the red reminder only in preview mode, and no customer banner", async () => {
  const pj = await adminJar(preview, preview.databaseUrl);
  const html = await (await fetch(`${preview.base}/admin`, { headers: { cookie: pj.header() } })).text();
  assert.match(html, /class="admin-preview-note"[^>]*>PREVIEW MODE is ON: payments are disabled and the public site shows the coming-soon banner\. Remove the PREVIEW_MODE setting in Render to launch\./);
  assert.ok(!html.includes("preview-banner"));

  const nj = await adminJar(normal, normal.databaseUrl);
  const nhtml = await (await fetch(`${normal.base}/admin`, { headers: { cookie: nj.header() } })).text();
  assert.ok(nhtml.includes("admin-layout"));
  assert.ok(!nhtml.includes("admin-preview-note"));
});
