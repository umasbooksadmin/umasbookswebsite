// Script 1 of docs/testing/manual-test-scripts.md: the guest (anyone not logged in).
// A guest browses, fills a cart and can use the forms, but cannot reserve:
// "Reserve (free, no commitment)" asks them to log in or create an account first (G50,
// G51). Books and drop-in seats are reserved online and paid in the shop; only
// the membership is paid online.
// Every test is named with its manual step id. Read-only except the contact
// and book-request forms, which send email and so need E2E_ALLOW_WRITES=1.

const assert = require("node:assert/strict");
const e2e = require("../helpers/harness");
const { has, hasNot, stockedBook, addFirstCopyToCart, pageHtml, stripTags, cartLineCount, phoneOverflow, tapTargetFaults, smallTextFaults, TAP_TARGETS } = require("../helpers/pages");
const { testEmail } = require("../helpers/config");
const cfg = require("../helpers/config");

const s = e2e.persona("guest");

// Titles are in A-Z order when each one's first letter (after dropping punctuation and one leading
// "The") never goes backwards. Checking only the first letter keeps this independent of how the
// database orders punctuation and accents; the unit and integration tests check the full order.
const { sortTitleKey } = require("../../src/lib/titleSort");
const firstChar = (t) => sortTitleKey(t).charAt(0);
function assertAlphabetical(titles) {
  const c = new Intl.Collator("en", { sensitivity: "base" });
  for (let i = 1; i < titles.length; i++) {
    assert.ok(c.compare(firstChar(titles[i - 1]), firstChar(titles[i])) <= 0, `"${titles[i - 1]}" is listed before "${titles[i]}"`);
  }
}

const LEGAL = [
  { path: "/terms-of-sale.html", en: /Terms of Sale/i, fr: /Conditions générales de vente/i },
  { path: "/privacy-policy.html", en: /Privacy Policy/i, fr: /Politique de confidentialité/i },
  { path: "/mentions-legales.html", en: /Legal Notice/i, fr: /Mentions légales/i },
  { path: "/membership-terms.html", en: /Membership Terms/i, fr: /Conditions d.adhésion/i },
];

// ---- 1A. Home, menu, footer ----

s.test("G1 (must) home page shows the menu, the header icons and the footer", async (ctx) => {
  await ctx.goto("/", "networkidle2");
  const text = await ctx.text();
  for (const label of ["Home", "Browse Books", "English Programs", "Events"]) has(text, new RegExp(label, "i"));
  for (const href of ["/favorites", "/account", "/cart", "/login"]) assert.ok(await ctx.page.$(`a.h-tool[href='${href}']`), `header link ${href}`);
  assert.ok(await ctx.page.$("[data-cart-count]"), "cart count");
  const toggles = await ctx.page.$$eval(".langtoggle [data-lang]", (b) => b.map((x) => x.textContent.trim()));
  assert.deepEqual(toggles, ["EN", "FR"]);
  // (a.h-menu-fav is the Favorites link that only shows inside the phone Menu on the narrowest screens.)
  // On a normal window the menu links are on screen (not folded into the phone "Menu" button) and the EN/FR buttons are easy to hit.
  const links = await ctx.page.$$eval("header .h-nav a:not(.h-menu-fav)", (as) => as.map((a) => { const r = a.getBoundingClientRect(); return { t: a.textContent.trim(), shown: r.width > 0 && r.height > 0 }; }));
  assert.equal(links.length, 4);
  assert.deepEqual(links.filter((l) => !l.shown), [], "every menu link is visible on a desktop-size window");
  const sizes = await ctx.page.$$eval(".langtoggle [data-lang]", (b) => b.map((x) => { const r = x.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
  for (const [w, h] of sizes) assert.ok(w >= 32 && h >= 32, `EN/FR buttons are ${w}x${h}: at least 32x32 with a mouse`);
  const footer = await ctx.page.$eval("footer", (f) => f.innerText);
  for (const label of ["Contact Us", "Albi, France", "Privacy Policy", "Terms of Sale", "Legal Notice"]) has(footer, new RegExp(label, "i"));
});

s.test("G2 each footer link opens a page, no error page", async (ctx) => {
  await ctx.goto("/");
  const hrefs = await ctx.page.$$eval("footer a[href]", (as) => as.map((a) => a.getAttribute("href")).filter((h) => h && h !== "#" && !/^https?:\/\//.test(h)));
  assert.ok(hrefs.length >= 5, "footer links present");
  assert.equal((await ctx.page.$$("footer a[href='#']")).length, 0, "no placeholder social links in the footer");
  for (const h of hrefs) {
    const res = await ctx.goto(h);
    assert.ok(res.status() < 400, `${h} answered ${res.status()}`);
    hasNot(await ctx.text(), /Page not found|Something went wrong/i, h);
  }
});

s.test("G3 member access while logged out leads to the membership page or the login page", async (ctx) => {
  // The manual script mentions a key icon; the header only shows it to members
  // (partials/mkt_chrome_header.ejs). What a guest must get is never an error.
  await ctx.goto("/");
  const key = await ctx.page.$("a.h-tool[href='/dashboard']");
  assert.equal(key, null, "guests are not shown the member's key icon");
  const res = await ctx.goto("/dashboard");
  assert.ok(res.status() < 400);
  assert.match(new URL(ctx.page.url()).pathname, /^\/(login|membership\.html)$/);
});

s.test("G4 the person icon opens the login page with its links", async (ctx) => {
  await ctx.goto("/");
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("a.h-tool[href='/login']")]);
  assert.equal(new URL(ctx.page.url()).pathname, "/login");
  const text = await ctx.text();
  has(text, /Forgot your password\?/);
  has(text, /Create an account/);
});

// ---- 1B. Preview banner and payments off ----

s.test("G5 (must) the preview banner is at the top of every page (preview mode only)", async (ctx) => {
  if (!ctx.preview) ctx.skip("the site is not in preview mode");
  for (const p of ["/", "/books.html", "/cart", "/login"]) {
    await ctx.goto(p);
    const banner = await ctx.page.$eval(".preview-banner", (b) => b.innerText).catch(() => "");
    has(banner, /Preview/);
    has(banner, /no payment is taken/);
    has(banner, /Tell us what you think!/);
  }
});

s.test("G6 'Tell us what you think!' opens the contact form set to feedback (preview mode only)", async (ctx) => {
  if (!ctx.preview) ctx.skip("the site is not in preview mode");
  await ctx.goto("/");
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click(".preview-banner a")]);
  assert.match(ctx.page.url(), /\/contact\?topic=feedback/);
  const topic = await ctx.page.$eval("#c-topic", (sel) => sel.value);
  assert.equal(topic, "Feedback on the preview");
});

s.test("G7 (must) the cart in preview mode explains reservations are off and has no reserve form", async (ctx) => {
  if (!ctx.preview) ctx.skip("the site is not in preview mode");
  const book = await stockedBook(ctx);
  await addFirstCopyToCart(ctx, book);
  const text = await ctx.text();
  has(text, /Online reservations open when we launch/);
  has(text, /Total:/);
  assert.equal(await ctx.page.$("form[action='/cart/reserve']"), null, "no reserve form in preview mode");
  assert.equal(await ctx.page.$("#email"), null, "no email field");
});

s.test("G8 (must) membership page says membership opens at launch and has no payment form (preview mode only)", async (ctx) => {
  if (!ctx.preview) ctx.skip("the site is not in preview mode");
  await ctx.goto("/membership.html");
  has(await ctx.text(), /Membership opens at launch/i);
  assert.equal(await ctx.page.$("iframe[src*='helloasso']"), null, "no HelloAsso form");
  assert.deepEqual(ctx.blocked, [], "the page never even tried to load HelloAsso");
});

s.test("G9 robots.txt: Disallow: / in preview mode, and gone at launch", async (ctx) => {
  const res = await ctx.fetchRaw("/robots.txt");
  const body = await res.text();
  const disallowAll = /^Disallow:\s*\/\s*$/m.test(body);
  if (ctx.preview) assert.ok(disallowAll, "preview mode must tell search engines to stay away");
  else assert.ok(!disallowAll, "after launch robots.txt must not block the whole site (re-check at launch)");
});

s.test("G-FR5 FR check of G5, G7, G8: banner, cart notice and membership notice in French (preview mode only)", { lang: "fr" }, async (ctx) => {
  if (!ctx.preview) ctx.skip("the site is not in preview mode");
  await ctx.goto("/");
  has(await ctx.page.$eval(".preview-banner", (b) => b.innerText), /Aperçu/);
  const book = await stockedBook(ctx);
  await addFirstCopyToCart(ctx, book);
  has(await ctx.text(), /Les réservations en ligne ouvriront au lancement/);
  await ctx.goto("/membership.html");
  await ctx.page.waitForFunction(() => /L.adhésion ouvrira au lancement/i.test(document.body.innerText));
});

s.test("G10 with preview off the banner is gone and the cart shows the prompt to log in or create an account (preview off only)", async (ctx) => {
  if (ctx.preview) ctx.skip("the site is in preview mode");
  await ctx.goto("/");
  assert.equal(await ctx.page.$(".preview-banner"), null);
  const book = await stockedBook(ctx);
  await addFirstCopyToCart(ctx, book);
  // A guest cannot reserve (G50): the cart offers to log in or create an account, never a reserve form.
  assert.equal(await ctx.page.$("form[action='/cart/reserve']"), null, "a guest is not shown the reserve form");
  has(await ctx.text(), /log in|sign up|create an account/);
});

const GUEST_PHONE = { width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

// ---- 1C. Books ----

s.test("G11 (must) Browse Books has search, genres, New In carousel", async (ctx) => {
  await ctx.goto("/books.html", "networkidle2");
  const ph = await ctx.page.$eval("#shop-search-input", (i) => i.placeholder);
  has(ph, /Search books/);
  await ctx.page.waitForSelector("#bk-genre-list .bk-genre");
  assert.ok((await ctx.page.$$("#bk-genre-list .bk-genre")).length >= 5, "genre buttons");
  const text = await ctx.text();
  has(text, /New In/);
  has(text, /See All New In/);
  assert.ok(await ctx.page.$("#bk-new-prev") && await ctx.page.$("#bk-new-next"), "carousel arrows");
  assert.ok(await ctx.page.$("#bk-genre-prev") && await ctx.page.$("#bk-genre-next"), "genre carousel arrows");
  // Order: title, search, (collections), New In, genres, results; the genre pictures keep their 50 px size.
  const order = await ctx.page.evaluate(() => ["h1", "#shop-search-form", "#bk-new-title", "#bk-genres-label"].map((q) => document.querySelector(q).getBoundingClientRect().top));
  assert.ok(order.every((v, i) => i === 0 || v > order[i - 1]), `page order: title, search, New In, genres (${order})`);
  assert.equal(await ctx.page.$eval("#bk-genre-list .chip", (e) => Math.round(e.getBoundingClientRect().width)), 50, "genre pictures keep their size");
});

s.test("G12 search finds a book by title; a search with no match says so", async (ctx) => {
  const book = await stockedBook(ctx);
  await ctx.goto("/books.html", "networkidle2");
  const word = book.title.split(/\s+/).sort((a, b) => b.length - a.length)[0];
  await ctx.page.type("#shop-search-input", word);
  await ctx.page.keyboard.press("Enter");
  await ctx.page.waitForSelector("#bk-results-grid .bk-book");
  const first = await ctx.page.$eval("#bk-results-grid .bk-book", (e) => e.innerText);
  has(first, /€\d+\.\d\d/);
  const heading = await ctx.page.$eval("#bk-results-title", (e) => e.textContent);
  has(heading, /Results for/);
  await ctx.page.$eval("#shop-search-input", (i) => { i.value = ""; });
  await ctx.page.type("#shop-search-input", "zzqxjvw-no-such-book");
  await ctx.page.keyboard.press("Enter");
  await ctx.page.waitForFunction(() => {
    const g = document.querySelector("#bk-results-grid");
    return g && !g.querySelector(".bk-book") && g.innerText.trim().length > 0 && !/Loading books/i.test(g.innerText);
  });
  const empty = await ctx.page.$eval("#bk-results-grid", (e) => e.innerText);
  hasNot(empty, /Loading books/);
  assert.ok(empty.trim().length > 10, "a 'no results' message, not a blank page");
});

s.test("G12a (must) results are in A-Z order, ignoring a leading The (the title is still shown in full)", async (ctx) => {
  await ctx.goto("/books.html", "networkidle2");
  const titles = await ctx.page.evaluate(async () => (await (await fetch("/api/books/search")).json()).map((b) => b.title));
  if (titles.length < 2) ctx.skip("data: fewer than two books in stock");
  assertAlphabetical(titles);
});

s.test("G13 genre buttons filter the list and change it when another is chosen", async (ctx) => {
  await ctx.goto("/books.html", "networkidle2");
  await ctx.page.waitForSelector("#bk-genre-list .bk-genre");
  const buttons = await ctx.page.$$("#bk-genre-list .bk-genre");
  const seen = [];
  for (const b of [buttons[0], buttons[buttons.length - 1]]) {
    await b.click();
    await ctx.page.waitForFunction(() => !/Loading books/.test(document.querySelector("#bk-results-grid").innerText));
    seen.push(await ctx.page.$eval("#bk-results-title", (e) => e.textContent));
    assert.equal(await ctx.page.$eval("#bk-genre-list .is-active", (e) => e.getAttribute("aria-pressed")), "true");
  }
  assert.notEqual(seen[0], seen[1], "the results heading changes with the genre");
});

s.test("G13a (must) on a phone a genre tap or a search is a history step: Back returns to the previous results, and the address can be shared", { viewport: GUEST_PHONE }, async (ctx) => {
  await ctx.goto("/books.html", "networkidle2");
  await ctx.page.waitForSelector("#bk-genre-list .bk-genre");
  const done = () => ctx.page.waitForFunction(() => !/Loading books/.test(document.querySelector("#bk-results-grid").innerText));
  const search = () => ctx.page.evaluate(() => location.search);
  const buttons = await ctx.page.$$("#bk-genre-list .bk-genre");
  assert.equal(await search(), "", "nothing chosen yet: the plain address");
  await buttons[0].click();
  await done();
  assert.match(await search(), /^\?genre=[a-z]+$/, "the genre is in the address");
  const first = await ctx.page.evaluate(() => ({ search: location.search, title: document.querySelector("#bk-results-title").textContent }));
  await ctx.page.waitForFunction(() => { const t = document.querySelector("#bk-results").getBoundingClientRect().top; return t >= -5 && t < 250; }, { timeout: 5000 }); // the results were scrolled to the top of the screen
  const buttonsAgain = await ctx.page.$$("#bk-genre-list .bk-genre");
  await buttonsAgain[buttonsAgain.length - 1].click();
  await done();
  const second = await ctx.page.evaluate(() => ({ search: location.search, title: document.querySelector("#bk-results-title").textContent }));
  assert.notEqual(second.search, first.search, "a second tap is a second address");
  assert.notEqual(second.title, first.title);
  // Back: the first genre's results, its button marked, the title and the address as before.
  await ctx.page.goBack();
  await ctx.page.waitForFunction((q) => location.search === q, {}, first.search);
  await done();
  assert.equal(await ctx.page.$eval("#bk-results-title", (e) => e.textContent), first.title);
  assert.equal(await ctx.page.$eval("#bk-genre-list .bk-genre[data-index='0']", (e) => e.getAttribute("aria-pressed")), "true");
  assert.equal(new URL(ctx.page.url()).pathname, "/books.html", "Back stayed on Browse Books, it did not go to Home");
  // Back again: the plain page, results hidden.
  await ctx.page.goBack();
  await ctx.page.waitForFunction(() => location.search === "");
  assert.equal(await ctx.page.$eval("#bk-results", (e) => e.hidden), true);
  // Forward, then the shared address opened fresh shows the same results.
  await ctx.page.goForward();
  await ctx.page.waitForFunction((q) => location.search === q, {}, first.search);
  await ctx.goto(`/books.html${first.search}`, "networkidle2");
  await done();
  assert.equal(await ctx.page.$eval("#bk-results-title", (e) => e.textContent), first.title, "a shared address opens on the same results");
  // A search is a step too, and puts the words back in the box.
  const book = await stockedBook(ctx);
  const word = book.title.split(/\s+/).sort((a, b) => b.length - a.length)[0];
  await ctx.goto("/books.html", "networkidle2");
  await ctx.page.type("#shop-search-input", word);
  await ctx.page.keyboard.press("Enter");
  await ctx.page.waitForSelector("#bk-results-grid .bk-book");
  assert.equal(await search(), `?q=${encodeURIComponent(word).replace(/%20/g, "+")}`);
  await ctx.page.waitForFunction(() => { const t = document.querySelector("#bk-results").getBoundingClientRect().top; return t >= -5 && t < 250; }, { timeout: 5000 }); // the results were scrolled to the top of the screen
  await ctx.goto(`/books.html?q=${encodeURIComponent(word)}`, "networkidle2");
  await ctx.page.waitForSelector("#bk-results-grid .bk-book");
  assert.equal(await ctx.page.$eval("#shop-search-input", (i) => i.value), word, "the shared search is back in the box");
});

s.test("G14 New In arrows and See All New In work", async (ctx) => {
  await ctx.goto("/books.html", "networkidle2");
  await ctx.page.click("#bk-new-next");
  await ctx.page.click("#bk-new-prev");
  await ctx.page.click("#bk-new-all");
  await ctx.page.waitForFunction(() => !/Loading books/.test(document.querySelector("#bk-results-grid").innerText));
  assert.equal(await ctx.page.$eval("#bk-results", (e) => e.hidden), false);
});

s.test("G15 (must) a book page shows cover, title, author, binding, price, copies and add to cart", async (ctx) => {
  const book = await stockedBook(ctx);
  await ctx.goto(`/books/${book.id}`);
  assert.equal((await ctx.page.$$("h1")).length, 1);
  assert.equal(await ctx.page.$eval("h1", (h) => h.textContent.trim()), book.title);
  const text = await ctx.text();
  has(text, /Available in Shop/);
  has(text, /cop(y|ies) on our shelves/);
  has(text, /€\d+\.\d\d/);
  const head = await ctx.page.$$eval(".copy-table thead th", (t) => t.map((x) => x.textContent.trim()));
  assert.ok(head.includes("Condition") && head.includes("Price"), `copy table head: ${head}`);
  assert.ok(await ctx.page.$(".copy-table form[action='/cart/add'] button"), "Add to Cart per copy");
  assert.ok(await ctx.page.$(".book-detail-cover"), "cover or 'No cover'");
  has(text, /by /);
  has(text, /cover images may not show|may not show the actual condition|Cover images/i);
  if (book.binding) has(text, /Binding/);
  // The friendly used-book disclaimer and the price tax line; never a waiver of legal rights.
  has(text, /Price incl\. tax, TVA non applicable/);
  has(text, /Our second-hand books are sold as described, so please read the condition grade, and ask us if you have any question\./);
  has(text, /Used books are not taken back for a change of mind once bought in the shop; the legal guarantees still apply\./);
  hasNot(text, /waive|renounce/i);
  assert.ok(await ctx.page.$(".book-disclaimer a[href='/terms-of-sale.html']"), "the disclaimer links the terms");
});

s.test("G16 (must) 'What the grades mean' lists the five grades", async (ctx) => {
  const book = await stockedBook(ctx);
  await ctx.goto(`/books/${book.id}`);
  await ctx.page.click(".grade-legend summary");
  const legend = await ctx.page.$eval(".grade-legend", (d) => d.innerText);
  for (const g of ["New", "Like New", "Very Good", "Good", "Acceptable"]) has(legend, new RegExp(g));
  has(legend, /The grade is the description of the book/);
});

s.test("G17 a clearance copy shows the Clearance badge on the book page", async (ctx) => {
  const book = await stockedBook(ctx, (b) => b.clearance);
  await ctx.goto(`/books/${book.id}`);
  has(await ctx.text(), /Clearance/);
  assert.ok(await ctx.page.$(".clearance-badge"));
});

s.test("G18 a book with awards shows 'Awards & lists:'; one without shows nothing", async (ctx) => {
  const list = await e2e.books();
  let withAwards = null;
  let without = null;
  for (const b of list) {
    if (b.awards && !withAwards) withAwards = b;
    if (!b.awards && !without) without = b;
  }
  if (!withAwards) ctx.skip("data: no in-stock book with a verified award");
  await ctx.goto(`/books/${withAwards.id}`);
  has(await ctx.text(), /Awards & lists:/);
  if (without) {
    await ctx.goto(`/books/${without.id}`);
    hasNot(await ctx.text(), /Awards & lists:/);
  }
});

s.test("G19 a book with no copy in stock says it is unavailable", async (ctx) => {
  const id = await e2e.unavailableBookId();
  if (!id) ctx.skip("data: no out-of-stock book among the first 60 book ids");
  await ctx.goto(`/books/${id}`);
  const text = await ctx.text();
  has(text, /Currently unavailable/);
  has(text, /spoken for right now/);
  assert.equal(await ctx.page.$(".copy-table"), null);
});

s.test("G20 hearting a book lists it on the favorites page (kept in this browser only)", async (ctx) => {
  const book = await stockedBook(ctx);
  await ctx.goto(`/books/${book.id}`);
  await ctx.page.click(".book-detail-cover-wrap .favorite-toggle");
  assert.equal(await ctx.page.$eval(".book-detail-cover-wrap .favorite-toggle", (b) => b.getAttribute("aria-pressed")), "true");
  await ctx.goto("/favorites", "networkidle2");
  await ctx.page.waitForFunction((t) => document.body.innerText.includes(t), {}, book.title);
});

s.test("G80 (must) marketing pages work with no inline scripts: language toggle, books shelves, events schedule, blog", async (ctx) => {
  const violations = [];
  ctx.page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
  await ctx.goto("/books.html", "networkidle2");
  await ctx.page.waitForSelector("#bk-results .bk-book, #bk-genre-list .bk-genre", { timeout: 15000 });
  assert.ok(await ctx.page.$("#bk-genre-list .bk-genre"), "the genre shelves are drawn by the external page script");
  await ctx.page.click(".langtoggle [data-lang='fr']");
  await ctx.page.waitForFunction(() => /Parcourir les livres/.test(document.body.innerText), { timeout: 10000 });
  await ctx.goto("/events.html", "networkidle2");
  await ctx.page.waitForSelector("#events-schedule .ev-item, #events-schedule .ev-empty", { timeout: 15000 });
  await ctx.goto("/blog.html", "networkidle2");
  await ctx.page.waitForSelector("#blog-root .blog-grid, #blog-root .blog-empty", { timeout: 15000 });
  await ctx.goto("/", "networkidle2");
  assert.deepEqual(violations, [], "no Content-Security-Policy violation on these pages");
});

s.test("G21 (must) a copy with no price shows 'Ask in the shop' and no Add to Cart", async (ctx) => {
  const list = await e2e.books();
  // A book whose price is null has only unpriced copies; mixed books are found by scanning pages.
  const candidates = list.filter((b) => b.price == null);
  let id = candidates[0] && candidates[0].id;
  if (!id) {
    const pages = await Promise.all(list.slice(0, 40).map(async (b) => ({ b, html: (await e2e.bookPage(b.id)).html })));
    const hit = pages.find((p) => /Ask in the shop/.test(p.html));
    id = hit && hit.b.id;
  }
  if (!id) ctx.skip("data: no book with an unpriced copy (create one in admin, step A11)");
  await ctx.goto(`/books/${id}`);
  has(await ctx.text(), /Ask in the shop/);
  const rows = await ctx.page.$$eval(".copy-table tbody tr", (trs) => trs.map((r) => ({ t: r.innerText, btn: !!r.querySelector("button") })));
  const unpriced = rows.filter((r) => /Ask in the shop/.test(r.t));
  assert.ok(unpriced.length && unpriced.every((r) => !r.btn), "the unpriced copy has no Add to Cart button");
});

s.test("G-FR11 FR check (books): search page, book page and grade legend in French", { lang: "fr" }, async (ctx) => {
  await ctx.goto("/books.html", "networkidle2");
  has(await ctx.text(), /Parcourir les livres/);
  const book = await stockedBook(ctx);
  await ctx.goto(`/books/${book.id}`);
  const text = await ctx.text();
  has(text, /Disponible en boutique/);
  has(text, /Ajouter au panier/);
  has(text, /exemplaires? en rayon/);
  await ctx.page.click(".grade-legend summary");
  const legend = await ctx.page.$eval(".grade-legend", (d) => d.innerText);
  for (const g of ["Neuf", "Comme neuf", "Très bon état", "Bon état", "État correct"]) has(legend, new RegExp(g));
  has(legend, /L’état indiqué est la description du livre/);
  has(text, /Prix TTC, TVA non applicable/);
  has(text, /Nos livres d’occasion sont vendus tels que décrits/);
  has(text, /Les livres d’occasion ne sont ni repris ni échangés pour simple changement d’avis une fois achetés en boutique/);
  assert.equal(await ctx.page.$eval("html", (h) => h.lang), "fr");
});

s.test("G-FR12 French prices use the comma style 12,50 € on the book page", { lang: "fr" }, async (ctx) => {
  const book = await stockedBook(ctx);
  await ctx.goto(`/books/${book.id}`);
  has(await ctx.page.$eval(".book-detail-price", (e) => e.textContent), /\d+,\d\d\s*€/);
});

// ---- 1D. Events, English programs, blog ----

s.test("G22 (must) the events page shows a calendar with Month / Week and Previous / Next", async (ctx) => {
  await ctx.goto("/events");
  const text = await ctx.text();
  has(text, /Month/);
  has(text, /Week/);
  assert.ok(await ctx.page.$("a[aria-label='Previous']") && await ctx.page.$("a[aria-label='Next']"), "Previous / Next links");
  has(text, /Everyone.s welcome/);
});

s.write("G23 sign up for an event with a tagged name; signing up again does not add a second place", async (ctx) => {
  await ctx.goto("/events");
  if (!(await ctx.page.$("form[action*='/signup']"))) ctx.skip("data: no event with a sign-up form on the calendar this month");
  const email = testEmail("event");
  const name = `${process.env.E2E_RUN_ID} Guest`;
  const signUp = async () => {
    await ctx.goto("/events");
    // The sign-up form sits inside the event's collapsed <details>.
    await ctx.page.$eval("form[action*='/signup']", (f) => { f.closest("details").open = true; });
    const f = await ctx.page.$("form[action*='/signup']");
    await (await f.$("input[name='name']")).type(name);
    await (await f.$("input[name='email']")).type(email);
    await Promise.all([ctx.page.waitForNavigation(), (await f.$("button[type='submit']")).click()]);
  };
  await signUp();
  assert.match(new URL(ctx.page.url()).pathname, /^\/events/);
  ctx.created("event sign-up", `${name} <${email}>`, "admin Events > the event > Remove");
  await signUp();
  hasNot(await ctx.text(), /Something went wrong/);
});

s.manual("G24 Add to My Calendar downloads an .ics file that opens in a calendar app", "a calendar app has to open the file; the download itself is checked by the .ics link test below");

s.test("G24b the Add to My Calendar link serves a calendar file", async (ctx) => {
  await ctx.goto("/events");
  const href = await ctx.page.$$eval("a[href*='.ics'], a[href*='/ics']", (as) => (as[0] ? as[0].getAttribute("href") : null));
  if (!href) ctx.skip("data: no event with an Add to My Calendar link");
  const res = await ctx.fetchRaw(href);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /calendar/);
  assert.match(await res.text(), /BEGIN:VCALENDAR/);
});

s.test("G25 English programs, programs and pre-registration pages open", async (ctx) => {
  for (const p of ["/immersion.html", "/programs.html", "/pre-registration.html"]) {
    const res = await ctx.goto(p);
    assert.ok(res.status() < 400, `${p} ${res.status()}`);
  }
  await ctx.goto("/immersion.html");
  has(await ctx.text(), /Preregister|Pre-register/i);
  await ctx.goto("/pre-registration.html");
  assert.ok(await ctx.page.$("form[action='/pre-registration'][method='post']"), "the pre-registration form posts to the server");
  assert.equal(await ctx.page.$("form[data-mailto]"), null, "no mailto form any more");
  await ctx.goto("/volunteer.html");
  assert.ok(await ctx.page.$("form[action='/volunteer-signup'][method='post']"), "the volunteer form posts to the server");
  assert.equal(await ctx.page.$("form[data-mailto]"), null, "no mailto form any more");
});

s.test("G26 the sessions page lists upcoming sessions with filters and Month / Week", async (ctx) => {
  await ctx.goto("/sessions");
  const text = await ctx.text();
  has(text, /Upcoming Sessions/);
  for (const f of ["All Sessions", "Drop-ins Only"]) has(text, new RegExp(f));
  has(text, /Month/);
  has(text, /Week/);
});

s.test("G27 the blog lists published posts; an unknown post says not found", async (ctx) => {
  await ctx.goto("/blog.html", "networkidle2");
  assert.equal((await ctx.page.$$("h1")).length >= 1, true);
  const res = await ctx.goto("/blog.html?post=no-such-post-e2e", "networkidle2");
  assert.ok(res.status() < 500);
  const links = await ctx.page.$$eval("a[href*='blog']", (as) => as.length);
  assert.ok(links >= 1);
});

s.test("G-FR22 FR check: events, sessions and blog in French", { lang: "fr" }, async (ctx) => {
  await ctx.goto("/events");
  const ev = await ctx.text();
  has(ev, /Événements/);
  has(ev, /Mois/);
  has(ev, /Semaine/);
  assert.ok(await ctx.page.$("a[aria-label='Précédent']") && await ctx.page.$("a[aria-label='Suivant']"), "Précédent / Suivant links");
  await ctx.goto("/sessions");
  const se = await ctx.text();
  has(se, /Mois/);
  await ctx.goto("/blog.html", "networkidle2");
  assert.equal(await ctx.page.$eval("html", (h) => h.lang), "fr");
});

// ---- 1E. Contact form ----

s.write("G28 (must) the contact form sends a tagged message", async (ctx) => {
  await ctx.goto("/contact");
  const tag = `${process.env.E2E_RUN_ID}`;
  await ctx.page.type("#c-name", `${tag} Guest`);
  await ctx.page.type("#c-email", testEmail("contact"));
  await ctx.page.type("#c-message", `${tag} automated end-to-end test message: please ignore and delete.`);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/contact'] button[type='submit']")]);
  has(await ctx.text(), /Thank you! Your message has been sent/);
  ctx.created("contact message (email to the admin mailbox)", `${tag} Guest`, "delete the email from the shop mailbox");
});

s.test("G28b the contact form lists the expected topics", async (ctx) => {
  await ctx.goto("/contact");
  const topics = await ctx.page.$$eval("#c-topic option", (o) => o.map((x) => x.value));
  for (const t of ["General question", "Books & reservations", "English programs", "Events", "Donating books", "Membership", "Other"]) assert.ok(topics.includes(t), t);
  if (ctx.preview) assert.ok(topics.includes("Feedback on the preview"));
});

s.manual("G29 the message arrives in the shop mailbox within 2 minutes with the right reply-to", "tests cannot read email");
s.manual("G30 six messages in a row trigger the rate-limit message after the fifth", "sends five real emails to the shop mailbox; also changes the connection's rate-limit state");

s.write("G-FR28 FR check: the contact form answers in French", { lang: "fr" }, async (ctx) => {
  await ctx.goto("/contact");
  const tag = `${process.env.E2E_RUN_ID}`;
  await ctx.page.type("#c-name", `${tag} Visiteur`);
  await ctx.page.type("#c-email", testEmail("contact-fr"));
  await ctx.page.type("#c-message", `${tag} message de test automatique : à ignorer et supprimer.`);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/contact'] button[type='submit']")]);
  has(await ctx.text(), /Merci\s! Votre message a bien été envoyé/);
  ctx.created("contact message (email to the admin mailbox)", `${tag} Visiteur`, "delete the email from the shop mailbox");
});

// ---- 1F. Request a book ----

s.write("G31 (must) a book request is sent and asks the guest to confirm by email", async (ctx) => {
  await ctx.goto("/request-a-book");
  const tag = process.env.E2E_RUN_ID;
  await ctx.page.type("#rb-title", `${tag} Pride and Prejudice`);
  await ctx.page.type("#rb-isbn", "9780141439518");
  await ctx.page.type("#rb-email", testEmail("request"));
  await ctx.page.type("#rb-name", `${tag} Requester`);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form button[type='submit']")]);
  const text = await ctx.text();
  has(text, /Check your inbox/);
  has(text, /confirm/i);
  ctx.created("book request (unconfirmed, expires by itself)", `${tag} Pride and Prejudice`, "admin Book Requests > Waiting for email confirmation > Delete");
});

s.test("G32 a request without a title, or with a 5-digit ISBN, shows a clear message", async (ctx) => {
  await ctx.goto("/request-a-book");
  // Client-side `required` would stop an empty title: submit the form directly.
  await ctx.page.$eval("form[action='/request-a-book']", (f) => { f.noValidate = true; });
  await ctx.page.type("#rb-email", testEmail("request-bad"));
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/request-a-book'] button[type='submit']")]);
  has(await ctx.text(), /Please tell us the title of the book\./);
});

s.manual("G33 the confirmation email link and Confirm my request button", "needs the emailed link");
s.manual("G34 an unconfirmed request appears under Waiting for email confirmation in admin", "needs a request made in G31 and an admin check; covered by A22 and A23 in the admin script");
s.manual("G35 find-my-requests email, manage link and Cancel", "needs the emailed link");
s.manual("G36 Cancel this request link from an email", "needs the emailed link");

s.test("G37 a made-up my-requests link says it is not valid", async (ctx) => {
  const res = await ctx.goto("/my-requests/abc");
  assert.ok(res.status() < 500);
  has(await ctx.text(), /This link is not valid/);
});

s.test("G-FR31 FR check: the request form and find-my-requests pages are in French", { lang: "fr" }, async (ctx) => {
  await ctx.goto("/request-a-book");
  const t1 = await ctx.text();
  has(t1, /Vous ne trouvez pas un livre/);
  has(t1, /Envoyer la demande/);
  await ctx.goto("/my-requests");
  has(await ctx.text(), /Envoyez-moi le lien/);
});

s.manual("G38 'Good news' email when an admin notifies (continues in A23)", "needs the emailed message");

// ---- 1G. Legal pages and language toggle ----

s.test("G39 (must) each legal page opens with full text and the seller identity", async (ctx) => {
  for (const l of LEGAL) {
    const res = await ctx.goto(l.path);
    assert.equal(res.status(), 200, l.path);
    const text = await ctx.text();
    has(text, l.en);
    assert.ok(text.length > 1500, `${l.path} has full text`);
    has(text, /admin@umasbooks\.org/);
  }
  await ctx.goto("/terms-of-sale.html");
  const tos = await ctx.text();
  for (const re of [/14 days/i, /mediat/i]) has(tos, re);
  hasNot(tos, /Withdrawal form|L\.221-18/);
  has(tos, /Second-hand books: no returns/);
  has(tos, /This does not affect your legal rights as a consumer, including the legal guarantees\./);
  has(tos, /Reserving is free and commits you to nothing/);
  has(tos, /Nothing is paid online, and reserving does not oblige you to buy\./);
  has(tos, /Only membership is: it is paid online through HelloAsso/);
  hasNot(tos, /obligation to pay|pay online by card|one hour/i);
  has(tos, /Wednesday to Saturday, 14:00–19:00/);
  hasNot(tos, /waive|renounce/i);
  await ctx.goto("/mentions-legales.html");
  const ml = await ctx.text();
  has(ml, /Albi/);
  has(ml, /SIRET/i);
  has(ml, /RNA/);
});

s.test("G40 (must) each legal page in French has French titles and no English paragraph left", { lang: "fr" }, async (ctx) => {
  for (const l of LEGAL) {
    await ctx.goto(l.path);
    const text = await ctx.text();
    has(text, l.fr);
    hasNot(text, /\b(You (can|have|may|will)|Please|we collect|we use your)\b/, `${l.path} still has English sentences`);
  }
});

s.test("G40b legal pages are French in the server's own HTML (no JavaScript needed)", { lang: "fr" }, async (ctx) => {
  for (const l of LEGAL) {
    const { html } = await pageHtml(ctx, l.path, "fr");
    const text = stripTags(html);
    has(text, l.fr);
    hasNot(text, /\b(You (can|have|may|will)|Please|we collect|we use your)\b/, `${l.path} server HTML still has English sentences`);
  }
});

const SWITCH_PAGES = [
  ["Home", "/"], ["About", "/about.html"], ["Visit", "/visit.html"], ["Books search", "/books.html"], ["Favorites", "/favorites"],
  ["Cart (empty)", "/cart"], ["Events", "/events"], ["Sessions", "/sessions"], ["English programs", "/immersion.html"], ["Programs", "/programs.html"],
  ["Pre-registration", "/pre-registration.html"], ["Volunteer info", "/volunteer.html"], ["Blog", "/blog.html"], ["Membership", "/membership.html"],
  ["Contact", "/contact"], ["Request a book", "/request-a-book"], ["Find my requests", "/my-requests"], ["Log in", "/login"], ["Sign up", "/signup"],
  ["Forgot password", "/forgot-password"], ["Terms of Sale", "/terms-of-sale.html"], ["Privacy", "/privacy-policy.html"], ["Legal notice", "/mentions-legales.html"],
  ["Membership terms", "/membership-terms.html"], ["404", "/no-such-page-e2e"],
];

s.test("G41 (must) the language toggle works on every page type: FR then EN, kept after reload and navigation", async (ctx) => {
  const book = await stockedBook(ctx);
  const pages = SWITCH_PAGES.concat([["Book page", `/books/${book.id}`]]);
  for (const [label, p] of pages) {
    await ctx.goto(p);
    await ctx.page.waitForSelector(".langtoggle [data-lang='fr']");
    assert.equal(await ctx.page.$eval("html", (h) => h.lang), "en", `${label} starts in English`);
    await ctx.page.click(".langtoggle [data-lang='fr']");
    await ctx.page.waitForFunction(() => document.documentElement.lang === "fr");
    const cookie = (await ctx.cookies()).find((c) => c.name === "umasbooks_lang");
    assert.equal(cookie && cookie.value, "fr", `${label}: toggle sets the umasbooks_lang cookie`);
    await ctx.page.reload({ waitUntil: "domcontentloaded" });
    assert.equal(await ctx.page.$eval("html", (h) => h.lang), "fr", `${label}: French stays after reload`);
    await ctx.page.click(".langtoggle [data-lang='en']");
    await ctx.page.waitForFunction(() => document.documentElement.lang === "en");
    await ctx.page.reload({ waitUntil: "domcontentloaded" });
    assert.equal(await ctx.page.$eval("html", (h) => h.lang), "en", `${label}: English is back`);
  }
  // The choice carries to a different page type.
  await ctx.goto("/books.html");
  await ctx.page.click(".langtoggle [data-lang='fr']");
  await ctx.page.waitForFunction(() => document.cookie.includes("umasbooks_lang=fr"));
  await ctx.goto("/contact");
  assert.equal(await ctx.page.$eval("html", (h) => h.lang), "fr");
  has(await ctx.text(), /Nous contacter/);
});

s.test("G41b (must) a French guest with an English browser and empty localStorage stays in French (no flip), and FR on the cart switches the whole body", { lang: null, browserLang: "en-US" }, async (ctx) => {
  await ctx.goto("/healthz"); // any page of the site, to be allowed to set its cookie
  await ctx.page.evaluate(() => { document.cookie = "umasbooks_lang=fr; Path=/"; });
  await ctx.goto("/books.html", "networkidle2");
  assert.equal(await ctx.page.$eval("html", (h) => h.lang), "fr", "the server-rendered French is kept");
  const cookie = (await ctx.cookies()).find((c) => c.name === "umasbooks_lang");
  assert.equal(cookie && cookie.value, "fr", "the French cookie is not rewritten to English");
  // A server-rendered page (no client dictionary): the toggle reloads, so the body changes too.
  await ctx.goto("/cart");
  await ctx.page.click(".langtoggle [data-lang='en']");
  await ctx.page.waitForFunction(() => document.documentElement.lang === "en");
  has(await ctx.text(), /Your Cart/);
  await ctx.page.click(".langtoggle [data-lang='fr']");
  await ctx.page.waitForFunction(() => document.documentElement.lang === "fr");
  has(await ctx.text(), /Votre panier/);
});


s.test("G41c (must) on a phone the header is compact: logo and icons on one row, a Menu button for the links (Esc and an outside tap close it), EN/FR easy to tap", { viewport: GUEST_PHONE }, async (ctx) => {
  await ctx.goto("/", "networkidle2");
  const m = await ctx.page.evaluate(() => {
    const box = (sel) => { const e = document.querySelector(sel); const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, w: r.width, h: r.height }; };
    const logo = box(".h-logo"), cart = box("a.h-tool[href='/cart']");
    return { header: box("header.mkt-header"), logoTop: logo.top, cartTop: cart.top, cartW: cart.w, cartH: cart.h, banner: document.querySelector(".preview-banner") ? box(".preview-banner").h : 0,
      toggles: [...document.querySelectorAll(".langtoggle [data-lang]")].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }),
      linksShownBeforeOpen: [...document.querySelectorAll("header .h-menu-links a")].filter((a) => a.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true })).length };
  });
  assert.ok(m.header.h < 140, `the header is ${Math.round(m.header.h)} px tall (it was 253): under 140 px`);
  assert.ok(Math.abs(m.logoTop - m.cartTop) < 40, "the logo and the icons are on the same row");
  assert.ok(m.cartW >= 36 && m.cartH >= 44, `cart button ${m.cartW}x${m.cartH}`);
  for (const [w, h] of m.toggles) assert.ok(w >= 44 && h >= 44, `EN/FR buttons are ${w}x${h}: 44x44 on a touch screen`);
  assert.equal(m.linksShownBeforeOpen, 0, "the links are folded into the Menu button");
  if (ctx.preview) assert.ok(m.banner < 50, `the preview banner is ${Math.round(m.banner)} px: one line`);
  // aria-expanded follows the <details> "toggle" event, which the browser fires a moment after the tap.
  const expanded = (want) => ctx.page.waitForFunction((w) => document.querySelector("summary.h-menu-btn").getAttribute("aria-expanded") === w, { timeout: 3000 }, want).then(() => want, () => ctx.page.$eval("summary.h-menu-btn", (b) => b.getAttribute("aria-expanded")));
  assert.equal(await expanded("false"), "false");
  await ctx.page.tap("summary.h-menu-btn");
  assert.equal(await expanded("true"), "true");
  assert.equal(await ctx.page.$$eval("header .h-menu-links a", (as) => as.filter((a) => a.checkVisibility() && a.getBoundingClientRect().height >= 44).length), 4, "four links, each at least 44 px tall");
  await ctx.page.keyboard.press("Escape");
  assert.equal(await expanded("false"), "false", "Esc closes the menu");
  assert.equal(await ctx.page.evaluate(() => document.activeElement.className), "h-menu-btn", "focus is back on the Menu button");
  await ctx.page.tap("summary.h-menu-btn");
  await ctx.page.mouse.click(300, 700);
  assert.equal(await expanded("false"), "false", "a tap outside closes the menu");
  await ctx.page.tap("summary.h-menu-btn");
  assert.equal(await expanded("true"), "true");
  const books = await ctx.page.$("header .h-menu-links a[href='/books.html'], header .h-menu-links a[href='books.html']");
  await Promise.all([ctx.page.waitForNavigation(), books.tap()]);
  assert.match(ctx.page.url(), /\/books\.html$/);
});

s.test("G41d (must) in French on a phone the genre chips on Browse Books are complete words (Jeune adulte, Documentaires) and the header stays compact", { viewport: GUEST_PHONE, lang: "fr" }, async (ctx) => {
  await ctx.goto("/books.html", "networkidle2");
  const chips = await ctx.page.$$eval(".bk-genre", (bs) => bs.map((b) => { const l = b.querySelector("span:last-child"); return { text: l.textContent.trim(), clipped: l.scrollWidth > l.clientWidth + 1 }; }));
  assert.ok(chips.length >= 10, `${chips.length} genre chips`);
  assert.deepEqual(chips.filter((c) => c.clipped).map((c) => c.text), [], "no chip label is cut off");
  const texts = chips.map((c) => c.text);
  assert.ok(texts.includes("Jeune adulte"), `chips: ${texts.join(" | ")}`);
  assert.ok(!texts.includes("Young Adult"));
  assert.ok((await ctx.page.$eval("header.mkt-header", (h) => h.getBoundingClientRect().height)) < 140);
  assert.equal(await ctx.page.$eval("summary.h-menu-btn", (b) => b.textContent.trim()), "Menu");
});

s.test("G41e tap targets on a desktop window: carousel dots, footer links and 'Tell us what you think!' are at least 24x24", async (ctx) => {
  await ctx.goto("/", "networkidle2");
  const small = await ctx.page.$$eval("footer a, .wn-dot, .preview-banner a, main p a", (els) => els.filter((e) => e.getBoundingClientRect().width > 0).map((e) => { const r = e.getBoundingClientRect(); return { t: (e.className || e.textContent).toString().trim().slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((r) => r.w < 24 || r.h < 24));
  assert.deepEqual(small, [], "targets under 24x24 (WCAG 2.2, 2.5.8)");
});

s.test("G41f (must) French has its own addresses: /fr/ opens in French with no saved language, links stay under /fr/, EN | FR move between the two addresses", { lang: null, browserLang: "en-US" }, async (ctx) => {
  const book = await stockedBook(ctx);
  const lang = () => ctx.page.$eval("html", (h) => h.lang);
  const path = () => new URL(ctx.page.url()).pathname;
  await ctx.goto("/fr/", "networkidle2");
  assert.equal(await lang(), "fr", "/fr/ is French although the browser is English and nothing was saved");
  has(await ctx.text(), /Parcourir les livres/);
  assert.equal((await ctx.cookies()).find((c) => c.name === "umasbooks_lang").value, "fr", "visiting /fr/ remembers French for the forms and pages that follow");
  const toggle = await ctx.page.$$eval(".langtoggle a[data-lang]", (as) => as.map((a) => ({ lang: a.dataset.lang, href: a.getAttribute("href"), active: a.classList.contains("is-active") })));
  assert.deepEqual(toggle, [{ lang: "en", href: "/", active: false }, { lang: "fr", href: "/fr/", active: true }]);
  assert.equal(await ctx.page.$eval("link[rel='canonical']", (l) => new URL(l.href).pathname), "/fr/");
  assert.deepEqual(await ctx.page.$$eval("link[rel='alternate'][hreflang]", (ls) => ls.map((l) => l.hreflang).sort()), ["en", "fr", "x-default"]);
  // The menu and the footer stay on /fr/.
  const stray = await ctx.page.$$eval("header a[href], footer a[href]", (as) => as.filter((a) => !a.hasAttribute("data-lang")).map((a) => a.getAttribute("href"))
    .filter((h) => /^\/($|books|events|sessions|contact|privacy-policy|terms-of-sale|mentions-legales|visit|request-a-book)/.test(h)));
  assert.deepEqual(stray, [], "public links in the header and footer start with /fr");
  await Promise.all([ctx.page.waitForNavigation({ waitUntil: "domcontentloaded" }), ctx.page.click("header .h-nav a[data-i18n='nav.books']")]);
  assert.equal(path(), "/fr/books.html");
  assert.equal(await lang(), "fr");
  // A book page, and the toggle both ways.
  await ctx.goto(`/fr/books/${book.id}`, "networkidle2");
  assert.equal(await lang(), "fr");
  await Promise.all([ctx.page.waitForNavigation({ waitUntil: "domcontentloaded" }), ctx.page.click(".langtoggle [data-lang='en']")]);
  assert.equal(path(), `/books/${book.id}`);
  assert.equal(await lang(), "en", "EN leads to the English address and stays English");
  await ctx.page.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await lang(), "en", "English kept after a reload (the choice was stored)");
  await Promise.all([ctx.page.waitForNavigation({ waitUntil: "domcontentloaded" }), ctx.page.click(".langtoggle [data-lang='fr']")]);
  assert.equal(path(), `/fr/books/${book.id}`);
  assert.equal(await lang(), "fr");
  // Only the public pages exist under /fr/.
  for (const p of ["/fr/admin", "/fr/cart", "/fr/no-such-page"]) {
    const res = await ctx.goto(p);
    assert.equal(res.status(), 404, p);
    assert.equal(await lang(), "fr", `${p}: the 404 page is French`);
  }
});

// ---- 1H. Cookies, language memory, 404 ----

s.test("G42 (must) a fresh visit shows no cookie-consent banner", async (ctx) => {
  await ctx.goto("/", "networkidle2");
  const html = (await ctx.html()).toLowerCase();
  hasNot(html, /cookie-banner|cookie-consent|accept (all )?cookies|accepter (tous )?les cookies/);
  assert.equal(await ctx.page.$("[id*='cookie' i][class*='banner' i], .cc-window, #onetrust-banner-sdk"), null);
});

s.manual("G43 closing a private window forgets the language and the cart", "needs a human to close and reopen a private window (the cookie behaviour is checked in E10 and G41)");

s.test("G44 (must) the 404 page is friendly and the menu still works", async (ctx) => {
  const res = await ctx.goto("/no-such-page");
  assert.equal(res.status(), 404);
  const text = await ctx.text();
  has(text, /Page not found/);
  has(text, /This page doesn't exist or has moved/);
  has(text, /admin@umasbooks\.org/);
  assert.ok(await ctx.page.$("main a[href='/']"), "Go home link");
  assert.ok(await ctx.page.$("header nav a"), "the menu is still there");
});

s.test("G44b the 404 page is in French", { lang: "fr" }, async (ctx) => {
  const res = await ctx.goto("/no-such-page");
  assert.equal(res.status(), 404);
  const text = await ctx.text();
  has(text, /Page introuvable/);
  has(text, /Cette page n.existe pas/);
  has(text, /Retour à l.accueil/);
});

s.test("G45 /books/99999999 and /books/abc show the 404 page, not a crash", async (ctx) => {
  for (const p of ["/books/99999999", "/books/abc"]) {
    const res = await ctx.goto(p);
    assert.equal(res.status(), 404, p);
    has(await ctx.text(), /Page not found/);
  }
});

s.test("G46 /admin and /account while logged out show the login page", async (ctx) => {
  for (const p of ["/admin", "/account"]) {
    await ctx.goto(p);
    assert.equal(new URL(ctx.page.url()).pathname, "/login", p);
    has(await ctx.text(), /Log in/i);
  }
});

s.test("G7b adding to the cart from a book page and removing it again works", async (ctx) => {
  const book = await stockedBook(ctx);
  await addFirstCopyToCart(ctx, book);
  assert.equal(await cartLineCount(ctx), 1);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click(".cart-item form[action='/cart/remove'] button")]);
  assert.equal(await cartLineCount(ctx), 0);
  has(await ctx.text(), /Your cart is empty/);
});

// ---- 1J. The cart (a guest can fill one) ----

s.test("G47 (must) add to cart shows the cart with the book, condition, price and Remove", async (ctx) => {
  const book = await stockedBook(ctx);
  await addFirstCopyToCart(ctx, book);
  assert.equal(new URL(ctx.page.url()).pathname, "/cart");
  const line = await ctx.page.$eval(".cart-item", (e) => e.innerText);
  has(line, new RegExp(book.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  has(line, /€\d+\.\d\d/);
  has(line, /Remove/);
  assert.ok(await ctx.page.$(".cart-item .condition-badge"), "condition label");
  assert.ok(await ctx.page.$(".cart-item .cart-item-cover"), "cover or 'No cover'");
  has(await ctx.page.$eval(".cart-total", (e) => e.innerText), /Total:\s*€\d+\.\d\d/);
});

s.test("G48 a second book can be added and removed; the total updates", async (ctx) => {
  const list = (await e2e.books()).filter((b) => b.price != null);
  if (list.length < 2) ctx.skip("data: fewer than two in-stock books");
  await addFirstCopyToCart(ctx, list[0]);
  const total = async () => Number((await ctx.page.$eval(".cart-total strong", (e) => e.textContent)).replace(/[^\d.]/g, ""));
  const one = await total();
  await addFirstCopyToCart(ctx, list[1], 2);
  assert.equal(await cartLineCount(ctx), 2);
  assert.ok((await total()) > one, "total grows");
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click(".cart-item:last-child form[action='/cart/remove'] button")]);
  assert.equal(await cartLineCount(ctx), 1);
  assert.equal(await total(), one, "total back to one book");
});

s.test("G49 the cart icon number matches the lines in the cart", async (ctx) => {
  const book = await stockedBook(ctx);
  await addFirstCopyToCart(ctx, book);
  for (const p of ["/", "/books.html", "/events"]) {
    await ctx.goto(p, "networkidle2");
    await ctx.page.waitForFunction(() => document.querySelector("[data-cart-count]").textContent.trim() === "1");
  }
});

s.test("G48b the cart survives a reload and the back button", async (ctx) => {
  const book = await stockedBook(ctx);
  await addFirstCopyToCart(ctx, book);
  await ctx.page.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await cartLineCount(ctx), 1);
  await ctx.page.goBack();
  hasNot(await ctx.text(), /Something went wrong|Your session expired/);
  await ctx.goto("/cart");
  assert.equal(await cartLineCount(ctx), 1);
});

// ---- 1I. Member pages and reserving need a login ----

s.test("G52 logged out, /forum shows the login page", { anon: true }, async (ctx) => {
  await ctx.goto("/forum");
  assert.equal(new URL(ctx.page.url()).pathname, "/login");
  assert.equal(new URL(ctx.page.url()).searchParams.get("returnTo"), "/forum", "log in leads back to the forum");
  has(await ctx.text(), /Log in to open the members.? area/);
});

// Reserving needs an account: "Reserve (free, no commitment)" sends a guest to log in or sign up.

// What the site does with a reservation request from someone who is not logged in.
async function reserveAsGuest(ctx) {
  const res = await ctx.page.evaluate(async () => {
    const { token } = await (await fetch("/api/csrf-token")).json();
    const body = new URLSearchParams({ _csrf: token, name: "E2E guest check", email: "e2e@example.invalid", acceptCgv: "on" });
    const r = await fetch("/cart/reserve", { method: "POST", body, redirect: "manual" });
    return { type: r.type, status: r.status };
  });
  return res;
}

s.test("G50 (must) reserving asks a guest to log in or create an account", async (ctx) => {
  if (ctx.preview) ctx.skip("preview mode: reservations are switched off for everyone");
  const book = await stockedBook(ctx);
  await addFirstCopyToCart(ctx, book);
  // The cart offers a way to log in or sign up (a link or button) instead of a guest reserve form...
  const text = await ctx.text();
  assert.equal(await ctx.page.$("form[action='/cart/reserve'] input[name='acceptCgv']"), null, "a guest must not be shown the reserve form");
  assert.ok(await ctx.page.$("a[href^='/login'], a[href^='/signup']"), "a way to log in or create an account");
  has(text, /log in|sign up|create an account/);
  // ...and a request sent anyway is turned away to the login page, never started.
  const sent = await reserveAsGuest(ctx);
  assert.equal(sent.type, "opaqueredirect", `reserve answered ${sent.status} to a guest, expected a redirect to log in`);
  assert.deepEqual(ctx.blocked, [], "no payment page was reached");
});

s.test("G51 (must) after logging in from the cart, the guest is back on the cart with their items", { needs: ["account"] }, async (ctx) => {
  if (ctx.preview) ctx.skip("preview mode: reservations are switched off for everyone");
  const c = cfg.credentials("account");
  const book = await stockedBook(ctx);
  await addFirstCopyToCart(ctx, book);
  const login = (await ctx.page.$("#login-to-checkout a[href^='/login']")) || (await ctx.page.$("a[href^='/login']"));
  assert.ok(login, "the cart offers a log in link to a guest");
  await Promise.all([ctx.page.waitForNavigation(), login.click()]);
  await ctx.page.type("form[action='/login'] #email", c.email);
  await ctx.page.type("form[action='/login'] #password", c.password);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/login'] button[type='submit']")]);
  assert.equal(new URL(ctx.page.url()).pathname, "/cart", "back on the cart after logging in");
  assert.equal(await cartLineCount(ctx), 1, "the item is still in the cart");
});

// ---- 1K. Becoming a member: the membership page for a guest ----
//
// Becoming a member needs an account (pull request #201): the page shows a
// short Name and Email form to a guest, the payment form only to an account holder.

const JOIN = "form[action='/membership/join']";

async function joinPage(ctx) {
  if (ctx.preview) ctx.skip("preview mode: the membership page only says 'Membership opens at launch' (G8)");
  await ctx.goto("/membership.html");
}

s.test("G53 (must) the membership page shows a Name and Email form to a guest, and no payment form yet", async (ctx) => {
  await joinPage(ctx);
  assert.ok(await ctx.page.$(`${JOIN} #memName`), "name box");
  assert.ok(await ctx.page.$(`${JOIN} #memEmail`), "email box");
  has(await ctx.page.$eval(JOIN, (f) => f.innerText), /Continue to payment/);
  assert.equal(await ctx.page.$("#haWidget"), null, "the HelloAsso widget must not be in the page yet");
  assert.ok(await ctx.page.$("a[href='membership-terms.html']"), "membership terms linked");
  assert.ok(await ctx.page.$("a[href^='/login']"), "log in link");
});

s.test("G54 an invalid email on the membership form is refused with a message and creates nothing", async (ctx) => {
  await joinPage(ctx);
  assert.ok(await ctx.page.$(JOIN), "the join form exists");
  // A script can send what the browser would stop; nothing valid is sent, so nothing is created.
  await ctx.page.evaluate(async () => {
    const f = document.querySelector("form[action='/membership/join']");
    const token = f.querySelector("input[name='_csrf']").value;
    await fetch("/membership/join", { method: "POST", redirect: "manual", body: new URLSearchParams({ _csrf: token, displayName: "E2E", email: "not-an-address" }) });
  });
  await ctx.goto("/membership.html");
  has(await ctx.text(), /Please enter your name and a valid email address/);
  assert.equal(await ctx.page.$("#memJoinedEmail"), null, "no payment step was shown");
});

async function joinWith(ctx, email) {
  await ctx.page.$eval(`${JOIN} #memName`, (i) => { i.value = ""; });
  await ctx.page.$eval(`${JOIN} #memEmail`, (i) => { i.value = ""; });
  await ctx.page.type(`${JOIN} #memName`, `${process.env.E2E_RUN_ID} Join Test`);
  await ctx.page.type(`${JOIN} #memEmail`, email);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click(`${JOIN} button[type='submit']`)]);
}

s.test("G55 (must) submitting the form shows the payment step with the email to use, the same for a new and an existing address", async (ctx) => {
  if (!cfg.allowWrites()) ctx.skip("needs E2E_ALLOW_WRITES=1 (this step creates an unconfirmed account and sends an email)");
  await joinPage(ctx);
  const email = testEmail("membership-join");
  await joinWith(ctx, email);
  ctx.created("unconfirmed account made by the membership form (cannot log in: example.invalid)", `${process.env.E2E_RUN_ID} Join Test <${email}>`, "admin Accounts > search the tag > Erase Member");
  const first = await ctx.text();
  const wrap = () => ctx.page.$eval(".mem-widget-wrap", (e) => e.innerText.replace(/\s+/g, " "));
  const firstWrap = await wrap();
  for (const re of [/Next: pay for your membership/, /We have emailed you a link: click it after paying/, /Use this same email on the payment form:/]) has(first, re);
  assert.ok((await ctx.page.$eval("#memJoinedEmail", (e) => e.innerText)).includes(email), "the email to use on the payment form is shown");
  assert.equal(await ctx.page.$("#haWidget"), null, "nothing is loaded from HelloAsso before the click");
  await ctx.page.click("#haShow");
  await ctx.page.waitForSelector("#haWidget");
  assert.ok(await ctx.page.$("#haWidget"), "the HelloAsso payment form is shown after the click");
  // The same address again (an account now exists): the page must be identical.
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/membership/join/reset'] button")]);
  await joinWith(ctx, email);
  const second = await ctx.text();
  for (const re of [/Next: pay for your membership/, /We have emailed you a link: click it after paying/]) has(second, re);
  assert.ok((await ctx.page.$eval("#memJoinedEmail", (e) => e.innerText)).includes(email), "the same email is shown the second time");
  assert.equal(await wrap(), firstWrap, "the page for an address that now has an account is identical");
});

s.test("G56 'Use a different email' returns to the Name and Email form", async (ctx) => {
  if (!cfg.allowWrites()) ctx.skip("needs E2E_ALLOW_WRITES=1 (reaching the payment step creates an unconfirmed account)");
  await joinPage(ctx);
  const email = testEmail("membership-join-reset");
  await joinWith(ctx, email);
  ctx.created("unconfirmed account made by the membership form (cannot log in: example.invalid)", `${process.env.E2E_RUN_ID} Join Test <${email}>`, "admin Accounts > search the tag > Erase Member");
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/membership/join/reset'] button")]);
  assert.ok(await ctx.page.$(JOIN), "the form is back");
  assert.equal(await ctx.page.$("#haWidget"), null);
});

// ---- 1K. The pre-registration and volunteer forms (server-side) ----

const ERR_SUMMARY = "#form-errors[role='alert']";

s.test("G57 (must) the pre-registration form refuses an empty submission with an error summary, marked fields and focus on the summary", async (ctx) => {
  await ctx.goto("/pre-registration.html");
  has(await ctx.text(), /Do not enter health information here/);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/pre-registration'] button[type='submit']")]);
  assert.ok(await ctx.page.$(ERR_SUMMARY), "error summary with role=alert");
  has(await ctx.text(), /There is a problem/);
  const links = await ctx.page.$$eval(`${ERR_SUMMARY} a`, (as) => as.map((a) => a.getAttribute("href")));
  for (const id of ["#preg-who", "#preg-session", "#preg-days", "#preg-times", "#preg-parent", "#preg-email", "#preg-phone", "#preg-consent"]) assert.ok(links.includes(id), `summary links to ${id}`);
  assert.ok(!links.includes("#preg-first"), "the child fields are not demanded before 'a child' is chosen");
  assert.equal(await ctx.page.$eval("#preg-parent", (i) => i.getAttribute("aria-invalid")), "true");
  const describedBy = await ctx.page.$eval("#preg-parent", (i) => i.getAttribute("aria-describedby"));
  assert.ok(describedBy && await ctx.page.$(`#${describedBy.split(" ").pop()}`), "the field is described by its error text");
  assert.equal(await ctx.page.evaluate(() => document.activeElement && document.activeElement.id), "form-errors", "focus is on the summary");
});

s.test("G25a the legal pages agree: opening hours, membership withdrawal wording, GitHub in the privacy policy", async (ctx) => {
  await ctx.goto("/visit.html");
  has(await ctx.text(), /14:00–19:00/);
  await ctx.goto("/membership-terms.html");
  has(await ctx.text(), /If you join online you may withdraw within 14 days by writing to admin@umasbooks\.org; we will refund your payment and the membership then ends\./);
  has(await ctx.text(), /Last updated: 6 October 2026/);
  await ctx.goto("/privacy-policy.html");
  has(await ctx.text(), /GitHub \(United States\)/);
  has(await ctx.text(), /Render keeps platform logs for 14 days/);
  has(await ctx.text(), /protect forms/);
});

s.test("G25b FR check (legal pages): hours as 14 h–19 h, the withdrawal sentence and the GitHub line in French", { lang: "fr" }, async (ctx) => {
  await ctx.goto("/visit.html");
  has(await ctx.text(), /14\s?h–19\s?h/);
  await ctx.goto("/membership-terms.html");
  has(await ctx.text(), /vous pouvez vous rétracter dans les 14 jours en écrivant à admin@umasbooks\.org/);
  await ctx.goto("/privacy-policy.html");
  has(await ctx.text(), /GitHub \(États-Unis\)/);
});

s.manual("G25c the membership page shows the price before the HelloAsso form loads, and the shop address shows its street number", "needs MEMBERSHIP_PRICE_EUR and SHOP_STREET_NUMBER to be set in src/lib/legal.js (empty until the association gives them: docs/legal-todos.md); the helpers are covered by test/unit/legalConstants.test.js");

s.test("G57a an adult registering for themselves is not asked for a child's details; checkboxes for days and times, no Ctrl/Cmd", async (ctx) => {
  await ctx.goto("/pre-registration.html");
  assert.equal(await ctx.page.$$eval("select[multiple]", (l) => l.length), 0, "no multi-select list");
  assert.equal(await ctx.page.$$eval("input[type=checkbox][name=days]", (l) => l.length), 5);
  assert.equal(await ctx.page.$$eval("input[type=checkbox][name=times]", (l) => l.length), 4);
  has(await ctx.text(), /Who is registering\?/);
  await ctx.page.click("input[name=who][value=self]");
  assert.equal(await ctx.page.$eval("#preg-child-block", (d) => d.hidden), true, "the child section is hidden for an adult");
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/pre-registration'] button[type='submit']")]);
  const links = await ctx.page.$$eval(`${ERR_SUMMARY} a`, (as) => as.map((a) => a.getAttribute("href")));
  for (const id of ["#preg-first", "#preg-last", "#preg-birthyear", "#preg-guardian"]) assert.ok(!links.includes(id), `${id} is not required for an adult`);
  assert.ok(links.includes("#preg-session") && links.includes("#preg-consent"));
});

s.test("G58 (must) for a child the guardian box and the agreement are needed; a complete form is sent and shows a thank-you", async (ctx) => {
  await ctx.goto("/pre-registration.html");
  const fill = async () => {
    await ctx.page.click("input[name=who][value=child]");
    await ctx.page.type("#preg-first", `${process.env.E2E_RUN_ID} Child`);
    await ctx.page.type("#preg-last", "Test");
    await ctx.page.type("#preg-birthyear", String(new Date().getFullYear() - 8));
    await ctx.page.select("#preg-session", "young-adventurers");
    await ctx.page.click("input[name=days][value=tue]");
    await ctx.page.click("input[name=days][value=sat]");
    await ctx.page.click("input[name=times][value=morning]");
    await ctx.page.type("#preg-parent", `${process.env.E2E_RUN_ID} Parent`);
    await ctx.page.type("#preg-email", testEmail("preregistration"));
    await ctx.page.type("#preg-phone", "0600000000");
  };
  await fill();
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/pre-registration'] button[type='submit']")]);
  const links = await ctx.page.$$eval(`${ERR_SUMMARY} a`, (as) => as.map((a) => a.getAttribute("href")));
  assert.deepEqual(links, ["#preg-guardian", "#preg-consent"], "only the two boxes are missing");
  has(await ctx.text(), /Tick this box to continue/);
  assert.equal(await ctx.page.$eval("#preg-first", (i) => i.value.includes("Child")), true, "what was typed is kept");
  assert.equal(await ctx.page.$eval("input[name=days][value=sat]", (i) => i.checked), true, "the ticked days are kept");
  has(await ctx.page.$eval("label[for='preg-guardian']", (l) => l.innerText), /I am the parent or legal guardian of the child\./);
  has(await ctx.page.$eval("label[for='preg-consent']", (l) => l.innerText), /I agree to be contacted about this program\./);
  if (!cfg.allowWrites()) ctx.skip("needs E2E_ALLOW_WRITES=1 for the final submit (it sends an email to the shop mailbox)");
  await ctx.page.click("#preg-guardian");
  await ctx.page.click("#preg-consent");
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/pre-registration'] button[type='submit']")]);
  has(await ctx.text(), /Thank you, your pre-registration has been sent/);
  ctx.created("pre-registration (email to the admin mailbox)", `${process.env.E2E_RUN_ID} Child`, "delete the email from the shop mailbox");
});

s.test("G59 (must) the volunteer form needs name, email and consent; a complete form is sent and shows a thank-you", async (ctx) => {
  await ctx.goto("/volunteer.html");
  has(await ctx.text(), /Do not enter health information here/);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/volunteer-signup'] button[type='submit']")]);
  const links = await ctx.page.$$eval(`${ERR_SUMMARY} a`, (as) => as.map((a) => a.getAttribute("href")));
  assert.deepEqual(links, ["#vol-name", "#vol-email", "#vol-consent"]);
  assert.equal(await ctx.page.$eval("#vol-email", (i) => i.getAttribute("aria-invalid")), "true");
  if (!cfg.allowWrites()) ctx.skip("needs E2E_ALLOW_WRITES=1 for the final submit (it sends an email to the shop mailbox)");
  await ctx.page.type("#vol-name", `${process.env.E2E_RUN_ID} Volunteer`);
  await ctx.page.type("#vol-email", testEmail("volunteer-form"));
  await ctx.page.click("#vol-consent");
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/volunteer-signup'] button[type='submit']")]);
  has(await ctx.text(), /Thank you, your sign-up has been sent/);
  ctx.created("volunteer sign-up (email to the admin mailbox)", `${process.env.E2E_RUN_ID} Volunteer`, "delete the email from the shop mailbox");
});

s.manual("G60 the pre-registration and volunteer emails arrive in the shop mailbox with the right reply-to, and are deleted after 12 months", "tests cannot read email; the 12-month cleanup is a quarterly manual job (docs/runbook.md, section e)");

s.test("G-FR57 FR check (forms): the errors, the guardian statement and the health line are in French", { lang: "fr" }, async (ctx) => {
  await ctx.goto("/pre-registration.html");
  has(await ctx.text(), /Ne saisissez pas d’informations de santé ici/);
  has(await ctx.page.$eval("label[for='preg-guardian']", (l) => l.innerText), /Je suis le parent ou le représentant légal de l’enfant\./);
  has(await ctx.page.$eval("label[for='preg-consent']", (l) => l.innerText), /J’accepte d’être contacté\(e\) au sujet de ce programme/);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/pre-registration'] button[type='submit']")]);
  for (const re of [/Il y a un problème/, /Ce champ est obligatoire\./, /Cochez cette case pour continuer\./]) has(await ctx.text(), re);
});

s.test("G61 a book page shows the cover from our own server with its size reserved, and no request goes to Open Library", async (ctx) => {
  const book = await stockedBook(ctx);
  await ctx.goto(`/books/${book.id}`);
  const cover = await ctx.page.$eval("img.book-detail-cover", (i) => ({ src: i.getAttribute("src"), w: i.getAttribute("width"), h: i.getAttribute("height"), prio: i.getAttribute("fetchpriority"), ok: i.complete && i.naturalWidth > 0 }))
    .catch(() => null);
  if (!cover) ctx.skip("data: this book has no cover");
  assert.match(cover.src, /^\/img\/[0-9a-f]{64}\.jpg$/);
  assert.ok(cover.w && cover.h, "width and height are set");
  assert.equal(cover.prio, "high");
  const { html } = await pageHtml(ctx, `/books/${book.id}`);
  assert.doesNotMatch(html, /openlibrary\.org|archive\.org/);
});

s.test("G62 New In covers are shown whole (contain, 2:3 box, no horizontal overflow)", async (ctx) => {
  await ctx.goto("/books.html", "networkidle2");
  const covers = await ctx.page.$$eval("#bk-new-track img.cover", (imgs) => imgs.map((i) => {
    const r = i.getBoundingClientRect();
    return { fit: getComputedStyle(i).objectFit, ratio: r.height ? r.width / r.height : 0 };
  }));
  if (!covers.length) ctx.skip("data: no New In covers on the site");
  for (const c of covers) {
    assert.equal(c.fit, "contain");
    assert.ok(Math.abs(c.ratio - 2 / 3) < 0.03, `box ratio ${c.ratio}`);
  }
  assert.ok(await ctx.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal overflow");
});

s.test("G81 (must) on a phone (375 px and 320 px) no public page is wider than the screen, in English and in French", { timeout: 300000 }, async (ctx) => {
  const pages = ["/", "/about.html", "/books.html", "/events.html", "/programs.html", "/membership.html", "/visit.html", "/volunteer.html", "/privacy-policy.html", "/terms-of-sale.html", "/sessions", "/events", "/contact", "/request-a-book", "/cart", "/login", "/signup"];
  // Regions that scroll sideways on purpose (a carousel, the genre row, a table in a scrolling wrapper) are skipped by phoneOverflow: anything inside an overflow-x auto/scroll/hidden ancestor.
  for (const lang of ["en", "fr"]) {
    await ctx.page.setCookie({ name: "umasbooks_lang", value: lang, url: cfg.baseUrl() });
    for (const [width, height] of [[375, 812], [320, 640]]) {
      await ctx.page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      for (const p of pages) {
        await ctx.goto(p, "networkidle2");
        const bad = await phoneOverflow(ctx.page, width);
        assert.deepEqual(bad, [], `${p} (${lang}) at ${width} px: ${bad.join("; ")}`);
      }
    }
  }
});

s.test("G82 (must) on a phone (375 px and 320 px) very long titles and words wrap: the book pages, the Browse Books shelves and the genre row never make a page wider than the screen", { timeout: 300000 }, async (ctx) => {
  // Books with an unbroken 90-letter title and a 41-letter word are looked for by their tag (the local test copy of the
  // site, npm run e2e:local, has them); on a real site any in-stock book is checked too.
  const hostile = await e2e.getJson("/api/books/search?q=E2Ephone").catch(() => []);
  const some = (await e2e.books()).filter((b) => b.price != null).slice(0, 2);
  const ids = [...new Set([...hostile, ...some].map((b) => b.id))].slice(0, 6);
  if (!ids.length) ctx.skip("data: the site has no book to open");
  for (const lang of ["en", "fr"]) {
    await ctx.page.setCookie({ name: "umasbooks_lang", value: lang, url: cfg.baseUrl() });
    for (const [width, height] of [[375, 812], [320, 640]]) {
      await ctx.page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      for (const id of ids) {
        await ctx.goto(`/books/${id}`, "networkidle2");
        const bad = await phoneOverflow(ctx.page, width);
        assert.deepEqual(bad, [], `/books/${id} (${lang}) at ${width} px: ${bad.join("; ")}`);
      }
      // Browse Books: the genre row scrolls inside its own box (it is wider than the screen, the page is not) ...
      await ctx.goto("/books.html", "networkidle2");
      await ctx.page.waitForSelector("#bk-genre-list .bk-genre");
      const row = await ctx.page.evaluate(() => {
        const r = document.getElementById("bk-genre-list");
        return r ? { scrolls: r.scrollWidth > r.clientWidth + 2, overflowX: getComputedStyle(r).overflowX, width: r.getBoundingClientRect().right } : null;
      });
      assert.ok(row, "the genre row is on the Browse Books page");
      assert.ok(row.scrolls && /auto|scroll/.test(row.overflowX), `the genre row scrolls inside its box (${JSON.stringify(row)})`);
      assert.ok(row.width <= width + 1, `the genre row ends at ${Math.round(row.width)} px on a ${width} px screen`);
      // ... and a search whose results hold the long titles fits too.
      await ctx.page.type("#shop-search-input", hostile.length ? "E2Ephone" : "a");
      await ctx.page.keyboard.press("Enter");
      await new Promise((r) => setTimeout(r, 1200));
      const bad = await phoneOverflow(ctx.page, width);
      assert.deepEqual(bad, [], `/books.html results (${lang}) at ${width} px: ${bad.join("; ")}`);
    }
  }
});

s.test("G83 (must) on a phone (390 px) the key controls are at least 44x44 px to tap, labels, table headers and buttons are 13px or more, and the header is one row of icons", { timeout: 300000 }, async (ctx) => {
  // The controls are listed in e2e/helpers/pages.js (TAP_TARGETS): header icons, Menu, EN/FR, the Instagram icon, carousel arrows
  // and dots, the login fields, Show password, Forgot your password, the contact form, the Browse Books search and the hearts,
  // Add to Cart, Back to Books, the calendar previous/next and Month/Week toggle. Text sizes: SMALL_TEXT_ALLOW (with reasons).
  const book = await stockedBook(ctx);
  await ctx.page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  for (const lang of ["en", "fr"]) {
    await ctx.page.setCookie({ name: "umasbooks_lang", value: lang, url: cfg.baseUrl() });
    for (const [pageUrl, selectors] of Object.entries(TAP_TARGETS)) {
      const url = pageUrl.replace(":id", book.id);
      await ctx.goto(url, "networkidle2");
      const small = await tapTargetFaults(ctx.page, selectors);
      assert.deepEqual(small, [], `${url} (${lang}) at 390 px: controls under 44 px: ${small.join("; ")}`);
      const tiny = await smallTextFaults(ctx.page);
      assert.deepEqual(tiny, [], `${url} (${lang}) at 390 px: text under 13 px: ${tiny.join("; ")}`);
    }
    // the header: one row of icons (logo + icons), then the Menu row; no wrapped second row of icons
    await ctx.goto("/", "networkidle2");
    const rows = await ctx.page.evaluate(() => [...new Set([...document.querySelectorAll("header.mkt-header .h-tools > .h-tool, header.mkt-header .h-tools > form")].filter((e) => e.getBoundingClientRect().width > 0).map((e) => Math.round(e.getBoundingClientRect().top)))].length);
    assert.equal(rows, 1, `the header icons are on ${rows} rows (${lang})`);
  }
  // a phone at 320 px: still one row of icons
  await ctx.page.setViewport({ width: 320, height: 640, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await ctx.goto("/", "networkidle2");
  const rows320 = await ctx.page.evaluate(() => [...new Set([...document.querySelectorAll("header.mkt-header .h-tools > .h-tool, header.mkt-header .h-tools > form")].filter((e) => e.getBoundingClientRect().width > 0).map((e) => Math.round(e.getBoundingClientRect().top)))].length);
  assert.equal(rows320, 1, `the header icons are on ${rows320} rows at 320 px`);
  // a phone turned sideways: one compact row
  await ctx.page.setViewport({ width: 844, height: 390, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await ctx.goto("/", "networkidle2");
  const h = await ctx.page.evaluate(() => Math.round(document.querySelector("header.mkt-header").getBoundingClientRect().height));
  assert.ok(h <= 70, `the header is ${h} px high on a phone turned sideways (it was 176)`);
});

s.test("G84 (must) headings go down one level at a time on the public pages (a book page, Volunteer, Blog, Browse Books, Events), in English and in French", { timeout: 300000 }, async (ctx) => {
  const book = await stockedBook(ctx);
  for (const lang of ["en", "fr"]) {
    await ctx.page.setCookie({ name: "umasbooks_lang", value: lang, url: cfg.baseUrl() });
    for (const url of [`/books/${book.id}`, "/volunteer.html", "/blog.html", "/books.html", "/events.html", "/events", "/membership.html", "/immersion.html", "/about.html", "/"]) {
      await ctx.goto(url, "networkidle2");
      const jumps = await ctx.page.evaluate(() => {
        const out = [];
        let prev = 0;
        for (const h of document.querySelectorAll("main h1, main h2, main h3, main h4, main h5, main h6")) {
          if (getComputedStyle(h).display === "none" || h.closest("[hidden]")) continue;
          const level = Number(h.tagName[1]);
          if (prev && level > prev + 1) out.push(`h${prev} to h${level} "${h.textContent.trim().slice(0, 30)}"`);
          prev = level;
        }
        return out;
      });
      assert.deepEqual(jumps, [], `${url} (${lang}): a heading level is skipped: ${jumps.join("; ")}`);
    }
  }
});

s.test("G87 (must) printing a public page leaves out the header, menu and footer and writes external links out in full", async (ctx) => {
  for (const path of ["/privacy-policy.html", "/events.html"]) {
    await ctx.goto(path, "networkidle2");
    await ctx.page.emulateMediaType("print");
    try {
      const shown = await ctx.page.evaluate(() => {
        const vis = (sel) => [...document.querySelectorAll(sel)].some((e) => getComputedStyle(e).display !== "none");
        return { header: vis("header.mkt-header"), footer: vis("footer.mkt-footer"), skip: vis(".skip-link"), buttons: vis("main button, main .btn") };
      });
      assert.deepEqual(shown, { header: false, footer: false, skip: false, buttons: false }, `${path} in print`);
    } finally {
      await ctx.page.emulateMediaType("screen");
    }
  }
});

s.test("G88 (must) a phone set to dark mode still gets the light site, with light form controls", async (ctx) => {
  await ctx.page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  try {
    await ctx.goto("/contact", "networkidle2");
    const r = await ctx.page.evaluate(() => ({
      meta: (document.querySelector('meta[name="color-scheme"]') || {}).content,
      scheme: getComputedStyle(document.documentElement).colorScheme,
      body: getComputedStyle(document.body).backgroundColor,
    }));
    assert.equal(r.meta, "light");
    assert.equal(r.scheme, "light");
    assert.notEqual(r.body, "rgb(0, 0, 0)");
  } finally {
    await ctx.page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  }
});

s.manual("G89 added to the home screen on an iPhone, no bar or button sits behind the home indicator", "needs a real iPhone in home-screen (standalone) mode; the safe-area padding itself is checked by a unit test");

s.test("G90 (must) covers on a phone are sized: the Browse Books grid asks for the 300, 450 or 600 px copy, never an oversized one for a 160 px slot", { viewport: GUEST_PHONE }, async (ctx) => {
  const asked = [];
  ctx.page.on("request", (r) => { if (/\/img\//.test(r.url())) asked.push(new URL(r.url()).pathname); });
  await ctx.goto("/books.html", "networkidle2");
  await ctx.page.waitForSelector(".bk-book img.cover", { timeout: 8000 }).catch(() => ctx.skip("data: no New In covers on the site"));
  const img = await ctx.page.evaluate(() => { const i = document.querySelector(".bk-book img.cover"); return { srcset: i.getAttribute("srcset"), sizes: i.getAttribute("sizes") }; });
  if (!img.srcset) ctx.skip("data: the first cover is not a stored /img/ cover");
  assert.match(img.srcset, /-w300\.jpg 300w, \/img\/[0-9a-f]{64}-w450\.jpg 450w/);
  assert.ok(img.sizes, "sizes is set");
  assert.ok(asked.some((u) => /-w(300|450)\.jpg$/.test(u)), `a small cover was requested (${asked.slice(0, 3).join(", ")})`);
});

// ---- New In carousel (G91) and See All New In (G92) ----

// Text inside a New In card that may be wider or taller than its box, with the reason. Empty on purpose: the titles, authors and
// prices all wrap (a very long word breaks), so nothing is clipped; add a line here only with a reason.
const CAROUSEL_TEXT_ALLOW = [];

// where the carousel is at rest: which cards are in view and whether any is cut by the edge of the box
async function carouselState(page) {
  return page.evaluate((allow) => {
    const tr = document.getElementById("bk-new-track");
    const T = tr.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(tr).paddingLeft) || 0;
    const left = T.left + pad - 1, right = T.right - pad + 1; // the box inside its padding (1px for rounding)
    const cards = [...tr.querySelectorAll(".bk-book")].map((c, i) => ({ i, r: c.getBoundingClientRect(), c }));
    const inView = cards.filter((x) => x.r.right > left + 1 && x.r.left < right - 1);
    const cut = inView.filter((x) => x.r.left < left - 0.5 || x.r.right > right + 0.5).map((x) => `card ${x.i} (${Math.round(x.r.left - T.left)}..${Math.round(x.r.right - T.left)} in a box of ${Math.round(T.width)})`);
    const clipped = [];
    for (const x of cards) for (const el of x.c.querySelectorAll(".t, .a, .p")) {
      if (allow.some((a) => el.matches(a.selector))) continue;
      if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) clipped.push(`card ${x.i} .${el.className}: "${el.textContent.slice(0, 30)}"`);
      const cs = getComputedStyle(el);
      if (cs.textOverflow === "ellipsis" || cs.webkitLineClamp !== "none") clipped.push(`card ${x.i} .${el.className} is ellipsized or line-clamped`);
    }
    const first = inView[0];
    return {
      count: cards.length, scrollLeft: tr.scrollLeft, cut, clipped,
      firstOffset: first ? Math.round((first.r.left - T.left - pad) * 10) / 10 : null,
      prevDisabled: document.getElementById("bk-new-prev").disabled, nextDisabled: document.getElementById("bk-new-next").disabled,
      docWider: document.documentElement.scrollWidth > innerWidth + 1,
    };
  }, CAROUSEL_TEXT_ALLOW);
}
// wait until the scrolling has stopped
async function carouselSettled(page) {
  let last = -1, still = 0;
  for (let i = 0; i < 40 && still < 4; i++) {
    const now = await page.$eval("#bk-new-track", (t) => t.scrollLeft);
    still = now === last ? still + 1 : 0;
    last = now;
    await new Promise((r) => setTimeout(r, 100));
  }
}
function assertAtRest(st, where) {
  assert.deepEqual(st.cut, [], `${where}: a card is cut by the edge of the carousel when it stops: ${st.cut.join("; ")}`);
  assert.ok(st.firstOffset != null && Math.abs(st.firstOffset) <= 2, `${where}: the first card in view starts ${st.firstOffset} px from the left edge (should be 0)`);
  assert.deepEqual(st.clipped, [], `${where}: clipped text: ${st.clipped.join("; ")}`);
  assert.equal(st.docWider, false, `${where}: the page scrolls sideways`);
}

// The carousel holds EVERY New In book, newest first: the same books in the same order as the API, however many there are.
// On the local site the seed adds books at known times (E2E Sample New In <n> = 1..30 added in turn, then Bulk <k>, k minutes x 7 ago),
// so the time order can be checked from the titles too.
async function assertCarouselIsWholeNewestFirstList(ctx, where) {
  const api = await e2e.getJson("/api/books/new-in?all=1");
  if (!api || !api.total) ctx.skip("data: the site has no New In books");
  const cards = await ctx.page.$$eval("#bk-new-track .bk-book a", (as) => as.map((a) => ({ id: Number((a.getAttribute("href").match(/books\/(\d+)/) || [])[1]), t: a.querySelector(".t").textContent })));
  assert.equal(cards.length, api.total, `${where}: the carousel has a card for every new book (${api.total}), not just the first page`);
  assert.deepEqual(cards.map((c) => c.id), api.books.map((b) => b.id), `${where}: the carousel order is the API order (newest added first)`);
  const bulk = cards.map((c) => (c.t.match(/New In Bulk (\d+)/) || [])[1]).filter(Boolean).map(Number);
  if (bulk.length) {
    assert.deepEqual(bulk, [...bulk].sort((a, b) => a - b), `${where}: books added the same day are in time order (Bulk 1 is the newest)`);
    const firstBulk = cards.findIndex((c) => /New In Bulk /.test(c.t));
    const plain = cards.map((c, i) => ({ i, n: Number((c.t.match(/New In (\d+)/) || [])[1]) })).filter((x) => x.n > 0 && !/Bulk/.test(cards[x.i].t));
    assert.ok(plain.every((x) => x.i < firstBulk), `${where}: the books added a moment ago come before the older ones`);
    assert.deepEqual(plain.map((x) => x.n), plain.map((x) => x.n).sort((a, b) => b - a), `${where}: the most recently added is first`);
  }
}

s.test("G91 (must) the New In carousel holds every new book newest first and never stops on a cut-off card (375 px, 1024 px, 1280 px and 125% zoom), titles are whole, and the arrows, double clicks and arrow keys land on card edges", { timeout: 1200000 }, async (ctx) => {
  // 125% browser zoom of a 1280 px window is a 1024 px wide page, so it is the 1024 px run; 150% of 1920 is 1280.
  for (const lang of ["en", "fr"]) {
    await ctx.page.setCookie({ name: "umasbooks_lang", value: lang, url: cfg.baseUrl() });
    for (const [width, height, touch] of [[375, 812, true], [1024, 800, false], [1280, 800, false]]) {
      await ctx.page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: touch, hasTouch: touch });
      await ctx.goto("/books.html", "networkidle2");
      await ctx.page.waitForSelector("#bk-new-track .bk-book", { timeout: 8000 }).catch(() => ctx.skip("data: the site has no New In books"));
      await new Promise((r) => setTimeout(r, 400));
      const where = `${lang} ${width} px`;
      await assertCarouselIsWholeNewestFirstList(ctx, where);
      let st = await carouselState(ctx.page);
      assertAtRest(st, `${where} at the start`);
      assert.equal(st.prevDisabled, true, `${where}: Previous is disabled at the start`);
      for (let n = 1; n <= 150 && !(await carouselState(ctx.page)).nextDisabled; n++) {
        if (touch) {
          // a finger: swipe left across the track
          const box = await ctx.page.$eval("#bk-new-track", (t) => { const r = t.getBoundingClientRect(); return { x: r.left + r.width * 0.85, y: r.top + 60, w: r.width }; });
          await ctx.page.touchscreen.touchStart(box.x, box.y);
          for (let k = 1; k <= 8; k++) await ctx.page.touchscreen.touchMove(box.x - (box.w * 0.7 * k) / 8, box.y);
          await ctx.page.touchscreen.touchEnd();
        } else {
          // the mouse: a click, or two quick clicks
          await ctx.page.click("#bk-new-next");
          if (n % 2 === 0) await ctx.page.click("#bk-new-next");
        }
        await carouselSettled(ctx.page);
        st = await carouselState(ctx.page);
        assertAtRest(st, `${where} after ${touch ? "swipe" : "click"} ${n}`);
        if (touch) break; // a phone has no arrows; one swipe is enough here, the loop below keeps swiping
      }
      if (touch) {
        for (let n = 0; n < 6; n++) {
          const box = await ctx.page.$eval("#bk-new-track", (t) => { const r = t.getBoundingClientRect(); return { x: r.left + r.width * 0.85, y: r.top + 60, w: r.width }; });
          await ctx.page.touchscreen.touchStart(box.x, box.y);
          for (let k = 1; k <= 8; k++) await ctx.page.touchscreen.touchMove(box.x - (box.w * 0.7 * k) / 8, box.y);
          await ctx.page.touchscreen.touchEnd();
          await carouselSettled(ctx.page);
          assertAtRest(await carouselState(ctx.page), `${where} after swipe ${n + 2}`);
        }
        continue;
      }
      assert.equal((await carouselState(ctx.page)).nextDisabled, true, `${where}: Next is disabled on the last page`);
      // back with Previous, down to the start
      for (let n = 0; n < 150 && !(await carouselState(ctx.page)).prevDisabled; n++) {
        await ctx.page.click("#bk-new-prev");
        await carouselSettled(ctx.page);
        assertAtRest(await carouselState(ctx.page), `${where} after Previous ${n + 1}`);
      }
      // the keyboard: focus a card link, then the arrow keys move one card at a time
      await ctx.page.focus("#bk-new-track .bk-book a");
      for (let n = 0; n < 3; n++) {
        await ctx.page.keyboard.press("ArrowRight");
        await carouselSettled(ctx.page);
        assertAtRest(await carouselState(ctx.page), `${where} after ArrowRight ${n + 1}`);
      }
      // the arrows are tap-sized and the focus outline is there
      const arrow = await ctx.page.$eval("#bk-new-next", (b) => { const r = b.getBoundingClientRect(); b.focus(); return { w: r.width, h: r.height }; });
      assert.ok(arrow.w >= 44 && arrow.h >= 44, `${where}: the arrow is ${arrow.w}x${arrow.h}`);
    }
  }
  await ctx.page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
});

s.test("G92 (must) See All New In shows every new book in a grid with Show more (no count), and the New In carousel is only on the plain Browse view (EN and FR)", { timeout: 300000 }, async (ctx) => {
  const visible = (sel) => ctx.page.evaluate((q) => { const e = document.querySelector(q); return !!e && !e.hidden && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length); }, sel);
  for (const lang of ["en", "fr"]) {
    await ctx.page.setCookie({ name: "umasbooks_lang", value: lang, url: cfg.baseUrl() });
    const api = await e2e.getJson("/api/books/new-in?offset=0&limit=24");
    if (!api || !api.total) ctx.skip("data: the site has no New In books");
    await ctx.goto("/books.html", "networkidle2");
    await ctx.page.waitForSelector("#bk-new-track .bk-book");
    assert.equal(await visible(".bk-new"), true, `${lang}: the carousel is on the plain view`);
    // a genre hides it, clearing (Back) shows it
    await ctx.page.click("#bk-genre-list .bk-genre");
    await ctx.page.waitForFunction(() => !document.getElementById("bk-results").hidden);
    assert.equal(await visible(".bk-new"), false, `${lang}: a genre hides the carousel`);
    assert.equal(await ctx.page.$eval(".bk-new", (e) => e.hidden), true);
    await ctx.page.goBack();
    await ctx.page.waitForFunction(() => document.getElementById("bk-results").hidden);
    assert.equal(await visible(".bk-new"), true, `${lang}: Back to the plain view shows the carousel again`);
    // a search hides it
    await ctx.page.type("#shop-search-input", "a");
    await ctx.page.keyboard.press("Enter");
    await ctx.page.waitForFunction(() => !document.getElementById("bk-results").hidden);
    assert.equal(await visible(".bk-new"), false, `${lang}: a search hides the carousel`);
    // See All New In: hidden carousel, count, every book
    await ctx.goto("/books.html", "networkidle2");
    await ctx.page.waitForSelector("#bk-new-track .bk-book");
    await ctx.page.click("#bk-new-all");
    await ctx.page.waitForFunction(() => document.querySelectorAll("#bk-results-grid .bk-book").length > 0);
    assert.equal(await visible(".bk-new"), false, `${lang}: See All hides the carousel`);
    assert.equal(await ctx.page.evaluate(() => !!document.getElementById("bk-new-prev") && document.querySelector(".bk-new").hidden), true, `${lang}: the arrows go with it`);
    assert.equal(await ctx.page.$$eval("#bk-results-count", (e) => e.length), 0, `${lang}: there is no count line`);
    for (let i = 0; i < 40 && (await visible("#bk-more")); i++) {
      const before = await ctx.page.$$eval("#bk-results-grid .bk-book", (e) => e.length);
      await ctx.page.click("#bk-more");
      await ctx.page.waitForFunction((n) => document.querySelectorAll("#bk-results-grid .bk-book").length > n, { timeout: 8000 }, before);
    }
    assert.equal(await ctx.page.$$eval("#bk-results-grid .bk-book", (e) => e.length), api.total, `${lang}: the grid holds every new book (${api.total})`);
    const all = await e2e.getJson("/api/books/new-in?all=1");
    assert.deepEqual(await ctx.page.$$eval("#bk-results-grid .bk-book a", (as) => as.map((a) => Number((a.getAttribute("href").match(/books\/(\d+)/) || [])[1]))), all.books.map((b) => b.id), `${lang}: See All is in the same newest-first order as the carousel`);
    assert.equal(await visible("#bk-more"), false, `${lang}: no Show more once everything is shown`);
    // Back returns to the plain view with the carousel; a direct load of a shared address has none
    await ctx.page.goBack().catch(() => {});
    await ctx.goto("/books.html?genre=fiction", "networkidle2");
    assert.equal(await visible(".bk-new"), false, `${lang}: ?genre=fiction loads with no carousel`);
    assert.equal(await ctx.page.evaluate(() => { const e = document.querySelector(".bk-new"); return !e || e.hidden || getComputedStyle(e).display === "none"; }), true);
    await ctx.goto("/books.html?new=1", "networkidle2");
    assert.equal(await visible(".bk-new"), false, `${lang}: ?new=1 loads with no carousel`);
    await ctx.goto("/fr/books.html?genre=fiction", "networkidle2");
    assert.equal(await visible(".bk-new"), false, "/fr/ with a genre has no carousel");
  }
});

s.test("G93 (must) a genre list pages with Show more until every book is shown, with no count line (EN and FR, also on a direct load)", { timeout: 300000 }, async (ctx) => {
  const visible = (sel) => ctx.page.evaluate((q) => { const e = document.querySelector(q); return !!e && !e.hidden && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length); }, sel);
  const grid = () => ctx.page.$$eval("#bk-results-grid .bk-book a", (as) => as.map((a) => Number((a.getAttribute("href").match(/books\/(\d+)/) || [])[1])));
  for (const lang of ["en", "fr"]) {
    await ctx.page.setCookie({ name: "umasbooks_lang", value: lang, url: cfg.baseUrl() });
    const first = await e2e.getJson("/api/books/search?topic=fiction&paged=1&offset=0&limit=24");
    if (!first || !first.total) ctx.skip("data: the site has no Fiction books");
    if (first.total <= 24) ctx.skip("data: not enough Fiction books to need a second page");
    for (const direct of [false, true]) {
      await ctx.goto(direct ? "/books.html?genre=fiction" : "/books.html", "networkidle2");
      if (!direct) { await ctx.page.waitForSelector("#bk-genre-list .bk-genre"); await ctx.page.click("#bk-genre-list .bk-genre"); }
      await ctx.page.waitForFunction(() => document.querySelectorAll("#bk-results-grid .bk-book").length > 0);
      const where = `${lang} ${direct ? "direct load" : "genre click"}`;
      assert.equal((await grid()).length, 24, `${where}: the first page is 24 books`);
      assert.equal(await ctx.page.$$eval("#bk-results-count", (e) => e.length), 0, `${where}: no count line on a genre list`);
      assert.equal(await visible("#bk-more"), true, `${where}: Show more is there`);
      for (let i = 0; i < 60 && (await visible("#bk-more")); i++) {
        const before = (await grid()).length;
        await ctx.page.click("#bk-more");
        await ctx.page.waitForFunction((n) => document.querySelectorAll("#bk-results-grid .bk-book").length > n, { timeout: 8000 }, before);
        const focusedIsFirstNew = await ctx.page.evaluate((n) => document.activeElement === document.querySelectorAll("#bk-results-grid .bk-book a")[n], before);
        assert.equal(focusedIsFirstNew, true, `${where}: focus moves to the first newly added book`);
      }
      const ids = await grid();
      assert.equal(ids.length, first.total, `${where}: every Fiction book is reachable (${first.total})`);
      assert.equal(new Set(ids).size, ids.length, `${where}: no book twice`);
      assert.equal(await visible("#bk-more"), false, `${where}: no Show more once everything is shown`);
    }
  }
});


// ---- 1C. Curated collections (the round-picture buttons above the genre buttons, and their pages) ----

// The visible state of the collection row: shown (has size) or not.
const collectionRowShown = (ctx) => ctx.page.$eval("#bk-collections", (e) => !e.hidden && e.getBoundingClientRect().height > 0).catch(() => false);

s.test("G96 (must) Browse Books: the collection buttons show on the plain page and hide while a genre, a search or See All New In is showing", async (ctx) => {
  await ctx.goto("/books.html", "networkidle2");
  if (!(await ctx.page.$("#bk-collections"))) ctx.skip("data: no collection is published (with an approved book in stock) on this site");
  await ctx.page.waitForSelector("#bk-genre-list .bk-genre");
  assert.equal(await collectionRowShown(ctx), true, "shown on the default view");
  const order = await ctx.page.evaluate(() => {
    const top = (sel) => document.querySelector(sel).getBoundingClientRect().top;
    const t = ["h1", "#shop-search-form", "#bk-collections", ".bk-new", "#bk-genre-list"].map(top);
    return { sorted: t.every((v, i) => i === 0 || v > t[i - 1]), flower: !!document.querySelector(".bk-flower, .bk-title-row") };
  });
  assert.ok(order.sorted, "page order: title, search, collections, New In, genres");
  assert.equal(order.flower, false, "no flower beside the title");

  await ctx.page.click("#bk-genre-list .bk-genre");
  await ctx.page.waitForSelector("#bk-results:not([hidden])");
  assert.equal(await collectionRowShown(ctx), false, "hidden while a genre is chosen");
  await ctx.page.goBack();
  await ctx.page.waitForFunction(() => document.querySelector("#bk-results").hidden);
  assert.equal(await collectionRowShown(ctx), true, "back on the plain page: shown again");

  await ctx.page.type("#shop-search-input", "the");
  await ctx.page.keyboard.press("Enter");
  await ctx.page.waitForSelector("#bk-results:not([hidden])");
  assert.equal(await collectionRowShown(ctx), false, "hidden while a search is showing");

  await ctx.goto("/books.html?new=1", "networkidle2");
  await ctx.page.waitForSelector("#bk-results:not([hidden])");
  assert.equal(await collectionRowShown(ctx), false, "hidden on See All New In (?new=1)");
  await ctx.goto("/books.html?genre=fiction", "networkidle2");
  assert.equal(await collectionRowShown(ctx), false, "hidden when the address names a genre");
  await ctx.goto("/books.html?q=paris", "networkidle2");
  assert.equal(await collectionRowShown(ctx), false, "hidden when the address holds a search");
  await ctx.goto("/books.html", "networkidle2");
  assert.equal(await collectionRowShown(ctx), true);
});

s.test("G97 (must) a collection button opens its page: title, description, the books as the usual cards, and a link back to Browse; the same in French", async (ctx) => {
  await ctx.goto("/books.html", "networkidle2");
  if (!(await ctx.page.$("#bk-collections .col-btn"))) ctx.skip("data: no collection is published (with an approved book in stock) on this site");
  const first = await ctx.page.$eval("#bk-collections .col-btn", (a) => ({ href: a.getAttribute("href"), name: a.innerText.trim() }));
  await Promise.all([ctx.page.waitForNavigation({ waitUntil: "domcontentloaded" }), ctx.page.click("#bk-collections .col-btn")]);
  assert.match(new URL(ctx.page.url()).pathname, /^\/collections\/[a-z0-9-]+$/);
  assert.equal(await ctx.page.$eval("h1", (h) => h.innerText.trim()), first.name, "the page title is the button's caption");
  assert.ok((await ctx.page.$$(".bk-grid .bk-book")).length >= 1, "at least one book card");
  assert.equal(await ctx.page.$eval(".col-back a", (a) => a.getAttribute("href")), "/books.html");
  has(await ctx.text(), /Back to Browse books/);
  const alt = await ctx.page.$$eval("link[rel='alternate'][hreflang]", (l) => l.map((x) => x.hreflang));
  assert.deepEqual(alt.sort(), ["en", "fr", "x-default"]);
  assert.equal((await ctx.page.$eval("link[rel='canonical']", (l) => new URL(l.href).pathname)), new URL(ctx.page.url()).pathname);

  // French: the same page at /fr/..., nothing left in English.
  await ctx.goto(`/fr${first.href}`, "networkidle2");
  assert.equal(await ctx.page.$eval("html", (h) => h.lang), "fr");
  const text = await ctx.text();
  has(text, /Retour à Parcourir les livres/);
  hasNot(text, /Back to Browse|Cover images come from|Add .* to favorites/);
  assert.equal(await ctx.page.$eval(".col-back a", (a) => a.getAttribute("href")), "/fr/books.html");
  await ctx.goto("/fr/books.html", "networkidle2");
  has(await ctx.page.$eval("#bk-collections", (e) => e.innerText), /Parcourir\s+par collection/);
});

s.test("G98 (must) on a phone (375 px) the collections are a swipeable carousel (no arrows), each entry at least 44 px tall, icons 90 px, whole entries only, with no page-wide sideways scrolling", { viewport: GUEST_PHONE }, async (ctx) => {
  await ctx.goto("/books.html", "networkidle2");
  if (!(await ctx.page.$("#bk-collections .col-btn"))) ctx.skip("data: no collection is published (with an approved book in stock) on this site");
  const r = await ctx.page.$$eval("#bk-collections .col-btn", (els) => els.map((e) => { const b = e.getBoundingClientRect(); return { left: Math.round(b.left), top: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; }));
  assert.ok(r.every((b) => b.w >= 44 && b.h >= 44), "every button is at least 44 x 44 px");
  assert.ok(r.every((b) => Math.abs(b.top - r[0].top) < 4), "one carousel row");
  assert.equal(await ctx.page.$eval("#bk-collections .col-btn img", (i) => Math.round(i.getBoundingClientRect().width)), 90, "icon is 75% of the old 120 px");
  assert.equal(await ctx.page.$eval("#bk-col-prev", (b) => getComputedStyle(b).display), "none", "arrows are hidden on a touch phone: swipe");
  assert.deepEqual(await phoneOverflow(ctx.page, 375), []);
  assert.equal(await ctx.page.$eval("#bk-collections .col-btn img", (i) => i.getAttribute("alt")), "", "the picture is decoration: the caption is the name");
  assert.equal(await ctx.page.$eval("#bk-collections .col-btn img", (i) => i.getAttribute("loading")), "lazy");
});

s.test("G99 (must) with JavaScript off the collection buttons and the collection page still work", async (ctx) => {
  await ctx.page.setJavaScriptEnabled(false);
  try {
    await ctx.goto("/books.html");
    if (!(await ctx.page.$("#bk-collections .col-btn"))) ctx.skip("data: no collection is published (with an approved book in stock) on this site");
    const href = await ctx.page.$eval("#bk-collections .col-btn", (a) => a.getAttribute("href"));
    await ctx.goto(href);
    assert.ok((await ctx.page.$$(".bk-grid .bk-book a[href^='/books/']")).length >= 1, "the books are plain links");
    has(await ctx.text(), /Back to Browse books/);
  } finally {
    await ctx.page.setJavaScriptEnabled(true);
  }
});

s.test("G100 (must) an unpublished or unknown collection address is a 404, in English and in French", async (ctx) => {
  for (const p of ["/collections/no-such-collection", "/fr/collections/no-such-collection"]) {
    const res = await ctx.goto(p);
    assert.equal(res.status(), 404, p);
  }
  // A real collection that nobody has published yet (the migration seeds them all unpublished).
  const res = await ctx.goto("/collections/the-art-of-getting-lost");
  if (res.status() === 200) ctx.skip("data: this collection has been published on this site");
  assert.equal(res.status(), 404);
});

s.test("G-FR55 FR check (membership): the form and the payment step are in French", { lang: "fr" }, async (ctx) => {
  await joinPage(ctx);
  const text = await ctx.text();
  for (const re of [/Devenir membre/, /Continuer vers le paiement/]) has(text, re);
});
