// Every HTML page differs by language (cookie umasbooks_lang, else
// Accept-Language), so each must say so: `Vary: Accept-Language, Cookie` next to
// compression's Accept-Encoding, otherwise a shared cache (a CDN, a proxy) could
// hand one visitor's language to another. Cache-Control is left as each route set it.
//
// Port 4880 is reserved for this file.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { startTestApp } = require("../helpers/testApp");

const PORT = 4880;
let app;
let bookId;
before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  const c = new Client({ connectionString: app.databaseUrl });
  await c.connect();
  try {
    const { rows } = await c.query("INSERT INTO books (title, authors) VALUES ('Vary Book', 'Vary Author') RETURNING id");
    bookId = rows[0].id;
    await c.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 5, 'good')", [bookId]);
  } finally {
    await c.end();
  }
});
after(() => app.stop());

const varyOf = (res) => String(res.headers.get("vary") || "").split(",").map((s) => s.trim().toLowerCase());

for (const lang of [null, "fr"]) {
  for (const path of ["/", "/books.html", "/visit.html", "/privacy-policy.html", "/contact", "/events", "/sessions", "/request-a-book", "/login", "/this-page-does-not-exist"]) {
    test(`Vary names language and encoding: ${path} (${lang || "no language"})`, async () => {
      const headers = { "accept-encoding": "gzip" };
      if (lang) headers["accept-language"] = lang;
      const res = await fetch(app.base + path, { headers });
      await res.arrayBuffer();
      const vary = varyOf(res);
      for (const h of ["accept-language", "cookie", "accept-encoding"]) assert.ok(vary.includes(h), `${path}: Vary has ${h} (got "${res.headers.get("vary")}")`);
    });
  }
}

test("Vary names language on a book page", async () => {
  const res = await fetch(`${app.base}/books/${bookId}`, { headers: { "accept-encoding": "gzip" } });
  await res.arrayBuffer();
  const vary = varyOf(res);
  assert.ok(vary.includes("accept-language") && vary.includes("cookie") && vary.includes("accept-encoding"));
});

test("a redirect does not need to vary on language", async () => {
  const res = await fetch(`${app.base}/about`, { redirect: "manual" });
  assert.equal(res.status, 301);
  assert.ok(!varyOf(res).includes("accept-language"));
});

test("the same URL really does change with the language (why Vary is needed)", async () => {
  const fr = await (await fetch(app.base + "/visit.html", { headers: { "accept-language": "fr" } })).text();
  const en = await (await fetch(app.base + "/visit.html", { headers: { "accept-language": "en" } })).text();
  assert.match(fr, /<html lang="fr"/);
  assert.match(en, /<html lang="en"/);
});
