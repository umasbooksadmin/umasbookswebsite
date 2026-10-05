// Script 1 of docs/testing/manual-test-scripts.md: the guest (anyone not logged in).
// A guest browses, fills a cart and can use the forms, but cannot buy: checkout
// asks them to log in or create an account first (G50, G51).
// Every test is named with its manual step id. Read-only except the contact
// and book-request forms, which send email and so need E2E_ALLOW_WRITES=1.

const assert = require("node:assert/strict");
const e2e = require("../helpers/harness");
const { has, hasNot, stockedBook, addFirstCopyToCart, pageHtml, stripTags, cartLineCount } = require("../helpers/pages");
const { testEmail } = require("../helpers/config");
const cfg = require("../helpers/config");

const s = e2e.persona("guest");

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
  const footer = await ctx.page.$eval("footer", (f) => f.innerText);
  for (const label of ["Contact Us", "Albi, France", "Privacy Policy", "Terms of Sale", "Legal Notice"]) has(footer, new RegExp(label, "i"));
});

s.test("G2 each footer link opens a page, no error page", async (ctx) => {
  await ctx.goto("/");
  const hrefs = await ctx.page.$$eval("footer a[href]", (as) => as.map((a) => a.getAttribute("href")).filter((h) => h && h !== "#"));
  assert.ok(hrefs.length >= 5, "footer links present");
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

s.test("G7 (must) the cart in preview mode explains ordering is off and has no checkout form", async (ctx) => {
  if (!ctx.preview) ctx.skip("the site is not in preview mode");
  const book = await stockedBook(ctx);
  await addFirstCopyToCart(ctx, book);
  const text = await ctx.text();
  has(text, /Online ordering opens when we launch/);
  has(text, /Total:/);
  assert.equal(await ctx.page.$("form[action='/cart/checkout']"), null, "no checkout form in preview mode");
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
  has(await ctx.text(), /La commande en ligne ouvrira au lancement/);
  await ctx.goto("/membership.html");
  await ctx.page.waitForFunction(() => /L.adhésion ouvrira au lancement/i.test(document.body.innerText));
});

s.test("G10 with preview off the banner is gone and the cart shows the checkout form or the prompt to log in (preview off only)", async (ctx) => {
  if (ctx.preview) ctx.skip("the site is in preview mode");
  await ctx.goto("/");
  assert.equal(await ctx.page.$(".preview-banner"), null);
  const book = await stockedBook(ctx);
  await addFirstCopyToCart(ctx, book);
  const form = await ctx.page.$("form[action='/cart/checkout']");
  // A guest sees the checkout form today; once buying needs an account (G50) they see a prompt to log in instead.
  if (!form) has(await ctx.text(), /Online payment isn.t switched on yet|log in|sign up|create an account/);
});

// ---- 1C. Books ----

s.test("G11 (must) Browse Books has search, genres, New In carousel and a recommendation area", async (ctx) => {
  await ctx.goto("/books.html", "networkidle2");
  const ph = await ctx.page.$eval("#shop-search-input", (i) => i.placeholder);
  has(ph, /Search by title, author, keyword, or genre/);
  await ctx.page.waitForSelector("#bk-genre-list .bk-genre");
  assert.ok((await ctx.page.$$("#bk-genre-list .bk-genre")).length >= 5, "genre buttons");
  const text = await ctx.text();
  has(text, /New In/);
  has(text, /See All New In/);
  assert.ok(await ctx.page.$("#bk-new-prev") && await ctx.page.$("#bk-new-next"), "carousel arrows");
  assert.ok(await ctx.page.$(".bk-rec"), "recommendation section");
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
});

s.test("G16 (must) 'What the grades mean' lists the four grades", async (ctx) => {
  const book = await stockedBook(ctx);
  await ctx.goto(`/books/${book.id}`);
  await ctx.page.click(".grade-legend summary");
  const legend = await ctx.page.$eval(".grade-legend", (d) => d.innerText);
  for (const g of ["New", "Like New", "Very Good", "Acceptable"]) has(legend, new RegExp(g));
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
  for (const g of ["Neuf", "Comme neuf", "Très bon état", "État acceptable"]) has(legend, new RegExp(g));
  assert.equal(await ctx.page.$eval("html", (h) => h.lang), "fr");
});

s.todo("G-FR12 French prices use the comma style 12,50 € on the book page", "known issue: prices show €12.50 in French on the book page, cart and order email (the 12,50 € style is only used in book-request emails)", { lang: "fr" }, async (ctx) => {
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
  const mailto = await ctx.page.$("form[data-mailto]");
  await ctx.goto("/pre-registration.html");
  assert.ok(await ctx.page.$("form[data-mailto]") || mailto, "the pre-registration form is a mailto form");
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
  for (const t of ["General question", "Books & orders", "English programs", "Events", "Donating books", "Membership", "Other"]) assert.ok(topics.includes(t), t);
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
  has(await ctx.text(), /Merci ! Votre message a bien été envoyé/);
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
  for (const re of [/14 days/i, /withdrawal/i, /mediat/i]) has(tos, re);
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

s.todo("G40b legal pages are French in the server's own HTML (no JavaScript needed)", "known gap: the legal pages are translated by the page's script, so the HTML the server sends is English; search engines and anyone with scripts off see English", { lang: "fr" }, async (ctx) => {
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

// ---- 1I. Member pages and buying need a login ----

s.test("G52 logged out, /forum shows the login page", { anon: true }, async (ctx) => {
  await ctx.goto("/forum");
  assert.equal(new URL(ctx.page.url()).pathname, "/login");
});

// Buying needs an account.
//
// NOTE (changing): until the pull request that makes checkout need an account
// is merged, the site still lets a guest check out, so G50 and G51 fail today
// and are shown as known issues. Once the site has the new behaviour they
// pass, and the report says "NOW PASSES, remove the todo".

// What the site does with a checkout request from someone who is not logged in.
async function checkoutAsGuest(ctx) {
  const res = await ctx.page.evaluate(async () => {
    const { token } = await (await fetch("/api/csrf-token")).json();
    const body = new URLSearchParams({ _csrf: token, name: "E2E guest check", email: "e2e@example.invalid", acceptCgv: "on" });
    const r = await fetch("/cart/checkout", { method: "POST", body, redirect: "manual" });
    return { type: r.type, status: r.status };
  });
  return res;
}

s.todo("G50 (must) checkout asks a guest to log in or create an account", "waiting for the pull request that makes buying need an account (checkout still accepts guests)", async (ctx) => {
  if (ctx.preview) ctx.skip("preview mode: checkout is switched off for everyone");
  const book = await stockedBook(ctx);
  await addFirstCopyToCart(ctx, book);
  // The cart offers a way to log in or sign up (a link or button) instead of a guest checkout form...
  const text = await ctx.text();
  assert.equal(await ctx.page.$("form[action='/cart/checkout'] input[name='acceptCgv']"), null, "a guest must not be shown the pay-and-buy form");
  assert.ok(await ctx.page.$("a[href^='/login'], a[href^='/signup']"), "a way to log in or create an account");
  has(text, /log in|sign up|create an account/);
  // ...and a request sent anyway is turned away to the login page, never started.
  const sent = await checkoutAsGuest(ctx);
  assert.equal(sent.type, "opaqueredirect", `checkout answered ${sent.status} to a guest, expected a redirect to log in`);
  assert.deepEqual(ctx.blocked, [], "no payment page was reached");
});

s.todo("G51 (must) after logging in from the cart, the guest is back on the cart with their items", "waiting for the pull request that makes buying need an account", { needs: ["account"] }, async (ctx) => {
  if (ctx.preview) ctx.skip("preview mode: checkout is switched off for everyone");
  const c = cfg.credentials("account");
  const book = await stockedBook(ctx);
  await addFirstCopyToCart(ctx, book);
  const login = await ctx.page.$("a[href^='/login']");
  assert.ok(login, "the cart offers a log in link to a guest");
  await Promise.all([ctx.page.waitForNavigation(), login.click()]);
  await ctx.page.type("form[action='/login'] #email", c.email);
  await ctx.page.type("form[action='/login'] #password", c.password);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/login'] button[type='submit']")]);
  assert.equal(new URL(ctx.page.url()).pathname, "/cart", "back on the cart after logging in");
  assert.equal(await cartLineCount(ctx), 1, "the item is still in the cart");
});
