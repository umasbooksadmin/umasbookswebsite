// Browse Educational Items (views/marketing/educational-items.ejs, src/app.js) and Admin > Educational items
// (src/routes/admin/eduItems.js) on the real app: the nav tab, the genres, search, the empty state, the 'new' line,
// Sold out / Épuisé when the stock is 0 or fully held, the French twin (item and genre names stay English, lang="en"),
// adding from the card, the sitemap, and the admin pages (admin only, add with stock, genres, audit). Port 5114.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { tillHarness } = require("../helpers/tillHarness");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

let h, cart, items = {};
before(async () => {
  h = await tillHarness({ port: 5114, ip: "10.51.14.1" });
  cart = require("../../src/lib/cart");
  const g = Object.fromEntries((await h.pool.query("SELECT slug, id FROM edu_genres")).rows.map((r) => [r.slug, r.id]));
  const add = async (name, price, stock, genre, hidden = false) => (await h.pool.query(
    "INSERT INTO edu_items (name, price, stock, genre_id, is_hidden) VALUES ($1, $2, $3, $4, $5) RETURNING *", [name, price, stock, g[genre], hidden])).rows[0];
  items.phonics = await add("Phonics Picture Cards", 8.5, 12, "flash-cards");
  items.verbs = await add("Irregular Verbs Cards", 6, 0, "flash-cards");
  items.held = await add("Colours Flash Cards", 5, 1, "flash-cards");
  items.secret = await add("Hidden Cards", 3, 5, "flash-cards", true);
  const { rows } = await h.pool.query("INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, 'x', 'B', now()) RETURNING id, email", [`browse-${h.uniq()}@example.test`]);
  await cart.createReservation(h.pool, { user: rows[0], name: "B", items: [{ kind: "edu", eduItemId: items.held.id, qty: 1, title: items.held.name, price: 5 }], acceptedVersion: "v", hasDropin: false });
});
after(async () => { await h.stop(); });

const visit = async (path, jar = makeCookieJar()) => {
  const res = await fetch(`${h.app.base}${path}`, { redirect: "manual", headers: { cookie: jar.header(), "x-forwarded-for": "10.51.14.2" } });
  jar.capture(res);
  return { res, text: await res.text() };
};
const card = (html, id) => { const i = html.indexOf(`id="edu-item-${id}"`); return i < 0 ? null : html.slice(i, html.indexOf('<div class="bk-book', i + 10) > 0 ? html.indexOf('<div class="bk-book', i + 10) : i + 3000); };

test("the English page: nav tab, genres, the 'new' line, items with Add or Sold out, hidden items absent, never cached", async () => {
  const { res, text } = await visit("/educational-items.html");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("cache-control"), /no-store/);
  assert.match(text, /href="\/educational-items\.html"[^>]*>Browse Educational Items</);
  assert.match(text, /All educational items are new\./);
  assert.match(text, />Worksheets</);
  assert.match(text, />Flash Cards</);
  assert.match(card(text, items.phonics.id), /action="\/cart\/add-edu"/);
  assert.match(card(text, items.phonics.id), /€8\.50|8,50/);
  for (const id of [items.verbs.id, items.held.id]) {
    const c = card(text, id);
    assert.match(c, /disabled>Sold out</, "stock 0 and fully held both read Sold out");
    assert.ok(!/add-edu/.test(c));
  }
  assert.ok(!text.includes("Hidden Cards"));
  assert.match(text, /a selection/);
});

test("the French twin: Épuisé, the French 'new' line, names marked lang=en", async () => {
  const { res, text } = await visit("/fr/educational-items.html");
  assert.equal(res.status, 200);
  assert.match(text, /Tous les articles éducatifs sont neufs\./);
  assert.match(text, /Parcourir les articles éducatifs/);
  assert.match(card(text, items.verbs.id), /disabled>Épuisé</);
  assert.match(text, /<div class="t" lang="en">Phonics Picture Cards<\/div>/);
  assert.match(text, /<span lang="en">Flash Cards<\/span>/);
});

test("a genre with no items shows the empty state; search finds by name; an unknown genre shows everything", async () => {
  const empty = (await visit("/educational-items.html?genre=worksheets")).text;
  assert.match(empty, /There are no educational items here yet/);
  assert.ok(!empty.includes("Phonics Picture Cards"));
  const found = (await visit("/educational-items.html?q=phonics")).text;
  assert.match(found, /Phonics Picture Cards/);
  assert.ok(!found.includes("Irregular Verbs Cards"));
  assert.match((await visit("/educational-items.html?q=zzzz")).text, /No educational items match that search/);
  assert.match((await visit("/educational-items.html?genre=nope")).text, /Phonics Picture Cards/);
});

test("adding from the card: back on the page with the notice and 'In your cart (2)', cart count in units", async () => {
  const jar = makeCookieJar();
  const csrf = await fetchCsrfToken(h.app.base, jar, { "x-forwarded-for": "10.51.14.3" });
  const res = await fetch(`${h.app.base}/cart/add-edu`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header(), "x-forwarded-for": "10.51.14.3" },
    body: new URLSearchParams({ _csrf: csrf, eduItemId: String(items.phonics.id), qty: "2", backTo: "/educational-items.html?genre=flash-cards" }).toString(),
  });
  jar.capture(res);
  assert.equal(res.status, 303);
  const page = await visit(res.headers.get("location"), jar);
  assert.match(page.text, /Added to your cart\./);
  assert.match(card(page.text, items.phonics.id), /In your cart \(2\)/);
  assert.equal(JSON.parse((await visit("/api/cart/count", jar)).text).count, 2);
});

test("the sitemap lists both language versions", async () => {
  const { text } = await visit("/sitemap-pages.xml");
  assert.match(text, /\/educational-items\.html</);
  assert.match(text, /\/fr\/educational-items\.html</);
});

test("admin: the list shows stock / held / available; add with stock (audited); genres; non-admins are kept out", async () => {
  const list = await h.get("/admin/edu-items");
  assert.equal(list.res.status, 200);
  assert.match(list.text, /Colours Flash Cards/);
  const g = (await h.pool.query("SELECT id FROM edu_genres WHERE slug = 'worksheets'")).rows[0].id;
  await h.post("/admin/edu-items", { name: "Alphabet Tracing Sheets", price: "3,50", stock: "25", genreId: String(g), sortOrder: "1" });
  const made = (await h.pool.query("SELECT * FROM edu_items WHERE name = 'Alphabet Tracing Sheets'")).rows[0];
  assert.equal(Number(made.price), 3.5);
  assert.equal(made.stock, 25);
  assert.match((await h.audit("edu_item.add")).pop().detail, /stock 25/);
  // Bad stock is refused and nothing is made.
  await h.post("/admin/edu-items", { name: "Bad Stock", price: "2", stock: "-1", genreId: String(g) });
  await h.post("/admin/edu-items", { name: "Bad Stock", price: "2", stock: "2.5", genreId: String(g) });
  assert.equal((await h.pool.query("SELECT 1 FROM edu_items WHERE name = 'Bad Stock'")).rows.length, 0);
  // Hide / show.
  await h.post(`/admin/edu-items/${made.id}/visibility`, { hide: "1" });
  assert.equal((await h.pool.query("SELECT is_hidden FROM edu_items WHERE id = $1", [made.id])).rows[0].is_hidden, true);
  // Genres: add, and a genre with items cannot be deleted.
  await h.post("/admin/edu-genres", { name: "Board Games" });
  const bg = (await h.pool.query("SELECT * FROM edu_genres WHERE name = 'Board Games'")).rows[0];
  assert.equal(bg.slug, "board-games");
  await h.post(`/admin/edu-genres/${g}/delete`, {});
  assert.equal((await h.pool.query("SELECT 1 FROM edu_genres WHERE id = $1", [g])).rows.length, 1);
  await h.post(`/admin/edu-genres/${bg.id}/delete`, {});
  assert.equal((await h.pool.query("SELECT 1 FROM edu_genres WHERE id = $1", [bg.id])).rows.length, 0);
  // A plain member (and an anonymous visitor) cannot see or change any of it.
  const member = await h.makeUser({ member: true, name: "Plain Member" });
  const page = await h.get("/admin/edu-items", member.jar);
  assert.notEqual(page.res.status, 200);
  await h.post(`/admin/edu-items/${items.phonics.id}`, { name: "Hacked", price: "1", stock: "0", genreId: String(g) }, member.jar);
  assert.equal((await h.pool.query("SELECT name FROM edu_items WHERE id = $1", [items.phonics.id])).rows[0].name, "Phonics Picture Cards");
  assert.notEqual((await visit("/admin/edu-items")).res.status, 200);
});
