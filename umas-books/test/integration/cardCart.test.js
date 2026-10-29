/* global document, window */
// The cart icon on every book card's price line (src/lib/cardCart.js, views/partials/card_cart.ejs, public/ui.js cartControlHtml,
// public/cart-add.js). Real app, throwaway database, the real CSRF check and the real login:
//   - what the icon does, per book: one copy (or identical copies) -> adds that copy; different copies -> opens the book page;
//     nothing buyable online (unpriced, reserved, sold) -> no icon at all; in the cart -> "in your cart", a link to the cart
//   - signed in: adding from a card (the JSON the script uses, and the plain form without JavaScript)
//   - signed out (guest checkout, 2026-10-28): the book goes into the session's cart and they stay on the page, exactly as
//     when signed in (no detour through the sign-in page); signing in later keeps the cart
//   - CSRF: a post without the token, or with a wrong one, is refused and adds nothing
//   - English and French names
//   - in headless Chrome (skipped when there is none): pressing the icon signed out and signed in, the cart read
//     back from the session row in the database
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");
const { createAccount } = require("../helpers/accounts");

const PORT = 6497;
let app;
let pool;
let browser;
let skipReason = null;
const id = {};      // title -> book id
const copy = {};    // title -> [copy ids]
let ipSeq = 1;
const newIp = () => `10.97.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

async function addBook(title, copies) {
  const { rows } = await pool.query(
    "INSERT INTO books (title, authors, categories, binding, description) VALUES ($1, 'Card Author', 'Fiction', 'trade', 'x') RETURNING id",
    [title]
  );
  id[title] = rows[0].id;
  copy[title] = [];
  for (const [price, condition, status = "in_stock", clearance = false] of copies) {
    const r = await pool.query(
      "INSERT INTO book_copies (book_id, condition, price, status, is_clearance) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [rows[0].id, condition, price, status, clearance]
    );
    copy[title].push(r.rows[0].id);
  }
  return rows[0].id;
}

before(async () => {
  try {
    browser = await require("puppeteer").launch({ headless: true, args: ["--no-sandbox"] });
  } catch (err) {
    skipReason = `no headless Chrome available: ${String(err.message).split("\n")[0]}`;
  }
  app = await startTestApp({ port: PORT, isolated: true, env: { ANTHROPIC_API_KEY: "", ANON_SESSION_LIMIT: "100000" } });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  await addBook("Card One Copy", [[5, "very_good"]]);
  await addBook("Card Twin Copies", [[4, "good"], [4, "good"]]);
  await addBook("Card Choice", [[6, "very_good"], [3, "acceptable"]]);
  await addBook("Card Same Price Other Grade", [[4, "good"], [4, "very_good"]]);
  await addBook("Card Clearance Twin", [[4, "good", "in_stock", true], [4, "good"]]);
  await addBook("Card Unpriced", [[null, "good"]]);
  await addBook("Card Unpriced Plus One", [[null, "good"], [7, "good"]]);
  await addBook("Card Reserved", [[5, "good", "reserved"]]);
  await addBook("Card Sold", [[5, "good", "sold"]]);
  await addBook("Card L'Apostrophe", [[5, "good"]]);
  const { rows } = await pool.query(
    `INSERT INTO curated_collections (slug, title_en, description_en, title_fr, description_fr, curation_prompt, published)
     VALUES ('card-shelf', 'Card Shelf', 'x', 'Étagère', 'x', 'x', TRUE) RETURNING id`
  );
  let pos = 1;
  for (const bookId of Object.values(id)) {
    await pool.query("INSERT INTO curated_collection_books (collection_id, book_id, status, position) VALUES ($1, $2, 'approved', $3)", [rows[0].id, bookId, pos++]);
  }
});

after(async () => {
  if (browser) await browser.close();
  if (pool) await pool.end();
  if (app) await app.stop();
});

// One visitor: a cookie jar and their own client address (the per-IP limits of the app never collide between tests).
function visitor() {
  const jar = makeCookieJar();
  const ip = newIp();
  const headers = (extra = {}) => ({ cookie: jar.header(), "x-forwarded-for": ip, ...extra });
  return {
    jar, ip,
    async get(p, extra) { const r = await fetch(`${app.base}${p}`, { redirect: "manual", headers: headers(extra) }); jar.capture(r); return r; },
    async post(p, body, extra) {
      const r = await fetch(`${app.base}${p}`, { method: "POST", redirect: "manual", headers: headers({ "content-type": "application/x-www-form-urlencoded", ...extra }), body: new URLSearchParams(body).toString() });
      jar.capture(r);
      return r;
    },
    token() { return fetchCsrfToken(app.base, jar, { "x-forwarded-for": ip }); },
    async session() { return (await this.get("/api/session")).json(); },
  };
}
const JSON_ACCEPT = { accept: "application/json" };

async function signIn(v, account, returnTo) {
  const token = await v.token();
  const r = await v.post("/login", { email: account.email, password: account.password, _csrf: token, ...(returnTo ? { returnTo } : {}) });
  assert.equal(r.status, 302, "logged in");
  return r.headers.get("location");
}
let accountSeq = 0;
const newAccount = () => createAccount(pool, { email: `card-buyer-${++accountSeq}@example.test` });

// The cart icon of one book in some HTML: the <span class="bk-cart" data-book-id=...> ... </span>, or null.
function iconOf(html, bookId) {
  const m = new RegExp(`<span class="bk-cart" data-book-id="${bookId}">([\\s\\S]*?)</span></(?:div|li)>`).exec(html);
  return m ? m[1] : null;
}

test("the public lists say what each book's icon does: one copy or identical copies add the oldest, different copies choose, nothing buyable means none", async () => {
  const v = visitor();
  const { books } = await (await v.get("/api/books/new-in?limit=100")).json();
  const buy = Object.fromEntries(books.map((b) => [b.title, b.buy]));
  assert.deepEqual(buy["Card One Copy"], { copyId: copy["Card One Copy"][0] });
  assert.deepEqual(buy["Card Twin Copies"], { copyId: Math.min(...copy["Card Twin Copies"]) }, "identical copies: the oldest one is added");
  assert.deepEqual(buy["Card Choice"], { choose: true }, "different price and grade: choose on the book page");
  assert.deepEqual(buy["Card Same Price Other Grade"], { choose: true }, "same price, other grade: still a choice");
  assert.deepEqual(buy["Card Clearance Twin"], { choose: true }, "a clearance copy is shown differently on the book page: a choice");
  assert.equal(buy["Card Unpriced"], null, "an unpriced copy is ask-in-the-shop: no icon");
  assert.deepEqual(buy["Card Unpriced Plus One"], { copyId: copy["Card Unpriced Plus One"][1] }, "only the priced copy counts");
  assert.ok(!("Card Reserved" in buy) && !("Card Sold" in buy), "reserved and sold books are not in the lists at all");
  // the other lists carry the same field
  const search = await (await v.get("/api/books/search?q=Card%20Choice&paged=1")).json();
  assert.deepEqual(search.books.find((b) => b.title === "Card Choice").buy, { choose: true });
  const col = await (await v.get("/api/collections/card-shelf/books?limit=48")).json();
  assert.deepEqual(col.books.find((b) => b.title === "Card One Copy").buy, { copyId: copy["Card One Copy"][0] });
  const favs = await (await v.get(`/api/books/by-ids?ids=${id["Card Reserved"]},${id["Card Sold"]},${id["Card Twin Copies"]}`)).json();
  assert.equal(favs.find((b) => b.id === id["Card Reserved"]).buy, null, "Favorites: a reserved book gets no icon");
  assert.equal(favs.find((b) => b.id === id["Card Sold"]).buy, null, "Favorites: a sold book gets no icon");
  assert.deepEqual(favs.find((b) => b.id === id["Card Twin Copies"]).buy, { copyId: Math.min(...copy["Card Twin Copies"]) });
});

test("a signed-out visitor's collection page: a GET form to the book page (the script adds it to the cart), a link to the book page for a choice, no icon when nothing can be bought, no session made", async () => {
  const v = visitor();
  const r = await v.get("/collections/card-shelf");
  assert.equal(r.status, 200);
  assert.equal(r.headers.getSetCookie().length, 0, "the page creates no session (no CSRF token printed for a guest)");
  const html = await r.text();
  const one = iconOf(html, id["Card One Copy"]);
  assert.ok(one, "the one-copy book has an icon");
  assert.match(one, new RegExp(`<form class="bk-cart-add" method="get" action="/books/${id["Card One Copy"]}" data-copy-id="${copy["Card One Copy"][0]}"><button`));
  assert.doesNotMatch(one, /\/login|returnTo/, "no detour through the sign-in page");
  assert.match(one, /aria-label="Add Card One Copy to cart"/);
  assert.match(one, /<a class="bk-cart-btn bk-cart-in" href="\/cart" aria-label="Card One Copy is in your cart \(view cart\)" hidden>/);
  const choice = iconOf(html, id["Card Choice"]);
  assert.match(choice, new RegExp(`<a class="bk-cart-btn bk-cart-choose" href="/books/${id["Card Choice"]}" aria-label="Choose a copy of Card Choice to add to cart">`));
  assert.doesNotMatch(choice, /<form/, "a choice is never added straight from the card");
  assert.equal(iconOf(html, id["Card Unpriced"]), null, "unpriced: no icon (no dead icon)");
  assert.doesNotMatch(html, new RegExp(`data-book-id="${id["Card Reserved"]}"|data-book-id="${id["Card Sold"]}"`));
  // every icon sits on a price line, after the book's link
  assert.equal((html.match(/<\/a><div class="p">[^<]*<span class="bk-cart"/g) || []).length, (html.match(/<span class="bk-cart" /g) || []).length);
});

test("signed in: the icon adds the copy (JSON for the script, a redirect back for the plain form) and the cards then show it in the cart", async () => {
  const v = visitor();
  await signIn(v, await newAccount());
  // the page drawn for this session carries a real POST form with the token
  const html = await (await v.get("/collections/card-shelf")).text();
  const form = iconOf(html, id["Card One Copy"]);
  assert.match(form, new RegExp(`<form class="bk-cart-add" method="post" action="/cart/add" data-copy-id="${copy["Card One Copy"][0]}"><input type="hidden" name="_csrf" value="[0-9a-f]{64}">`));
  const token = /name="_csrf" value="([0-9a-f]{64})"/.exec(form)[1];

  // what public/cart-add.js does
  const r = await v.post("/cart/add", { copyId: copy["Card One Copy"][0], backTo: "/collections/card-shelf", via: "card", _csrf: token }, JSON_ACCEPT);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, inCart: true, cartCount: 1, bookId: id["Card One Copy"] });
  // a second press adds nothing more
  const again = await v.post("/cart/add", { copyId: copy["Card One Copy"][0], backTo: "/", via: "card", _csrf: token }, JSON_ACCEPT);
  assert.equal((await again.json()).cartCount, 1);
  assert.deepEqual((await v.session()).cartBookIds, [id["Card One Copy"]], "/api/session tells the browser cards which books are in the cart");

  // without JavaScript: the plain form posts and comes back to the page
  const plain = await v.post("/cart/add", { copyId: copy["Card Twin Copies"][0], backTo: "/collections/card-shelf", via: "card", _csrf: token });
  assert.equal(plain.status, 302);
  assert.equal(plain.headers.get("location"), "/collections/card-shelf");
  assert.equal((await v.session()).cartCount, 2);

  // already in the cart: shown as in the cart (a link to the cart), never a second add
  const after = await (await v.get("/collections/card-shelf")).text();
  for (const t of ["Card One Copy", "Card Twin Copies"]) {
    const icon = iconOf(after, id[t]);
    assert.match(icon, /<form class="bk-cart-add"[^>]* hidden>/, `${t}: the add form is hidden`);
    assert.match(icon, new RegExp(`<a class="bk-cart-btn bk-cart-in" href="/cart" aria-label="${t} is in your cart \\(view cart\\)">`), `${t}: in your cart`);
  }
  assert.match(iconOf(after, id["Card Choice"]), /bk-cart-in"[^>]* hidden>/, "a book not in the cart keeps its icon");
  // a copy that is no longer for sale is refused, never added
  const gone = await v.post("/cart/add", { copyId: copy["Card Reserved"][0], backTo: "/", via: "card", _csrf: token }, JSON_ACCEPT);
  assert.deepEqual(await gone.json(), { ok: false, error: "unavailable" });
  assert.equal((await v.session()).cartCount, 2);
});

test("signed out: the icon puts the book in the cart and they stay on the page; signing in later keeps it in their cart", async () => {
  const v = visitor();
  const token = await v.token();
  const r = await v.post("/cart/add", { copyId: copy["Card L'Apostrophe"][0], backTo: "/collections/card-shelf", via: "card", _csrf: token }, JSON_ACCEPT);
  assert.deepEqual(await r.json(), { ok: true, inCart: true, cartCount: 1, bookId: id["Card L'Apostrophe"] }, "the same answer as signed in: no login field");
  assert.deepEqual((await v.session()).cartBookIds, [id["Card L'Apostrophe"]], "in the signed-out cart");
  const landing = await signIn(v, await newAccount(), "/collections/card-shelf");
  assert.equal(landing, "/collections/card-shelf");
  assert.deepEqual((await v.session()).cartBookIds, [id["Card L'Apostrophe"]], "the book is still in their cart after signing in");
  assert.match(iconOf(await (await v.get(landing)).text(), id["Card L'Apostrophe"]), /bk-cart-in" href="\/cart" aria-label="Card L&#39;Apostrophe is in your cart \(view cart\)">/);
});

test("signed out, no JavaScript, on a book page (which prints a token anyway): the More-by card's form adds and comes back to the page", async () => {
  const v = visitor();
  const page = await v.get(`/books/${id["Card Choice"]}`);
  const html = await page.text();
  const icon = iconOf(html, id["Card One Copy"]);
  assert.ok(icon, "the More-by card has the icon");
  const token = /name="_csrf" value="([0-9a-f]{64})"/.exec(icon)[1];
  assert.match(icon, new RegExp(`name="backTo" value="/books/${id["Card Choice"]}"><input type="hidden" name="via" value="card">`));
  const r = await v.post("/cart/add", { copyId: copy["Card One Copy"][0], backTo: `/books/${id["Card Choice"]}`, via: "card", _csrf: token });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), `/books/${id["Card Choice"]}`, "back on the page, no sign-in detour");
  assert.equal((await v.session()).cartCount, 1);
  // the book page's own Add to Cart buttons are unchanged (no via=card: back to the cart)
  const own = await v.post("/cart/add", { copyId: copy["Card Choice"][0], backTo: "/cart", _csrf: token });
  assert.equal(own.headers.get("location"), "/cart");
});

test("CSRF: a card add without the token, or with a wrong one, is refused and adds nothing", async () => {
  const v = visitor();
  await signIn(v, await newAccount());
  for (const body of [{ copyId: copy["Card One Copy"][0], via: "card" }, { copyId: copy["Card One Copy"][0], via: "card", _csrf: "0".repeat(64) }]) {
    const r = await v.post("/cart/add", body, JSON_ACCEPT);
    assert.equal(r.status, 403);
    assert.equal((await v.session()).cartCount, 0);
  }
  // the same request with the session's own token is the one that works (so the 403s above are the token, nothing else)
  const ok = await v.post("/cart/add", { copyId: copy["Card One Copy"][0], via: "card", _csrf: await v.token() }, JSON_ACCEPT);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).cartCount, 1);
  const guest = visitor();
  await guest.token();
  const r = await guest.post("/cart/add", { copyId: copy["Card One Copy"][0], via: "card", _csrf: "nope" }, JSON_ACCEPT);
  assert.equal(r.status, 403);
  assert.equal((await guest.session()).cartCount, 0);
  const guestOk = await guest.post("/cart/add", { copyId: copy["Card One Copy"][0], via: "card", backTo: "/books.html", _csrf: await guest.token() }, JSON_ACCEPT);
  assert.deepEqual(await guestOk.json(), { ok: true, inCart: true, cartCount: 1, bookId: id["Card One Copy"] }, "signed out, with the token: added");
});

test("French pages: the names are French, with the English title marked lang=\"en\"", async () => {
  const v = visitor();
  const html = await (await v.get("/fr/collections/card-shelf")).text();
  const one = iconOf(html, id["Card One Copy"]);
  // without JavaScript: the book page (a form, so not prefixed by lib/frUrls.js prefixLinks; it follows the language cookie the /fr/ visit set)
  assert.match(one, new RegExp(`<form class="bk-cart-add" method="get" action="/books/${id["Card One Copy"]}" `));
  assert.doesNotMatch(one, /aria-label/);
  assert.match(one, /<span class="bk-cart-name">Ajouter <span lang="en">Card One Copy<\/span> au panier<\/span>/);
  assert.match(one, /<span class="bk-cart-name"><span lang="en">Card One Copy<\/span> est dans votre panier \(voir le panier\)<\/span>/);
  const choice = iconOf(html, id["Card Choice"]);
  assert.match(choice, new RegExp(`href="/fr/books/${id["Card Choice"]}"`));
  assert.match(choice, /Choisir un exemplaire de <span lang="en">Card Choice<\/span> à ajouter au panier/);
});

// ---------- in a real browser ----------

async function sessionCart(page) {
  const c = (await page.cookies()).find((x) => x.name === "umasbooks.sid" || /sid/.test(x.name));
  const raw = decodeURIComponent(c.value);
  const sid = raw.slice(2, raw.lastIndexOf("."));
  const { rows } = await pool.query("SELECT sess FROM session WHERE sid = $1", [sid]);
  return rows[0] ? rows[0].sess.cart || [] : [];
}

test("in Chrome: signed out, pressing the icon adds without leaving the page; after signing in the book is still in the cart and the next press adds without a reload", async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const account = await newAccount();
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const ip = newIp();
  await page.setExtraHTTPHeaders({ "x-forwarded-for": ip });
  try {
    await page.goto(`${app.base}/collections/card-shelf`, { waitUntil: "networkidle0" });
    const add = (bookId) => `.bk-cart[data-book-id="${bookId}"] .bk-cart-add button`;
    await page.evaluate(() => { window.__sameDocument = true; });
    await page.focus(add(id["Card One Copy"]));
    await page.keyboard.press("Enter");
    await page.waitForFunction((bid) => !document.querySelector(`.bk-cart[data-book-id="${bid}"] .bk-cart-in`).hidden, { timeout: 8000 }, id["Card One Copy"]);
    assert.equal(await page.evaluate(() => window.__sameDocument), true, "signed out: no navigation, no sign-in page");
    assert.equal(new URL(page.url()).pathname, "/collections/card-shelf");
    assert.deepEqual((await sessionCart(page)).map((l) => l.copyId), [copy["Card One Copy"][0]], "the signed-out session row holds the book");
    await page.goto(`${app.base}/login?returnTo=%2Fcollections%2Fcard-shelf`, { waitUntil: "networkidle0" });
    await page.type("input[name=email]", account.email);
    await page.type("input[name=password]", account.password);
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.$eval("input[name=password]", (i) => i.form.requestSubmit())]);
    assert.equal(new URL(page.url()).pathname, "/collections/card-shelf", "back on the collection page");
    assert.equal(await page.$eval(`.bk-cart[data-book-id="${id["Card One Copy"]}"] .bk-cart-in`, (a) => a.hidden), false, "shown as in the cart");
    assert.deepEqual((await sessionCart(page)).map((l) => l.copyId), [copy["Card One Copy"][0]], "the signed-in session row holds the book");

    // signed in: press another book's icon; no reload, the icon turns, focus moves onto it, the header count follows
    await page.evaluate(() => { window.__sameDocument = true; });
    await page.click(add(id["Card Twin Copies"]));
    await page.waitForFunction((bid) => !document.querySelector(`.bk-cart[data-book-id="${bid}"] .bk-cart-in`).hidden, { timeout: 8000 }, id["Card Twin Copies"]);
    assert.equal(await page.evaluate(() => window.__sameDocument), true, "no page reload");
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains("bk-cart-in")), true, "focus is on the in-cart link");
    assert.deepEqual(await page.$$eval("[data-cart-count]", (els) => els.map((e) => e.textContent)).then((a) => [...new Set(a)]), ["2"]);
    assert.deepEqual((await sessionCart(page)).map((l) => l.copyId).sort((a, b) => a - b), [copy["Card One Copy"][0], Math.min(...copy["Card Twin Copies"])].sort((a, b) => a - b));
    await page.waitForFunction(() => document.querySelector(".bk-cart-status").textContent.length > 0);
    assert.equal(await page.$eval(".bk-cart-status", (e) => e.textContent), "Added to your cart: Card Twin Copies.");

    // the Browse page (cards drawn by the script) shows both as in the cart, and the choice card links to the book page
    await page.goto(`${app.base}/books.html`, { waitUntil: "networkidle0" });
    await page.waitForFunction((bid) => { const a = document.querySelector(`#bk-new-track .bk-cart[data-book-id="${bid}"] .bk-cart-in`); return a && !a.hidden; }, { timeout: 8000 }, id["Card One Copy"]);
    assert.match(await page.$eval(`#bk-new-track .bk-cart[data-book-id="${id["Card Choice"]}"] .bk-cart-choose`, (a) => a.getAttribute("href")), new RegExp(`/books/${id["Card Choice"]}$`));
  } finally {
    await ctx.close();
  }
});
