// Script 2 of docs/testing/manual-test-scripts.md: the guest buyer.
//
// SAFETY: these tests NEVER pay. The browser blocks every request to
// HelloAsso (helpers/harness.js), so even the redirect to the payment page
// is stopped before it loads. In preview mode checkout is switched off and
// the tests assert exactly that. When payments are on, the only paid-path
// test (G6) needs E2E_ALLOW_WRITES=1, starts a checkout with a tagged
// placeholder buyer, checks the redirect points at the HelloAsso domain,
// and stops there. It leaves one unpaid order that holds a copy for 60
// minutes (the site frees it by itself).

const assert = require("node:assert/strict");
const e2e = require("../helpers/harness");
const { has, hasNot, stockedBook, addFirstCopyToCart, cartLineCount } = require("../helpers/pages");
const { testEmail } = require("../helpers/config");

const s = e2e.persona("guest");
let held = null; // set by G6 for G7: { bookId, copiesBefore }

const checkoutForm = (ctx) => ctx.page.$("form[action='/cart/checkout']");
async function needPayments(ctx) {
  if (ctx.preview) ctx.skip("preview mode: payments are switched off, so the checkout form does not exist (only G1 to G3 apply)");
  if (!(await checkoutForm(ctx))) ctx.skip("payments are not switched on for this site: the cart has no checkout form");
}

s.test("G1 (must) add to cart shows the cart with the book, condition, price and Remove", async (ctx) => {
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

s.test("G2 a second book can be added and removed; the total updates", async (ctx) => {
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

s.test("G3 the cart icon number matches the lines in the cart", async (ctx) => {
  const book = await stockedBook(ctx);
  await addFirstCopyToCart(ctx, book);
  for (const p of ["/", "/books.html", "/events"]) {
    await ctx.goto(p, "networkidle2");
    await ctx.page.waitForFunction(() => document.querySelector("[data-cart-count]").textContent.trim() === "1");
  }
});

s.test("G4 (must) the checkout form has name, email, phone, terms checkbox with link, privacy note and Pay & Buy", async (ctx) => {
  const book = await stockedBook(ctx);
  await addFirstCopyToCart(ctx, book);
  await needPayments(ctx);
  const form = await ctx.page.$eval("form[action='/cart/checkout']", (f) => f.innerText);
  for (const re of [/Name/, /Email/, /Phone \(optional\)/, /terms of sale/, /right of withdrawal/, /Pay & Buy/]) has(form, re);
  const link = await ctx.page.$eval("form[action='/cart/checkout'] a[href='/terms-of-sale.html']", (a) => a.target);
  assert.equal(link, "_blank", "the terms open in a new tab");
  assert.ok(await ctx.page.$("form[action='/cart/checkout'] a[href='/privacy-policy.html']"), "privacy note links the policy");
});

s.test("G5 (must) the form cannot be submitted without the terms box ticked or with a bad email", async (ctx) => {
  const book = await stockedBook(ctx);
  await addFirstCopyToCart(ctx, book);
  await needPayments(ctx);
  const before = ctx.page.url();
  await ctx.page.type("#name", `${process.env.E2E_RUN_ID} Buyer`);
  await ctx.page.type("#email", "not-an-email");
  await ctx.page.click("form[action='/cart/checkout'] button[type='submit']");
  assert.equal(ctx.page.url(), before, "the browser refused to submit");
  let v = await ctx.page.$eval("form[action='/cart/checkout']", (f) => ({ ok: f.checkValidity(), terms: f.querySelector("[name=acceptCgv]").validity.valueMissing, email: f.querySelector("#email").validity.typeMismatch }));
  assert.deepEqual(v, { ok: false, terms: true, email: true });
  await ctx.page.$eval("#email", (i) => { i.value = ""; });
  await ctx.page.type("#email", testEmail("guest-g5"));
  v = await ctx.page.$eval("form[action='/cart/checkout']", (f) => ({ ok: f.checkValidity(), terms: f.querySelector("[name=acceptCgv]").validity.valueMissing }));
  assert.deepEqual(v, { ok: false, terms: true }, "with a good email, only the terms box is still missing");
  assert.deepEqual(ctx.blocked, [], "nothing was sent anywhere");
});

s.test("G-FR4 FR check (cart): the cart and checkout form are in French", { lang: "fr" }, async (ctx) => {
  const book = await stockedBook(ctx);
  await addFirstCopyToCart(ctx, book);
  const text = await ctx.text();
  for (const re of [/Votre panier/, /Retirer/, /Total :/]) has(text, re);
  if (ctx.preview) { has(text, /La commande en ligne ouvrira au lancement/); return; }
  if (!(await checkoutForm(ctx))) return;
  for (const re of [/Paiement/, /Nom/, /E-mail/, /Téléphone \(facultatif\)/, /J.ai lu et j.accepte les conditions de vente/, /Commander et payer/, /Vous paierez en toute sécurité via HelloAsso, puis vous passerez à Uma's Books pour retirer votre commande/]) has(text, re);
});

s.test("G6 (preview mode) checkout is refused by the server and never reaches HelloAsso", async (ctx) => {
  if (!ctx.preview) ctx.skip("the site is not in preview mode (see G6 for the payments-on check)");
  const book = await stockedBook(ctx);
  await addFirstCopyToCart(ctx, book);
  // There is no form to press, so send the request a script would send.
  const status = await ctx.page.evaluate(async () => {
    const { token } = await (await fetch("/api/csrf-token")).json();
    const body = new URLSearchParams({ _csrf: token, name: "E2E preview check", email: "e2e@example.invalid", acceptCgv: "on" });
    const r = await fetch("/cart/checkout", { method: "POST", body, redirect: "manual" });
    return r.status;
  });
  assert.equal(status, 403, "preview mode answers 403 and starts no payment");
  assert.deepEqual(ctx.blocked, [], "no navigation to a payment page was even attempted");
  has(await ctx.text(), /Online ordering opens when we launch|cart/);
});

s.write("G6 (must) with payments on, Pay & Buy starts a checkout that redirects to HelloAsso; the test stops there", async (ctx) => {
  if (ctx.preview) ctx.skip("preview mode: checkout is off (asserted by the preview-mode G6 test)");
  const book = await stockedBook(ctx);
  await ctx.goto(`/books/${book.id}`);
  const copiesBefore = (await ctx.page.$$(".copy-table tbody tr")).length;
  await addFirstCopyToCart(ctx, book);
  await needPayments(ctx);
  const tag = process.env.E2E_RUN_ID;
  const email = testEmail("guest-g6");
  await ctx.page.type("#name", `${tag} Test Buyer`);
  await ctx.page.type("#email", email);
  await ctx.page.click("form[action='/cart/checkout'] input[name='acceptCgv']");
  await ctx.page.click("form[action='/cart/checkout'] button[type='submit']");
  const cspBlocked = () => ctx.consoleErrors.some((m) => /form-action/.test(m));
  const deadline = Date.now() + 20000;
  while (!ctx.blocked.length && !cspBlocked() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  // The order exists on the site as soon as the server answered, whatever the browser does next.
  ctx.created("unpaid order holding one book for 60 minutes (never paid, expires by itself)", `${tag} Test Buyer <${email}>`, "admin Orders: pending, becomes expired");
  held = { bookId: book.id, copiesBefore };
  if (!ctx.blocked.length && cspBlocked()) {
    assert.fail("the browser BLOCKED the redirect to HelloAsso because the page's Content-Security-Policy has form-action 'self' (src/index.js): " +
      "in Chrome the payment page cannot open, so nobody can pay. Fix: allow the HelloAsso addresses (https://*.helloasso.com, https://*.helloasso-sandbox.com) in form-action.");
  }
  assert.ok(ctx.blocked.length, `expected a redirect to HelloAsso; the page says: ${(await ctx.text()).slice(0, 200)}`);
  const host = new URL(ctx.blocked[0]).hostname;
  assert.match(host, /(^|\.)helloasso(-sandbox)?\.com$/, `redirected to ${host}`);
  // STOP: HelloAsso was never loaded, nothing was typed there.
});

s.test("G7 (must) a book held by an unpaid checkout is no longer for sale to someone else", async (ctx) => {
  if (!held) ctx.skip("needs the payments-on checkout test G6 (with E2E_ALLOW_WRITES=1) to have started a hold first");
  await ctx.goto(`/books/${held.bookId}`);
  const after = (await ctx.page.$$(".copy-table tbody tr")).length;
  assert.equal(after, held.copiesBefore - 1, "the held copy left the table");
});

s.manual("G8 pay with the HelloAsso test card and land on the Thank you page", "the tests never enter payment details or load a HelloAsso page");
s.manual("G9 order confirmation email (English): order number, items, collection, legal blocks", "needs a paid order and a readable mailbox");
s.manual("G10 order confirmation email (French) and the whole G1 to G9 flow in French", "needs a paid order and a readable mailbox");
s.manual("G11 refreshing the Thank you page and opening it in a second browser", "needs a paid order (the unguessable return link)");
s.manual("G12 admin sees the paid order and the books leave the shelves", "needs a paid order; the pending-order side is covered by A24a");
s.manual("G13 pickup: show the confirmation email, a volunteer hands over the books", "a human at the shop");

s.test("G14 the Terms of Sale say to collect within 14 days of payment (EN and FR)", async (ctx) => {
  await ctx.goto("/terms-of-sale.html");
  has(await ctx.text(), /Please collect within 14 days of payment; if you need longer, write to us/);
  await ctx.setLang("fr");
  await ctx.goto("/terms-of-sale.html");
  has(await ctx.text(), /14 jours/);
});

async function addDropin(ctx) {
  await ctx.goto("/sessions?type=dropin");
  let btn = await ctx.page.$("form[action='/cart/add-dropin'] button[type='submit']");
  if (!btn) {
    await ctx.goto("/sessions");
    btn = await ctx.page.$("form[action='/cart/add-dropin'] button[type='submit']");
  }
  if (!btn) ctx.skip("data: no session with a drop-in price and free places this month");
  // The sessions are in collapsed <details>.
  await ctx.page.$eval("form[action='/cart/add-dropin']", (f) => { const d = f.closest("details"); if (d) d.open = true; });
  await Promise.all([ctx.page.waitForNavigation(), btn.click()]);
  await ctx.goto("/cart");
}

s.test("G15 (must) a drop-in seat can be added to the cart from the sessions page", async (ctx) => {
  await addDropin(ctx);
  const text = await ctx.page.$eval(".cart-item", (e) => e.innerText);
  has(text, /Session/);
  has(text, /Drop-in seat/);
  has(text, /€\d+\.\d\d/);
});

s.test("G16 (must) a cart with a drop-in seat has the extra waiver checkbox, required", async (ctx) => {
  await addDropin(ctx);
  await needPayments(ctx);
  const required = await ctx.page.$eval("input[name='waiveWithdrawal']", (i) => i.required);
  assert.equal(required, true);
  const label = await ctx.page.$eval("input[name='waiveWithdrawal']", (i) => i.parentElement.innerText);
  has(label, /I ask for the session\(s\) to take place on the date booked/);
  has(label, /no longer withdraw/);
});

s.manual("G17 pay for a drop-in seat and check the confirmation email", "needs a payment and a mailbox");
s.manual("G18 one place fewer on /sessions after a paid seat", "needs a paid seat");
s.manual("G19 admin sees the paid drop-in buyer under the session", "needs a paid seat");

s.test("G-FR16 FR check: the drop-in waiver reads in French", { lang: "fr" }, async (ctx) => {
  await addDropin(ctx);
  await needPayments(ctx);
  has(await ctx.page.$eval("input[name='waiveWithdrawal']", (i) => i.parentElement.innerText), /Je demande que la ou les séances aient lieu à la date réservée/);
});

s.manual("G20 abandon at the HelloAsso page and come back", "needs the HelloAsso page");
s.manual("G21 buying again straight away with the same email", "would create a second unpaid order that holds more books; protection against hoarding is covered by the app's own tests");
s.manual("G22 wait about 70 minutes for the hold to expire", "needs real time to pass (the expiry job runs every 10 minutes)");
s.manual("G23 someone else takes your book while it is in your cart", "needs a second buyer completing a payment");
s.manual("G24 back button after paying", "needs a payment");

// The things a cart must survive, checked without paying.
s.test("G2b the cart survives a reload and the back button", async (ctx) => {
  const book = await stockedBook(ctx);
  await addFirstCopyToCart(ctx, book);
  await ctx.page.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await cartLineCount(ctx), 1);
  await ctx.page.goBack();
  hasNot(await ctx.text(), /Something went wrong|Your session expired/);
  await ctx.goto("/cart");
  assert.equal(await cartLineCount(ctx), 1);
});
