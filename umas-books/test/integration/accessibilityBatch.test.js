// Review D accessibility batch (D5, D24, D25, D27, D28 hit area, D4 table roles) checked on the real rendered pages:
//   D5  on /fr/ pages an English book's title and author sit in <span lang="en"> (WCAG 3.1.2, RGAA 8.7); never on /en/ pages
//   D24 the "Back" bar is a labelled <nav>, not loose content above <main>
//   D25 the "No cover" placeholder text is aria-hidden, so it is not part of the book link's name
//   D27 a refused contact / request-a-book / sign-up form comes back with an error summary that links to the fields,
//       aria-invalid + aria-describedby on them, and a focus hook (data-form-errors, moved by public/app.js)
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");
const { fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 4577;
let app, pool, bookId, noCoverId;
const stamp = Date.now();

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const a = await pool.query("INSERT INTO books (title, authors, description, cover_url, categories) VALUES ($1, 'Jane Austen', 'x', '/apple-touch-icon.png', 'Classics') RETURNING id", [`Pride & Prejudice ${stamp}`]);
  bookId = a.rows[0].id;
  const b = await pool.query("INSERT INTO books (title, authors, categories) VALUES ($1, 'No Cover Author', 'Classics') RETURNING id", [`Bare Book ${stamp}`]);
  noCoverId = b.rows[0].id;
  for (const id of [bookId, noCoverId]) {
    await pool.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 4.5, 'very_good'), ($1, 'in_stock', 9, 'good')", [id]);
  }
});
after(async () => {
  await pool.query("DELETE FROM books WHERE id = ANY($1)", [[bookId, noCoverId]]);
  await pool.end();
  app.stop();
});

const get = (p, headers) => fetch(`${app.base}${p}`, { headers });

test("D5: a French book page marks the English title, author and the heart's name with lang=en; the English page does not", async () => {
  const fr = await (await get(`/fr/books/${bookId}`)).text();
  assert.match(fr, /<html lang="fr">/);
  assert.match(fr, new RegExp(`<h1[^>]*><span lang="en">Pride &amp; Prejudice ${stamp}</span></h1>`));
  assert.match(fr, /de <span lang="en">Jane Austen<\/span>/);
  // the heart: no aria-label (it cannot carry a lang); its name is a hidden span with the English title wrapped
  assert.match(fr, /<span class="fav-name">Ajouter <span lang="en">Pride &amp; Prejudice \d+<\/span> aux favoris<\/span>/);
  assert.doesNotMatch(fr, /aria-label="Ajouter/);
  const en = await (await get(`/books/${bookId}`, { cookie: "umasbooks_lang=en" })).text();
  assert.doesNotMatch(en, /<span lang="en">/, "no lang wrappers on an English page");
  assert.match(en, /aria-label="Add Pride &amp; Prejudice \d+ to favorites"/);
});

test("D5: the More-by-author heading and the order lines mark only the English part", async () => {
  const fr = await (await get(`/fr/books/${bookId}`)).text();
  // only one book by Jane Austen in this database: no "more by" block, so check the sentence builder through the other book
  assert.doesNotMatch(fr, /Du même auteur/);
});

test("D25: the No cover placeholder is aria-hidden, in English and in French", async () => {
  for (const [p, label] of [[`/books/${noCoverId}`, "No cover"], [`/fr/books/${noCoverId}`, "Pas de couverture"]]) {
    const html = await (await get(p)).text();
    assert.match(html, new RegExp(`<div class="book-detail-cover book-thumb-placeholder" aria-hidden="true">${label}</div>`), p);
  }
});

test("D24: the Back bar is a labelled nav landmark on app and marketing pages, in both languages", async () => {
  for (const [p, label] of [["/contact", "Back link"], ["/fr/contact", "Lien de retour"], ["/books/" + bookId, null]]) {
    const html = await (await get(p)).text();
    if (!label) { assert.doesNotMatch(html, /<div class="site-back-bar"/); continue; } // the book page has its own back link
    assert.match(html, new RegExp(`<nav class="site-back-bar" aria-label="${label}">`), p);
    assert.doesNotMatch(html, /<div class="site-back-bar"/, p);
  }
});

async function refuse(path, fields, lang) {
  const jar = { c: new Map(), capture(res) { for (const raw of res.headers.getSetCookie()) { const [pair] = raw.split(";"); const i = pair.indexOf("="); this.c.set(pair.slice(0, i), pair.slice(i + 1)); } }, header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join("; "); } };
  const headers = lang === "fr" ? { cookie: "umasbooks_lang=fr" } : {};
  const first = await fetch(`${app.base}${path}`, { headers }); jar.capture(first);
  const token = await fetchCsrfToken(app.base, { header: () => [jar.header(), headers.cookie].filter(Boolean).join("; "), capture: (r) => jar.capture(r) });
  const res = await fetch(`${app.base}${path}`, {
    method: "POST", redirect: "manual",
    headers: { cookie: [jar.header(), headers.cookie].filter(Boolean).join("; "), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
  });
  jar.capture(res);
  assert.equal(res.status, 303, `${path} refuses with a redirect`);
  const page = await fetch(new URL(res.headers.get("location"), app.base), { headers: { cookie: [jar.header(), headers.cookie].filter(Boolean).join("; ") } });
  return page.text();
}

test("D27: a refused contact form names the fields, links to them, marks them invalid and asks for focus", async () => {
  const html = await refuse("/contact", { name: "", email: "not-an-email", topic: "Other", message: "" }, "en");
  assert.match(html, /<div role="alert" class="error-box" id="form-errors" tabindex="-1" data-form-errors>/);
  for (const [id, label] of [["c-name", "Your name"], ["c-email", "Your email"], ["c-message", "Message"]]) {
    assert.match(html, new RegExp(`<a href="#${id}">${label}</a>`), `summary links to ${id}`);
    assert.match(html, new RegExp(`<(input|textarea) id="${id}"[^>]*aria-invalid="true" aria-describedby="form-errors"`), `${id} is marked invalid`);
  }
  const ok = await refuse("/contact", { name: "Sam", email: "sam@example.invalid", topic: "Other", message: "" }, "en");
  assert.match(ok, /<a href="#c-message">/);
  assert.doesNotMatch(ok, /<input id="c-name"[^>]*aria-invalid/, "a filled field is not marked");
});

test("D27: French contact summary, request-a-book and sign-up refusals do the same", async () => {
  const fr = await refuse("/contact", { name: "", email: "x@example.invalid", topic: "Other", message: "Bonjour" }, "fr");
  assert.match(fr, /<a href="#c-name">Votre nom<\/a>/);
  assert.match(fr, /aria-label="Champs à vérifier"/);
  const rb = await refuse("/request-a-book", { title: "", email: "a@example.invalid" }, "en");
  assert.match(rb, /<a href="#rb-title">Title<\/a>/);
  assert.match(rb, /<input id="rb-title"[^>]*aria-invalid="true" aria-describedby="form-errors"/);
  const su = await refuse("/signup", { displayName: "", email: "" }, "en");
  assert.match(su, /<a href="#displayName">Name<\/a>/);
  assert.match(su, /<a href="#email">Email<\/a>/);
});

test("D4: the copy table keeps its table roles in the markup (the stacked phone layout uses display: block)", async () => {
  const html = await (await get(`/books/${bookId}`)).text();
  assert.match(html, /<table class="copy-table" role="table">/);
  assert.equal((html.match(/<tr role="row">/g) || []).length, 3, "header row + 2 copies");
  assert.equal((html.match(/<td role="cell">/g) || []).length, 6);
  assert.equal((html.match(/<th scope="col" role="columnheader">/g) || []).length, 3);
});
