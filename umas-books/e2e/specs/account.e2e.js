// Script 2 of docs/testing/manual-test-scripts.md: the account holder.
//
// An account holder is logged in with a confirmed email but is NOT a paying
// member (is_member false, not a volunteer). Creating and confirming an
// account goes through emails, which tests cannot read. So: the sign-up steps
// that need no email run (and, with E2E_ALLOW_WRITES=1, create ONE tagged
// unconfirmed account that can never log in), and everything after "log in"
// uses the account you supply in E2E_ACCOUNT_EMAIL / E2E_ACCOUNT_PASSWORD (a
// plain account made by hand: sign up, confirm the email, choose a password,
// and do NOT make it a member). The harness checks this and skips the whole
// persona, with a clear message, when the account turns out to be a member.
//
// The buying journey (cart, checkout, HelloAsso, drop-in seat) is here too:
// buying needs an account. SAFETY: these tests NEVER pay. The browser blocks
// every request to HelloAsso (helpers/harness.js), so even the redirect to the
// payment page is stopped before it loads. In preview mode checkout is
// switched off and the tests assert exactly that. When payments are on, the
// only paid-path test (AC24) needs E2E_ALLOW_WRITES=1, starts a checkout,
// checks the redirect points at the HelloAsso domain, and stops there. It
// leaves one unpaid order that holds a copy for 60 minutes (the site frees it
// by itself).
//
// Nothing here changes the account's password, deletes it or locks it.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const e2e = require("../helpers/harness");
const { has, hasNot, stockedBook, addFirstCopyToCart } = require("../helpers/pages");
const cfg = require("../helpers/config");
const { testEmail } = cfg;

const s = e2e.persona("account");
const accountCreds = () => cfg.credentials("account");
let signup = null; // { email } of the tagged account AC3 creates
let held = null; // set by AC24 for AC25: { bookId, copiesBefore }

// Types into a field, replacing whatever the site already put there (a
// logged-in checkout form may be pre-filled with the account's details).
async function fill(ctx, sel, text) {
  if (sel === "#email" && !(await ctx.page.$(sel))) return; // once buying needs an account the email is the account's, shown read-only
  await ctx.page.$eval(sel, (i) => { i.value = ""; });
  await ctx.page.type(sel, text);
}

s.test("AC-setup the account-holder test login is a plain account (confirmed, not a member)", { as: "account" }, async (ctx) => {
  // The harness refuses the login when Member's Access opens for it (member, volunteer or admin),
  // and skips every account test with that message. Here it is checked once more, in plain sight.
  await ctx.goto("/dashboard");
  assert.equal(new URL(ctx.page.url()).pathname, "/", "an account holder is sent from Member's Access to the home page");
  assert.ok(await ctx.page.$("form[action='/logout'] button"), "logged in");
});

// A logged-in account keeps its cart between visits (and between tests), so
// every buying test starts from an empty one.
async function clearCart(ctx) {
  await ctx.goto("/cart");
  for (let i = 0; i < 30; i++) {
    const remove = await ctx.page.$(".cart-item form[action='/cart/remove'] button");
    if (!remove) break;
    await Promise.all([ctx.page.waitForNavigation({ waitUntil: "domcontentloaded" }), remove.click()]);
  }
}

// ---- 2A. Sign up, confirm, choose a password, log in ----

s.test("AC1 (must) the sign-up page asks for Name and Email only, and says a link will let you choose your password", { anon: true }, async (ctx) => {
  await ctx.goto("/signup");
  const labels = await ctx.page.$$eval("form[action='/signup'] label", (l) => l.map((x) => x.textContent.trim().toLowerCase()));
  assert.ok(labels.includes("name") && labels.includes("email"), `labels: ${labels}`);
  assert.equal(await ctx.page.$("form[action='/signup'] input[type='password']"), null, "the sign-up form must not ask for a password");
  has(await ctx.text(), /email you a link to confirm your address and choose your password/);
});

s.test("AC2 the sign-up form has no password field at all (the password is chosen after the email is confirmed)", { anon: true }, async (ctx) => {
  await ctx.goto("/signup");
  assert.equal(await ctx.page.$("#password"), null);
  assert.equal(await ctx.page.$(".password-toggle"), null);
});
s.manual("AC2b choosing a weak password, then a known-breached one, on the choose-your-password page is refused", "needs the emailed link (the page after AC5)");

s.write("AC3 (must) sign up creates an unconfirmed account and shows the check-your-inbox message", { anon: true }, async (ctx) => {
  const email = cfg.testEmail("account-signup");
  await ctx.goto("/signup");
  await ctx.page.type("#displayName", `${process.env.E2E_RUN_ID} Test Account One`);
  await ctx.page.type("#email", email);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/signup'] button[type='submit']")]);
  has(await ctx.text(), /Check your inbox/);
  assert.equal(await ctx.page.$("form[action='/logout']"), null, "not logged in after signing up");
  signup = { email };
  ctx.created("unconfirmed account (cannot log in: its email is example.invalid)", `${process.env.E2E_RUN_ID} Test Account One <${email}>`, "admin Accounts > search the tag > Erase Member");
});

s.write("AC4 (must) logging in before confirming gives the neutral 'Incorrect email or password' (401), and the login page offers a new confirmation link", { anon: true }, async (ctx) => {
  if (!signup) ctx.skip("needs AC3 to have created the account");
  // No password exists yet, so any attempt is refused exactly like an unknown address: nothing is revealed.
  await ctx.goto("/login");
  assert.ok(await ctx.page.$("form[action='/resend-verification']"), "the login page has the resend-confirmation-link form");
  await ctx.page.type("form[action='/login'] #email", signup.email);
  await ctx.page.type("form[action='/login'] #password", `Zq9!${crypto.randomBytes(8).toString("hex")}`);
  const [res] = await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/login'] button[type='submit']")]);
  assert.equal(res.status(), 401);
  const text = await ctx.text();
  has(text, /Incorrect email or password\./);
  assert.ok(!/confirm your email/i.test(await ctx.page.$eval(".error-box", (e) => e.textContent)), "the error must not reveal that the account is waiting for confirmation");
});

s.manual("AC5 open the confirmation email and click the link", "needs the emailed link");

s.manual("AC6 choose a password after confirming", "needs the emailed link");

s.test("AC7 (must) the account-holder test account can log in and the header shows Log Out", async (ctx) => {
  const c = accountCreds();
  await ctx.goto("/login");
  await ctx.page.type("form[action='/login'] #email", c.email);
  await ctx.page.type("form[action='/login'] #password", c.password);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/login'] button[type='submit']")]);
  assert.notEqual(new URL(ctx.page.url()).pathname, "/login", "still on the login page");
  assert.ok(await ctx.page.$("form[action='/logout'] button"), "the person icon is now Log Out");
});

s.write("AC8 (must) signing up again with the same address shows the same message", { anon: true }, async (ctx) => {
  if (!signup) ctx.skip("needs AC3 to have created the account");
  await ctx.goto("/signup");
  await ctx.page.type("#displayName", `${process.env.E2E_RUN_ID} Test Account One`);
  await ctx.page.type("#email", signup.email);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/signup'] button[type='submit']")]);
  has(await ctx.text(), /Check your inbox/);
});

s.test("AC-FR1 FR check (sign-up): the sign-up page is in French", { anon: true, lang: "fr" }, async (ctx) => {
  await ctx.goto("/signup");
  const text = await ctx.text();
  for (const re of [/Créer votre compte/, /Nom/, /E-mail/, /Créer mon compte/]) has(text, re);
});

// ---- 2B. Wrong password, lockout, forgot and reset ----

s.test("AC9 (must) a wrong password and an unknown email give the same message", { anon: true, needs: ["account"] }, async (ctx) => {
  // One wrong attempt on the test account (the lock needs 5); the next right login clears it.
  const tries = [[accountCreds().email, `Wrong-${crypto.randomBytes(6).toString("hex")}!1`], [cfg.testEmail("nobody"), "Wrong-Password-1!"]];
  const seen = [];
  for (const [email, password] of tries) {
    await ctx.goto("/login");
    await ctx.page.type("form[action='/login'] #email", email);
    await ctx.page.type("form[action='/login'] #password", password);
    await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/login'] button[type='submit']")]);
    seen.push(await ctx.page.$eval(".error-box", (e) => e.textContent.trim()));
  }
  assert.equal(seen[0], "Incorrect email or password.");
  assert.equal(seen[1], seen[0]);
});

s.manual("AC10 five wrong passwords lock the account for 15 minutes", "would lock the test account for 15 minutes and break the rest of the run; use a throwaway account by hand");

s.test("AC11 (must) forgot password gives the same message for an address with no account", { anon: true }, async (ctx) => {
  await ctx.goto("/login");
  await ctx.page.click("a[href='/forgot-password']");
  await ctx.page.waitForSelector("form[action='/forgot-password']");
  await ctx.page.type("form[action='/forgot-password'] input[name='email']", cfg.testEmail("no-account"));
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/forgot-password'] button[type='submit']")]);
  has(await ctx.text(), /If an account exists for that email, we've sent a password reset link|we.ve sent a password reset link/);
});

s.manual("AC11b the reset email, its link and setting a new password", "needs the emailed link");

s.manual("AC12 using the same reset link twice", "needs the emailed link");

// ---- 2C. My account, book requests, password, favorites ----

s.test("AC13 (must) My Account shows orders, two-step, privacy and book requests", { as: "account" }, async (ctx) => {
  await ctx.goto("/account");
  const text = await ctx.text();
  for (const re of [/My Account/, /Orders/, /Two-step verification/, /Privacy: download or delete my data/, /My book requests/]) has(text, re);
});

s.manual("AC14 cancel a book request from My Account and ask for another", "needs a confirmed book request, which needs an emailed link");

s.test("AC15 a wrong current password is refused when changing the password", { as: "account" }, async (ctx) => {
  // Only the refusal is tested: changing the password would break the next run.
  await ctx.goto("/account/password");
  const fields = await ctx.page.$$eval("form[action='/account/password'] input[type='password']", (i) => i.map((x) => x.name));
  assert.ok(fields.length >= 2, `password fields: ${fields}`);
  const bad = `Wrong-${crypto.randomBytes(6).toString("hex")}!1`;
  const next = `Next-${crypto.randomBytes(6).toString("hex")}!1`;
  await ctx.page.$eval("form[action='/account/password']", (f, bad2, next2) => {
    const inputs = [...f.querySelectorAll("input[type='password']")];
    inputs[0].value = bad2;
    inputs.slice(1).forEach((i) => { i.value = next2; });
  }, bad, next);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/account/password'] button[type='submit']")]);
  has(await ctx.text(), /current password is incorrect|incorrect/);
});

s.manual("AC15b changing the password for real and logging in again with it", "would change the test account's password, which the next run needs");

s.test("AC16 a hearted book stays in favorites in the same browser", { as: "account" }, async (ctx) => {
  const list = await e2e.books();
  if (!list.length) ctx.skip("data: no in-stock book");
  await ctx.goto(`/books/${list[0].id}`);
  await ctx.page.click(".book-detail-cover-wrap .favorite-toggle");
  await ctx.goto("/favorites", "networkidle2");
  await ctx.page.waitForFunction((t) => document.body.innerText.includes(t), {}, list[0].title);
});

// ---- 2D. Privacy page: download, delete ----

s.test("AC17 (must) Download my data returns a JSON file with the account holder's own data", { as: "account" }, async (ctx) => {
  await ctx.goto("/account/privacy");
  has(await ctx.text(), /Download my data|Confirm your email address first/);
  const result = await ctx.page.evaluate(async (password) => {
    const { token } = await (await fetch("/api/csrf-token")).json();
    const r = await fetch("/account/privacy/export", { method: "POST", body: new URLSearchParams({ _csrf: token, currentPassword: password }) });
    return { status: r.status, disposition: r.headers.get("content-disposition"), body: await r.text() };
  }, accountCreds().password);
  if (result.status === 403) ctx.skip("the account-holder test account's email is not confirmed yet");
  assert.equal(result.status, 200);
  assert.match(result.disposition || "", /umasbooks-my-data\.json/);
  const data = JSON.parse(result.body);
  assert.ok(JSON.stringify(data).includes(accountCreds().email), "the file holds the account holder's own email");
});

s.test("AC18 (must) account deletion refuses a wrong password and a missing confirmation word (nothing is deleted)", { as: "account" }, async (ctx) => {
  // NEVER submits the right password together with the confirmation word.
  await ctx.goto("/account/privacy");
  const post = (password, word) => ctx.page.evaluate(async (pw, w) => {
    const { token } = await (await fetch("/api/csrf-token")).json();
    const r = await fetch("/account/privacy/delete", { method: "POST", body: new URLSearchParams({ _csrf: token, currentPassword: pw, confirmation: w }), redirect: "manual" });
    return { status: r.status, body: r.type === "opaqueredirect" ? "" : await r.text() };
  }, password, word);
  const wrongPassword = await post(`Wrong-${crypto.randomBytes(6).toString("hex")}!1`, "x");
  assert.equal(wrongPassword.status, 401);
  has(wrongPassword.body, /Current password is incorrect/);
  const noWord = await post(accountCreds().password, "not-the-word");
  if (noWord.status === 403) ctx.skip("the account-holder test account is an admin or is unconfirmed: the deletion form says so");
  assert.equal(noWord.status, 400);
  has(noWord.body, /Type DELETE in the confirmation box/);
  await ctx.goto("/account");
  assert.equal(new URL(ctx.page.url()).pathname, "/account", "still logged in, account intact");
});

s.manual("AC18b really delete a throwaway account and check the goodbye email", "destructive and needs a mailbox; do it by hand on a throwaway account");

s.manual("AC19 an erased account no longer appears in admin Members", "needs a deleted account (AC18b)");

// ---- 2E. Language saved, emails in the chosen language ----

s.manual("AC20 (must) emails follow the language chosen on the site (reset email in FR and EN)", "needs a mailbox");

s.manual("AC21 order or request emails in French for a logged-in account holder", "needs a payment or an emailed link, and a mailbox");

const checkoutForm = (ctx) => ctx.page.$("form[action='/cart/checkout']");
async function needPayments(ctx) {
  if (ctx.preview) ctx.skip("preview mode: payments are switched off, so the checkout form does not exist");
  if (!(await checkoutForm(ctx))) ctx.skip("payments are not switched on for this site: the cart has no checkout form");
}

// ---- 2F. Buying: cart, checkout, HelloAsso (never paid), drop-in seat ----

s.test("AC22 (must) the checkout form has name, email, phone, terms checkbox with link, privacy note and Order with obligation to pay", { as: "account" }, async (ctx) => {
  const book = await stockedBook(ctx);
  await clearCart(ctx);
  await addFirstCopyToCart(ctx, book);
  await needPayments(ctx);
  const form = await ctx.page.$eval("form[action='/cart/checkout']", (f) => f.innerText);
  for (const re of [/Name/, /Email/, /Phone \(optional\)/, /terms of sale/, /right of withdrawal/, /Used books: no returns or exchanges for a change of mind in the shop/, /Order with obligation to pay/]) has(form, re);
  has(await ctx.text(), /Price incl\. tax, TVA non applicable/);
  const link = await ctx.page.$eval("form[action='/cart/checkout'] a[href='/terms-of-sale.html']", (a) => a.target);
  assert.equal(link, "_blank", "the terms open in a new tab");
  assert.ok(await ctx.page.$("form[action='/cart/checkout'] a[href='/privacy-policy.html']"), "privacy note links the policy");
});

s.test("AC23 (must) the form cannot be submitted without the terms box ticked or with a bad email", { as: "account" }, async (ctx) => {
  const book = await stockedBook(ctx);
  await clearCart(ctx);
  await addFirstCopyToCart(ctx, book);
  await needPayments(ctx);
  const before = ctx.page.url();
  await fill(ctx, "#name", `${process.env.E2E_RUN_ID} Buyer`);
  await fill(ctx, "#email", "not-an-email");
  await ctx.page.click("form[action='/cart/checkout'] button[type='submit']");
  assert.equal(ctx.page.url(), before, "the browser refused to submit");
  const hasEmailBox = Boolean(await ctx.page.$("#email"));
  let v = await ctx.page.$eval("form[action='/cart/checkout']", (f) => ({ ok: f.checkValidity(), terms: f.querySelector("[name=acceptCgv]").validity.valueMissing, email: Boolean(f.querySelector("#email") && f.querySelector("#email").validity.typeMismatch) }));
  assert.deepEqual(v, { ok: false, terms: true, email: hasEmailBox });
  await fill(ctx, "#email", testEmail("account-ac23"));
  v = await ctx.page.$eval("form[action='/cart/checkout']", (f) => ({ ok: f.checkValidity(), terms: f.querySelector("[name=acceptCgv]").validity.valueMissing }));
  assert.deepEqual(v, { ok: false, terms: true }, "with a good email, only the terms box is still missing");
  assert.deepEqual(ctx.blocked, [], "nothing was sent anywhere");
});

s.test("AC-FR22 FR check (cart): the cart and checkout form are in French", { as: "account", lang: "fr" }, async (ctx) => {
  const book = await stockedBook(ctx);
  await clearCart(ctx);
  await addFirstCopyToCart(ctx, book);
  const text = await ctx.text();
  for (const re of [/Votre panier/, /Retirer/, /Total :/]) has(text, re);
  if (ctx.preview) { has(text, /La commande en ligne ouvrira au lancement/); return; }
  if (!(await checkoutForm(ctx))) return;
  for (const re of [/Paiement/, /Nom/, /E-mail/, /Téléphone \(facultatif\)/, /J.ai lu et j.accepte les conditions de vente/, /Commander avec obligation de paiement/, /Livres d’occasion\s:\spas de reprise ni d’échange/, /Prix TTC, TVA non applicable/, /Vous paierez en toute sécurité via HelloAsso, puis vous passerez à Uma's Books pour retirer votre commande/, /À retirer sous 14 jours, du mardi au samedi, 10h–19h, rue Peyrolière, Albi/]) has(text, re);
});

s.test("AC24 (preview mode) checkout is refused by the server and never reaches HelloAsso", { as: "account" }, async (ctx) => {
  if (!ctx.preview) ctx.skip("the site is not in preview mode (see AC24 for the payments-on check)");
  const book = await stockedBook(ctx);
  await clearCart(ctx);
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

s.write("AC24 (must) with payments on, Order with obligation to pay starts a checkout that redirects to HelloAsso; the test stops there", { as: "account" }, async (ctx) => {
  if (ctx.preview) ctx.skip("preview mode: checkout is off (asserted by the preview-mode AC24 test)");
  const book = await stockedBook(ctx);
  await ctx.goto(`/books/${book.id}`);
  const copiesBefore = (await ctx.page.$$(".copy-table tbody tr")).length;
  await clearCart(ctx);
  await addFirstCopyToCart(ctx, book);
  await needPayments(ctx);
  const tag = process.env.E2E_RUN_ID;
  const email = testEmail("account-ac24");
  await fill(ctx, "#name", `${tag} Test Buyer`);
  await fill(ctx, "#email", email);
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

s.test("AC25 (must) a book held by an unpaid checkout is no longer for sale to someone else", { as: "account" }, async (ctx) => {
  if (!held) ctx.skip("needs the payments-on checkout test AC24 (with E2E_ALLOW_WRITES=1) to have started a hold first");
  await ctx.goto(`/books/${held.bookId}`);
  const after = (await ctx.page.$$(".copy-table tbody tr")).length;
  assert.equal(after, held.copiesBefore - 1, "the held copy left the table");
});

s.manual("AC26 pay with the HelloAsso test card and land on the Thank you page", "the tests never enter payment details or load a HelloAsso page");

s.manual("AC27 order confirmation email (English): order number, items, collection, legal blocks", "needs a paid order and a readable mailbox");

s.manual("AC28 order confirmation email (French) and the whole AC22 to AC27 flow in French", "needs a paid order and a readable mailbox");

s.manual("AC29 refreshing the Thank you page and opening it in a second browser", "needs a paid order (the unguessable return link)");

s.manual("AC30 admin sees the paid order and the books leave the shelves", "needs a paid order; the pending-order side is covered by A24a");

s.manual("AC31 pickup: show the confirmation email, a volunteer hands over the books", "a human at the shop");

s.test("AC32 the Terms of Sale say to collect within 14 days of payment (EN and FR)", { as: "account" }, async (ctx) => {
  await ctx.goto("/terms-of-sale.html");
  has(await ctx.text(), /Please collect within 14 days of payment; if you need longer, write to us/);
  await ctx.setLang("fr");
  await ctx.goto("/terms-of-sale.html");
  has(await ctx.text(), /14 jours/);
});

async function addDropin(ctx) {
  await clearCart(ctx);
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
  // The session holding the cart is saved a moment after the redirect: look again before giving up.
  for (let i = 0; i < 4 && !(await ctx.page.$(".cart-item")); i++) {
    await new Promise((r) => setTimeout(r, 500));
    await ctx.page.reload({ waitUntil: "domcontentloaded" });
  }
}

s.test("AC33 (must) a drop-in seat can be added to the cart from the sessions page", { as: "account" }, async (ctx) => {
  await addDropin(ctx);
  const text = await ctx.page.$eval(".cart-item", (e) => e.innerText);
  has(text, /Session/);
  has(text, /Drop-in seat/);
  has(text, /€\d+\.\d\d/);
});

s.test("AC34 (must) a cart with a drop-in seat has the extra waiver checkbox, required", { as: "account" }, async (ctx) => {
  await addDropin(ctx);
  await needPayments(ctx);
  const required = await ctx.page.$eval("input[name='waiveWithdrawal']", (i) => i.required);
  assert.equal(required, true);
  const label = await ctx.page.$eval("input[name='waiveWithdrawal']", (i) => i.parentElement.innerText);
  has(label, /I ask for the session\(s\) to take place on the date booked/);
  has(label, /right of withdrawal does not apply/);
});

s.manual("AC35 pay for a drop-in seat and check the confirmation email", "needs a payment and a mailbox");

s.manual("AC36 one place fewer on /sessions after a paid seat", "needs a paid seat");

s.manual("AC37 admin sees the paid drop-in buyer under the session", "needs a paid seat");

s.test("AC-FR34 FR check: the drop-in waiver reads in French", { as: "account", lang: "fr" }, async (ctx) => {
  await addDropin(ctx);
  await needPayments(ctx);
  has(await ctx.page.$eval("input[name='waiveWithdrawal']", (i) => i.parentElement.innerText), /Je demande que la ou les séances aient lieu à la date réservée/);
});

s.manual("AC38 abandon at the HelloAsso page and come back", "needs the HelloAsso page");

s.manual("AC39 buying again straight away with the same email", "would create a second unpaid order that holds more books; protection against hoarding is covered by the app's own tests");

s.manual("AC40 wait about 70 minutes for the hold to expire", "needs real time to pass (the expiry job runs every 10 minutes)");

s.manual("AC41 someone else takes your book while it is in your cart", "needs a second buyer completing a payment");

s.manual("AC42 back button after paying", "needs a payment");

// The things a cart must survive, checked without paying.

// ---- 2G. Two-step verification for an ordinary account ----

s.write("AC43 the two-step page offers set-up to an account holder (it is not only for admins)", { as: "account" }, async (ctx) => {
  // Opening the page stores a pending secret on the account; nothing is turned on.
  await ctx.goto("/account/2fa");
  if (await ctx.page.$("form[action='/account/2fa/recovery-codes']")) ctx.skip("two-step is already on for the account-holder test account: not touching it");
  has(await ctx.text(), /Set up two-step verification/);
  assert.ok(await ctx.page.$("img[alt*='QR']"), "QR code");
  assert.ok(await ctx.page.$("form[action='/account/2fa/enable'] #password"), "password box");
  assert.ok(await ctx.page.$("form[action='/account/2fa/enable'] #code"), "code box");
  hasNot(await ctx.text(), /Admin accounts must use two-step verification/);
});
s.manual("AC43b turn two-step on with an authenticator app, log in with a code, then turn it off again", "needs an authenticator app; it would also make the test login ask for a code on the next run");

// ---- 2H. Member-only pages are NOT shown to an account holder ----
//
// What the site does today (src/middleware/auth.js requireMember, routes/dashboard.js):
// a logged-in account that is not a member, volunteer or admin is sent to the
// home page ("/") from /dashboard, /announcements, /forum*, /meetings*, and
// /volunteer. /charity is the one exception: a vote set to "visible to
// everyone" can be read, but voting and suggesting are still refused.

const MEMBER_CONTENT = [/Welcome back/i, /Start a thread/i, /Add a reply/i, /I.ll be there/i, /Submit My Votes/i, /Suggest a Charity/i, /View All Announcements/i];

async function refusedForNonMember(ctx, p) {
  const raw = await ctx.fetchRaw(p);
  assert.ok([301, 302, 303, 307].includes(raw.status), `${p} answered ${raw.status}, expected a redirect (member content must not be shown)`);
  assert.equal(new URL(raw.headers.get("location") || "", ctx.base).pathname, "/", `${p} should send an account holder to the home page`);
  await ctx.goto(p);
  assert.equal(new URL(ctx.page.url()).pathname, "/", `${p}: the browser should end on the home page`);
  const text = await ctx.text();
  for (const re of MEMBER_CONTENT) hasNot(text, re, `${p} ended on the home page, which must show no member content`);
}

s.test("AC44 (must) /dashboard (Member's Access) sends an account holder to the home page and shows no member content", { as: "account" }, async (ctx) => {
  await refusedForNonMember(ctx, "/dashboard");
});

s.test("AC45 (must) /announcements is refused to an account holder", { as: "account" }, async (ctx) => {
  await refusedForNonMember(ctx, "/announcements");
});

s.test("AC46 (must) the forum (list, new thread) is refused to an account holder, and so is posting", { as: "account" }, async (ctx) => {
  await refusedForNonMember(ctx, "/forum");
  await refusedForNonMember(ctx, "/forum/new");
  // Empty fields on purpose: if a bug let this through it would be a validation error, not a post.
  const type = await ctx.page.evaluate(async () => {
    const { token } = await (await fetch("/api/csrf-token")).json();
    const r = await fetch("/forum/new", { method: "POST", body: new URLSearchParams({ _csrf: token, title: "", body: "" }), redirect: "manual" });
    return { type: r.type, status: r.status };
  });
  assert.equal(type.type, "opaqueredirect", `posting to the forum answered ${type.status}, expected a redirect away`);
});

s.test("AC47 (must) the meetings calendar and RSVP are refused to an account holder", { as: "account" }, async (ctx) => {
  await refusedForNonMember(ctx, "/meetings");
});

s.test("AC48 (must) the charity page shows no vote or suggestion form to an account holder, and voting is refused", { as: "account" }, async (ctx) => {
  await ctx.goto("/charity");
  const where = new URL(ctx.page.url()).pathname;
  assert.ok(where === "/" || where === "/charity", `sent to ${where}`);
  if (where === "/charity") {
    // The open vote is set to "visible to everyone": it may be read, never used.
    assert.equal(await ctx.page.$("form[action='/charity/vote']"), null, "no vote form");
    assert.equal(await ctx.page.$("form[action='/charity/ideas']"), null, "no suggestion form");
  } else {
    for (const re of MEMBER_CONTENT) hasNot(await ctx.text(), re);
  }
  const vote = await ctx.page.evaluate(async () => {
    const { token } = await (await fetch("/api/csrf-token")).json();
    const r = await fetch("/charity/vote", { method: "POST", body: new URLSearchParams({ _csrf: token, optionIds: "0" }), redirect: "manual" });
    return { type: r.type, status: r.status };
  });
  assert.equal(vote.type, "opaqueredirect", `voting answered ${vote.status}, expected a redirect away`);
});

s.test("AC49 the volunteer shifts page is refused to an account holder", { as: "account" }, async (ctx) => {
  await refusedForNonMember(ctx, "/volunteer");
});

s.test("AC50 the key icon (Member's Access) leads an account holder to the home page, not to member content", { as: "account" }, async (ctx) => {
  await ctx.goto("/", "networkidle2");
  assert.equal(new URL(ctx.page.url()).pathname, "/", "an account holder who is not a member stays on the home page");
  const key = await ctx.page.$("a.h-tool[href='/dashboard']");
  if (key) {
    await Promise.all([ctx.page.waitForNavigation(), key.click()]);
    assert.equal(new URL(ctx.page.url()).pathname, "/");
  }
  for (const re of MEMBER_CONTENT) hasNot(await ctx.text(), re);
  assert.ok(await ctx.page.$("form[action='/logout'] button"), "still logged in");
});

// ---- 2K. The membership page for an account holder ----
//
// Becoming a member needs an account (pull request #201).

async function membershipPage(ctx) {
  if (ctx.preview) ctx.skip("preview mode: the membership page only says 'Membership opens at launch'");
  await ctx.goto("/membership.html");
}

s.test("AC51 (must) the membership page shows an account holder only the payment form, with the account's email, and no sign-up form", { as: "account" }, async (ctx) => {
  await membershipPage(ctx);
  assert.equal(await ctx.page.$("form[action='/membership/join']"), null, "no sign-up form for a logged-in account");
  assert.ok(await ctx.page.$("#haWidget"), "the payment form");
  const note = await ctx.page.$eval("#memAccountEmail", (e) => e.innerText);
  assert.ok(note.includes(accountCreds().email), "the account's own email is shown");
  assert.ok(await ctx.page.$("form[action='/membership/check'] button"), "the Check my membership button");
});

s.test("AC52 a membership sign-up request from a logged-in account does nothing", { as: "account" }, async (ctx) => {
  await membershipPage(ctx);
  const res = await ctx.page.evaluate(async () => {
    const { token } = await (await fetch("/api/csrf-token")).json();
    const r = await fetch("/membership/join", { method: "POST", redirect: "manual", body: new URLSearchParams({ _csrf: token, displayName: "E2E", email: "e2e+nothing@example.invalid" }) });
    return { type: r.type, status: r.status };
  });
  assert.equal(res.type, "opaqueredirect", `answered ${res.status}, expected a redirect back to the membership page`);
  await ctx.goto("/membership.html");
  assert.equal(await ctx.page.$("#memJoinedEmail"), null, "no payment-after-sign-up step was started");
  assert.ok(await ctx.page.$("form[action='/membership/check']"), "still the logged-in view");
});

s.test("AC53 (must) 'Check my membership' answers with a clear message (no payment was made, so it must not say found)", { as: "account" }, async (ctx) => {
  await membershipPage(ctx);
  const btn = await ctx.page.$("form[action='/membership/check'] button");
  assert.ok(btn, "the Check my membership button");
  await Promise.all([ctx.page.waitForNavigation(), btn.click()]);
  const text = await ctx.text();
  has(text, /We have not found your payment yet|We could not check right now|Please confirm your email address first/);
  hasNot(text, /Membership found/);
});

s.manual("AC54 (must) after a real payment, Check my membership finds it at once", "needs a real HelloAsso payment; the tests never pay");
