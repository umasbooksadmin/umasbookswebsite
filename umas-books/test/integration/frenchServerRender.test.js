// The customer side must be French in the HTML the server sends when French is
// chosen: prices read "12,50 €" (lib/money.js) and the marketing pages, above
// all the legal ones, are filled from their French dictionaries on the server
// (lib/pageDictionary.js), so search engines, no-JavaScript clients and print
// see French, with the language toggle still working.
//
// Port 3978 is reserved for this file.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken, waitForCartCount } = require("../helpers/httpClient");

const PORT = 3978;
const NB = "\u00a0";
let app;
before(async () => { app = await startTestApp({ port: PORT, isolated: true }); });
after(() => app.stop());

const get = async (path, lang, extra = {}) => {
  const headers = { ...extra };
  if (lang) headers.cookie = [extra.cookie, `umasbooks_lang=${lang}`].filter(Boolean).join("; ");
  const res = await fetch(`${app.base}${path}`, { headers });
  return { status: res.status, html: await res.text() };
};

// ---- prices ----

async function seed() {
  const client = new Client({ connectionString: app.databaseUrl });
  await client.connect();
  try {
    const { rows: b } = await client.query("INSERT INTO books (title, authors) VALUES ('Price Check Book', 'Price Author') RETURNING id");
    const { rows: c } = await client.query(
      "INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 12.5, 'very_good'), ($1, 'in_stock', 20, 'like_new') RETURNING id",
      [b[0].id]
    );
    const { rows: o } = await client.query("INSERT INTO orders (buyer_name, buyer_email, total_amount, status) VALUES ('Buyer', 'buyer@example.test', 12.5, 'paid') RETURNING access_token");
    const { rows: oc } = await client.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'sold', 12.5) RETURNING id", [b[0].id]);
    await client.query("INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ((SELECT id FROM orders WHERE access_token = $1), $2, 'Price Check Book', 12.5)", [o[0].access_token, oc[0].id]);
    return { bookId: b[0].id, copyId: c[0].id, order: o[0].access_token };
  } finally {
    await client.end();
  }
}

test("book page: prices are 12,50 € in French and €12.50 in English", async () => {
  const { bookId } = await seed();
  const fr = (await get(`/books/${bookId}`, "fr")).html;
  assert.ok(fr.includes(`12,50${NB}€`), "the lowest price and the copy row");
  assert.ok(fr.includes(`20,00${NB}€`));
  assert.doesNotMatch(fr, /€\s?\d/, "no English-style price in French");
  const en = (await get(`/books/${bookId}`, "en")).html;
  assert.ok(en.includes("€12.50") && en.includes("€20.00"));
  assert.doesNotMatch(en, /\d,\d\d\u00a0€/);
});

test("cart and cart return page: French and English prices and total", async () => {
  const { copyId, order } = await seed();
  for (const [lang, line, total] of [["fr", `12,50${NB}€`, `Total${NB}:`], ["en", "€12.50", "Total:"]]) {
    const jar = makeCookieJar();
    const token = await fetchCsrfToken(app.base, jar);
    const add = await fetch(`${app.base}/cart/add`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: jar.header(), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ copyId: String(copyId), _csrf: token }).toString(),
    });
    assert.equal(add.status, 302);
    await waitForCartCount(app.base, jar, 1);
    const cart = (await get("/cart", lang, { cookie: jar.header() })).html;
    assert.ok(cart.includes(`<strong>${line}</strong>`), `${lang} cart total: ${line}`);
    assert.ok(cart.includes(total));
    assert.ok(cart.includes(`cart-item-price">${line}<`), `${lang} cart line price`);
    const ret = (await get(`/cart/return?order=${order}`, lang)).html;
    assert.ok(ret.includes(line), `${lang} cart return page: ${line}`);
  }
});

// ---- marketing pages ----

const LEGAL = [
  ["/terms-of-sale.html", /Conditions générales de vente/, /\b(You may|Placing an order|These terms govern)\b/],
  ["/privacy-policy.html", /Politique de confidentialité/, /\b(We never sell|Your rights|This page explains)\b/],
  ["/mentions-legales.html", /Mentions légales/, /\b(Director of publication|Hosting provider)\b/i],
  ["/membership-terms.html", /Conditions d’adhésion/, /\b(By joining|You become a member)\b/],
];

test("legal pages: the HTML the server sends is French when French is chosen (no JavaScript needed)", async () => {
  for (const [p, heading, english] of LEGAL) {
    const { html } = await get(p, "fr");
    assert.match(html, /<html lang="fr"/, p);
    assert.match(html, heading, `${p} French heading in the server HTML`);
    const body = html.replace(/<script[\s\S]*?<\/script>/g, "");
    assert.doesNotMatch(body, english, `${p} still has English sentences in the server HTML`);
    assert.match(body, /<title[^>]*>[^<]*(Conditions|Politique|Mentions)[^<]*<\/title>/, `${p} French <title>`);
    assert.match(body, /<meta property="og:locale" content="fr_FR">/);
    assert.match(body, /<meta property="og:locale:alternate" content="en_GB">/);
    assert.match(body, /<a class="skip-link"[^>]*>Aller au contenu principal<\/a>/, `${p} skip link`);
    assert.match(body, /site-back-link"[^>]*>← Retour<\/a>/, `${p} back link`);
    assert.match(body, /<meta name="description" content="[^"]*(vente|données|Mentions|adhésion)[^"]*"/i, `${p} French meta description`);
    assert.match(body, /<meta name="twitter:title" content="[^"]*(Conditions|Politique|Mentions)/);
    assert.match(body, /<button type="button" data-lang="fr" class="is-active" aria-pressed="true">FR<\/button>/, `${p} FR toggle is active`);
  }
});

test("legal pages: French typography (non-breaking space before : ; ! ? and inside « ») in the server HTML", async () => {
  for (const [p] of LEGAL) {
    const { html } = await get(p, "fr");
    const text = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]*>/g, "");
    assert.doesNotMatch(text, /[^\s] [;!?]/, `${p}: ordinary space before ; ! ?`);
    assert.doesNotMatch(text, /[a-zà-ÿ’)] :(?!\/)/, `${p}: ordinary space before :`);
    assert.doesNotMatch(text, /« | »/, `${p}: ordinary space inside « »`);
  }
});

test("legal pages: Accept-Language French (no cookie) also gets French; English stays English", async () => {
  const fr = (await get("/terms-of-sale.html", null, { "accept-language": "fr-FR,fr;q=0.9" })).html;
  assert.match(fr, /<html lang="fr"/);
  assert.match(fr, /Conditions générales de vente/);
  const en = (await get("/terms-of-sale.html", "en")).html;
  assert.match(en, /<html lang="en"/);
  assert.match(en, /<h1 data-i18n="ts\.title">Terms of Sale<\/h1>/);
  assert.match(en, /<title data-i18n="meta\.title">Terms of Sale — Uma&#39;s Books<\/title>/);
  assert.match(en, /<meta property="og:locale" content="en_GB">/);
  assert.match(en, /Skip to main content<\/a>/);
  assert.match(en, /← Back<\/a>/);
});

test("the client-side toggle still has both dictionaries (and the FR page keeps the English one for toggling back)", async () => {
  const { html } = await get("/privacy-policy.html", "fr");
  const m = html.match(/window\.PAGE_I18N = (\{.*\});\n<\/script>/);
  assert.ok(m, "PAGE_I18N is still sent");
  const dict = JSON.parse(m[1]);
  assert.match(dict.en["pp.title"], /Privacy Policy/);
  assert.match(dict.fr["pp.title"], /Politique de confidentialité/);
  assert.ok(dict.en["meta.title"] && dict.fr["meta.title"]);
  assert.ok(html.includes('data-i18n="pp.title"'), "the data-i18n hooks stay for the toggle");
});

test("every marketing page is French in the server HTML under <html lang=fr>, with a French title and og:locale", async () => {
  const pages = ["/", ...require("../../src/lib/marketingPages").map((f) => "/" + f)];
  for (const p of pages) {
    const { status, html } = await get(p, "fr");
    assert.equal(status, 200, p);
    assert.match(html, /<html lang="fr"/, p);
    assert.match(html, /<meta property="og:locale" content="fr_FR">/, p);
    assert.doesNotMatch(html, /Skip to main content/, `${p} skip link`);
    const en = (await get(p, "en")).html;
    const t = (h) => h.match(/<title[^>]*>([^<]*)<\/title>/)[1];
    if (p !== "/") assert.notEqual(t(html), t(en), `${p} the title is translated`);
    const d = (h) => h.match(/<meta name="description" content="([^"]*)"/)[1];
    assert.notEqual(d(html), d(en), `${p} the meta description is translated`);
  }
});

test("the session-expired page is the site's own page, in French when French is chosen", async () => {
  for (const [lang, text] of [["fr", "Votre session a expiré"], ["en", "Your session expired or this form is out of date"]]) {
    const res = await fetch(`${app.base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: `umasbooks_lang=${lang}` },
      body: new URLSearchParams({ email: "a@example.test", password: "x", _csrf: "nope" }).toString(),
    });
    assert.equal(res.status, 403);
    const html = await res.text();
    assert.ok(html.includes(text), lang);
    assert.match(html, new RegExp(`<html lang="${lang}"`));
  }
});
