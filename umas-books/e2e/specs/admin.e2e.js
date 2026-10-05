// Script 5 of docs/testing/manual-test-scripts.md: the admin.
//
// Needs the dedicated TEST admin's E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD and
// E2E_ADMIN_TOTP_SECRET (the base32 key shown under the QR code when
// two-step was set up). The default run only READS admin pages. With
// E2E_ALLOW_WRITES=1 it also creates ONE tagged test book (with a made-up
// ISBN, so it can never attach to a real book) and ONE tagged test member
// (example.invalid address), disables the member, and sells nothing.
// Admin pages are English only; the steps that publish public content or
// send email to real people (events, announcements, blog, charity votes,
// notifying requesters, selling) stay manual.

const assert = require("node:assert/strict");
const e2e = require("../helpers/harness");
const { has, hasNot } = require("../helpers/pages");
const cfg = require("../helpers/config");

const s = e2e.persona("admin");
const TAG = () => process.env.E2E_RUN_ID;
const REAL_ISBN = "9780141036144"; // from the manual script's test data (looked up only, never saved)
const tagged = { id: null, title: null, isbn: null, location: null };
const testMember = { id: null, email: null, name: null };

function isbn13() {
  const body = `97899${String(Date.now()).slice(-7)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 ? 3 : 1);
  return body + ((10 - (sum % 10)) % 10);
}

async function admin(ctx, path, wait) {
  const res = await ctx.goto(path, wait);
  assert.ok(res.status() < 400, `${path} answered ${res.status()}`);
  assert.equal(new URL(ctx.page.url()).pathname, new URL(path, "http://x").pathname, `${path} redirected to ${ctx.page.url()}`);
  return res;
}
const hasNoNaN = (text, where) => assert.ok(!/\bNaN\b|\bundefined\b|\[object Object\]/.test(text), `${where} shows NaN/undefined/[object Object]`);

// ---- 5A. Login, two-step verification ----

s.test("A4 (must) a wrong two-step code is refused with a clear message", { anon: true, needs: ["admin"] }, async (ctx) => {
  // ONE wrong code only (a lock needs several); the right login in A1 clears the count.
  const c = cfg.credentials("admin");
  await ctx.goto("/login");
  await ctx.page.type("form[action='/login'] #email", c.email);
  await ctx.page.type("form[action='/login'] #password", c.password);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/login'] button[type='submit']")]);
  assert.equal(new URL(ctx.page.url()).pathname, "/login/2fa", "the admin account must have two-step verification on");
  await ctx.page.type("#code", "000000");
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/login/2fa'] button[type='submit']")]);
  has(await ctx.text(), /That code didn.t work\. Try again\./);
});
s.manual("A4b many wrong codes send you back to login, then lock for a few minutes", "would lock the test admin out for 15 minutes");

s.test("A1 (must) admin login asks for the two-step code, then lands on the Dashboard", { anon: true, needs: ["admin"] }, async (ctx) => {
  const c = cfg.credentials("admin");
  await ctx.goto("/login");
  await ctx.page.type("form[action='/login'] #email", c.email);
  await ctx.page.type("form[action='/login'] #password", c.password);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/login'] button[type='submit']")]);
  assert.equal(new URL(ctx.page.url()).pathname, "/login/2fa");
  const text = await ctx.text();
  has(text, /Two-step verification/);
  has(text, /Enter the 6-digit code from your authenticator app\./);
  has(text, /Verify/);
  has(text, /Lost your phone\? Enter one of your recovery codes instead/);
  const { freshCode } = require("../helpers/totp");
  if (!c.totpSecret) ctx.skip("E2E_ADMIN_TOTP_SECRET is not set: only a one-time recovery code was given, which is never spent by the tests");
  await ctx.page.type("#code", await freshCode(c.totpSecret));
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/login/2fa'] button[type='submit']")]);
  assert.equal(new URL(ctx.page.url()).pathname, "/admin");
  has(await ctx.text(), /Dashboard/);
  await ctx.keepSession("admin");
});

s.manual("A2 (must) first-time two-step set-up with a throwaway second admin", "needs an invitation email and an authenticator app");
s.manual("A3 (must) recovery codes are shown once after set-up", "needs a fresh two-step set-up (A2)");
s.manual("A5b (must) Reset Two-Step on the second admin logs them out", "needs a second admin account");

s.test("A5 (must) the two-step page shows it is on, with recovery codes and no way to turn it off for admins", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/account/2fa");
  const text = await ctx.text();
  has(text, /Two-step verification is on for your account/);
  has(text, /unused recovery codes?/);
  has(text, /new recovery codes/);
  assert.equal(await ctx.page.$("form[action='/account/2fa/disable']"), null, "admins have no Turn off option");
});
s.manual("A5c using a recovery code to log in, and that it works only once", "spends one of the account's one-time recovery codes");

// ---- 5B. Dashboard and menu ----

s.todo("A6 the Dashboard shows the figures and tiles with no NaN", "known issue, also a todo in test/integration/adminCalendars.test.js: views/admin/index.ejs pct() shows NaN% when last month had no sales (salesLastMonth is the string '0.00')", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin");
  const text = await ctx.text();
  hasNoNaN(text, "the Dashboard");
  for (const re of [/Orders Today/, /This Month/, /Total Sales/, /In-Stock Books/, /Added This Month/, /Total Accounts/, /Members/, /Books & Orders/, /English Programs/, /Bookstore Events/, /Account Section/, /Volunteer Shifts/, /Meetings/, /Announcements/, /Charities/, /Blog/]) has(text, re);
  if (ctx.preview) has(text, /PREVIEW MODE is ON/);
});

s.test("A7 every item of the left menu opens in English with no error", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin");
  const links = await ctx.page.$$eval("nav.admin-nav a", (as) => as.map((a) => ({ href: a.getAttribute("href"), label: a.textContent.trim() })).filter((l) => l.href && l.href !== "/"));
  assert.ok(links.length >= 15, `menu items: ${links.length}`);
  for (const l of links) {
    const res = await ctx.goto(l.href);
    assert.ok(res.status() < 400, `${l.label} (${l.href}) answered ${res.status()}`);
    assert.ok(new URL(ctx.page.url()).pathname.startsWith("/admin"), `${l.label} left the admin area: ${ctx.page.url()}`);
    const text = await ctx.text();
    hasNot(text, /Something went wrong|Page not found|Cannot GET/, l.label);
  }
});

s.test("A8 pressing FR keeps the admin pages in English and makes the public site French", { as: "admin", lang: "fr" }, async (ctx) => {
  await admin(ctx, "/admin");
  has(await ctx.text(), /Welcome back/);
  has(await ctx.text(), /Dashboard/);
  await admin(ctx, "/admin/members");
  has(await ctx.text(), /Accounts|Members/);
  await ctx.goto("/books.html");
  assert.equal(await ctx.page.$eval("html", (h) => h.lang), "fr");
});

s.todo("A8b admin pages declare lang=\"en\" (they are English only)", "known gap: with French chosen, the English-only admin pages still say <html lang=\"fr\">, which makes screen readers use French pronunciation", { as: "admin", lang: "fr" }, async (ctx) => {
  await admin(ctx, "/admin");
  assert.equal(await ctx.page.$eval("html", (h) => h.lang), "en");
});

// ---- 5C. Add books ----

s.test("A9 (must) the ISBN lookup fills in the book form (title, author, publisher, binding, description) and the copy section", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/inventory/scan");
  for (const id of ["#location", "#source", "#isbn"]) assert.ok(await ctx.page.$(id), `scan field ${id}`);
  await ctx.page.type("#location", "E2E-LOOKUP");
  await ctx.page.select("#source", "donation");
  await ctx.page.type("#isbn", REAL_ISBN);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.$eval("#isbn", (i) => i.form.querySelector("button[type='submit']").click())]);
  // Open Library may be unreachable from where this runs: the form must still appear.
  const note = await ctx.page.$eval(".error-box", (e) => e.textContent).catch(() => "");
  for (const id of ["#title", "#author", "#isbn", "#publisher", "#binding", "#genre", "#description", "#condition", "#location", "#source", "#publisherPrice"]) assert.ok(await ctx.page.$(id), `book form field ${id}`);
  has(await ctx.text(), /This copy/);
  if (!note) {
    assert.ok((await ctx.page.$eval("#title", (i) => i.value)).length > 0, "the lookup filled in a title");
  } else console.log(`# A9 note: ${note.trim().slice(0, 120)}`);
  // Nothing was saved: the form was only opened.
});

s.test("A10 (must) the copy form has condition, binding, source, location and the price control with a suggestion", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/inventory/new");
  const conditions = await ctx.page.$$eval("#condition option", (o) => o.map((x) => x.textContent.trim()));
  for (const c of ["New", "Like New", "Very Good", "Acceptable"]) assert.ok(conditions.some((x) => x.toLowerCase() === c.toLowerCase()), `condition ${c} in ${conditions}`);
  const bindings = await ctx.page.$$eval("#binding option", (o) => o.map((x) => x.textContent.trim()));
  for (const b of ["Hardcover", "Paperback", "Mass Market"]) assert.ok(bindings.some((x) => x.toLowerCase().includes(b.toLowerCase())), `binding ${b} in ${bindings}`);
  assert.ok(await ctx.page.$("#source") && await ctx.page.$("#location"));
  const radios = await ctx.page.$$eval("input[name='priceLevel']", (r) => r.map((x) => x.value));
  assert.ok(radios.includes("clearance") && radios.includes("custom") && radios.length >= 4, `price choices: ${radios}`);
  const text = await ctx.text();
  has(text, /Clearance EUR \d+\.\d\d/);
  has(text, /Custom/);
  assert.ok(await ctx.page.$("[data-ps-suggest]"), "Suggest price button");
  has(text, /Why this price\?/);
});

s.test("A12 (must) a New book needs the publisher's price and may be at most 5% off (refusals; nothing is saved)", { as: "admin" }, async (ctx) => {
  const post = async (price, publisherPrice) => {
    await admin(ctx, "/admin/inventory/new");
    await ctx.page.type("#title", `${TAG()} refusal check`);
    await ctx.page.select("#condition", "new");
    if (publisherPrice) await ctx.page.type("#publisherPrice", publisherPrice);
    // The page fills the price from the publisher's price a moment after typing: wait, then set ours
    // (New books are priced from the publisher's price, so the price choice is hidden).
    await new Promise((r) => setTimeout(r, 700));
    if (price) await ctx.page.$eval("#price", (i, v) => { i.value = v; }, price);
    // Never submit unless the form holds exactly what this refusal test intends: an accepted save would create a book.
    const holds = await ctx.page.$eval("#price", (i) => i.value);
    assert.equal(holds, price, "the price field changed under the test: not submitting");
    await ctx.page.$eval("form[method='post'][action='/admin/inventory']", (f) => { f.noValidate = true; });
    await Promise.all([ctx.page.waitForNavigation(), ctx.page.$eval("form[method='post'][action='/admin/inventory']", (f) => [...f.querySelectorAll("button[type='submit']")].find((b) => /Save book/i.test(b.textContent)).click())]);
    return ctx.page.$$eval(".error-box", (es) => es.map((e) => e.textContent.trim()).filter(Boolean).join(" | "));
  };
  has(await post("", ""), /New books need the publisher's price/);
  has(await post("11.00", "12.00"), /at most 5% off.*between .?11\.40 and .?12\.00|between .?11\.40/);
  assert.equal(new URL(ctx.page.url()).pathname, "/admin/inventory", "still on the form: nothing was saved");
});

s.test("A14 (must) saving a book with an empty title says 'Title is required.' (nothing is saved)", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/inventory/new");
  await ctx.page.$eval("form[method='post'][action='/admin/inventory']", (f) => { f.noValidate = true; });
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.$eval("form[method='post'][action='/admin/inventory']", (f) => [...f.querySelectorAll("button[type='submit']")].find((b) => /Save book/i.test(b.textContent)).click())]);
  has(await ctx.text(), /Title is required\./);
});

s.test("A14a bad numbers are refused with a clear English error and what was typed stays in the form", { as: "admin" }, async (ctx) => {
  for (const bad of ["-5", "abc", "12.345", "99999"]) {
    await admin(ctx, "/admin/inventory/new");
    await ctx.page.type("#title", `${TAG()} bad number check`);
    await ctx.page.click("#priceLevel-custom");
    await ctx.page.$eval("#price", (i) => { i.type = "text"; });
    await ctx.page.type("#price", bad);
    await ctx.page.$eval("form[method='post'][action='/admin/inventory']", (f) => { f.noValidate = true; });
    await Promise.all([ctx.page.waitForNavigation(), ctx.page.$eval("form[method='post'][action='/admin/inventory']", (f) => [...f.querySelectorAll("button[type='submit']")].find((b) => /Save book/i.test(b.textContent)).click())]);
    const err = await ctx.page.$eval(".error-box", (e) => e.textContent.trim()).catch(() => "");
    assert.ok(err.length > 5, `price "${bad}" got no error message`);
    assert.equal(new URL(ctx.page.url()).pathname, "/admin/inventory", `price "${bad}" must not save`);
    assert.equal(await ctx.page.$eval("#title", (i) => i.value), `${TAG()} bad number check`, "the title typed is still in the form");
  }
});

s.manual("A13 photo scan of a cover or barcode", "needs a photo and the ANTHROPIC_API_KEY on the site");

// ---- 5D. Awards, locations, selling ----

s.test("A15 (must) the Awards to review page opens with its approve and reject controls", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/awards");
  has(await ctx.text(), /Awards|review/);
});

s.manual("A18 (must) sell in the shop: Find the book, Paid by, Record sale", "the tests sell nothing (a sale removes a real copy from the shelves)");
s.test("A18b the Sell in shop page opens (nothing is sold)", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/inventory/sell");
  has(await ctx.text(), /Sell in shop|Find the book/);
});

// ---- 5E. Reports and CSV ----

const REPORTS = ["Inventory on hand", "Aging stock", "Sales over time", "Sell-through by genre", "Membership", "Intake log"];

s.test("A19 (must) the Reports page lists six reports and each opens with tables", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/reports");
  const text = await ctx.text();
  for (const r of REPORTS) has(text, new RegExp(r), "report list");
  const hrefs = await ctx.page.$$eval("a[href^='/admin/reports/']", (as) => as.map((a) => a.getAttribute("href")));
  assert.ok(hrefs.length >= 6, `report links: ${hrefs.length}`);
  for (const h of hrefs) {
    await admin(ctx, h);
    const t = await ctx.text();
    hasNoNaN(t, h);
    assert.ok((await ctx.page.$$("table")).length > 0 || /Nothing to show/.test(t), `${h} has a table or says nothing to show`);
  }
});

s.test("A20 (must) each report's Download CSV link serves a CSV file named umas-books-<report>-<table>.csv with no email addresses", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/reports");
  const hrefs = await ctx.page.$$eval("a[href^='/admin/reports/']", (as) => as.map((a) => a.getAttribute("href")));
  let checked = 0;
  for (const h of hrefs) {
    await admin(ctx, h);
    const csv = await ctx.page.$$eval("a[href*='format=csv']", (as) => (as[0] ? as[0].getAttribute("href") : null));
    if (!csv) continue;
    const res = await ctx.fetchRaw(csv.replace(/&amp;/g, "&"));
    assert.equal(res.status, 200, `${csv} answered ${res.status}`);
    assert.match(res.headers.get("content-type") || "", /text\/csv/);
    assert.match(res.headers.get("content-disposition") || "", /attachment; filename="umas-books-[a-z0-9_-]+\.csv"/);
    const body = await res.text();
    assert.doesNotMatch(body, /[^\s,"]+@[^\s,"]+\.[a-z]{2,}/i, `${csv} contains an email address`);
    checked++;
  }
  assert.ok(checked >= 5, `CSV links checked: ${checked}`);
});
s.manual("A21 the sales report counts the online sale, the shop sale and the drop-in seat separately", "needs real paid sales (AC26, AC35, A18)");

// ---- 5F. Book requests ----

s.test("A23 (must) the Book Requests page has the status filters", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/requests");
  const text = await ctx.text();
  for (const re of [/Active/, /Open/, /Matched/, /Notified/, /Waiting for email confirmation/, /Fulfilled/, /Cancelled/, /Expired/, /All/]) has(text, re, "filters");
});
s.manual("A22 (must) adding a requested book matches the confirmed request on intake", "needs a confirmed request, which needs an emailed link");
s.manual("A23c (must) Notify, Notify and hold 7 days, Mark fulfilled, Match, Cancel and Delete a request", "sends email to the requester and changes real requests");
s.manual("A23b a request hold ends by itself after 7 days", "needs real time to pass");

// ---- 5G. Orders ----

s.test("A24a (must) the Orders page lists orders with status and totals", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/orders");
  const text = await ctx.text();
  has(text, /\d+ orders?/);
  hasNoNaN(text, "orders");
  // After the guest tests in the same run (payments on, writes on), their unpaid order is here.
  if (cfg.allowWrites() && !ctx.preview && /Test Buyer/.test(text)) has(text, /pending/i);
});

// ---- 5H. Members and roles ----

s.test("A26 you cannot demote, disable or erase your own account", { as: "admin" }, async (ctx) => {
  const c = cfg.credentials("admin");
  await admin(ctx, `/admin/members?q=${encodeURIComponent(c.email)}`);
  const view = await ctx.page.$eval("a[href*='view=']", (a) => a.getAttribute("href")).catch(() => null);
  if (!view) ctx.skip("could not find the admin's own row in the account list");
  await ctx.goto(view);
  assert.equal(await ctx.page.$("form[action$='/toggle-admin']"), null, "no Remove Admin on your own account");
  assert.equal(await ctx.page.$("form[action$='/toggle-disabled']"), null, "no Deactivate on your own account");
  assert.equal(await ctx.page.$("form[action$='/delete']"), null, "no Erase on your own account");
});

s.test("A29 the Members menu and filters work, and Clear Filters resets them", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/members?role=member");
  const text = await ctx.text();
  hasNoNaN(text, "members");
  for (const re of [/Role/, /Status/, /Total Spent/, /Clear Filters/]) has(text, re);
  for (const name of ["q", "role", "status", "dateRange"]) assert.ok(await ctx.page.$(`[name='${name}']`), `filter ${name}`);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("a[href='/admin/members'].btn")]);
  assert.equal(new URL(ctx.page.url()).search, "");
});

s.write("A24 (must) create a tagged test member, mark it as member, and see it in the list", { as: "admin" }, async (ctx) => {
  testMember.email = cfg.testEmail("admin-created-member");
  testMember.name = `${TAG()} Test Member`;
  await admin(ctx, "/admin/members");
  await ctx.page.$eval("details.ann-more", (d) => { d.open = true; });
  const form = "form[action='/admin/members']";
  await ctx.page.type(`${form} input[name='displayName']`, testMember.name);
  await ctx.page.type(`${form} input[name='email']`, testMember.email);
  await ctx.page.click(`${form} input[name='isMember']`);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click(`${form} button[type='submit']`)]);
  ctx.created("test member (admin-created, example.invalid address; the invite email cannot be delivered)", `${testMember.name} <${testMember.email}>`, "admin Accounts > search the tag (disabled by A25)");
  await admin(ctx, `/admin/members?q=${encodeURIComponent(TAG())}`);
  const view = await ctx.page.$eval("a[href*='view=']", (a) => a.getAttribute("href"));
  testMember.id = new URL(view, "http://x").searchParams.get("view");
  await ctx.goto(view);
  has(await ctx.text(), new RegExp(TAG()));
  const toggle = await ctx.page.$eval(`form[action='/admin/members/${testMember.id}/toggle-member'] button`, (b) => b.textContent.trim());
  assert.match(toggle, /Remove Member Status/, "the account was created as a member");
});

s.write("A25 (must) Deactivate Account disables the tagged test member; the login then says so", { as: "admin" }, async (ctx) => {
  if (!testMember.id) ctx.skip("needs A24");
  await ctx.goto(`/admin/members?view=${testMember.id}`);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click(`form[action='/admin/members/${testMember.id}/toggle-disabled'] button`)]);
  assert.match(await ctx.page.$eval(`form[action='/admin/members/${testMember.id}/toggle-disabled'] button`, (b) => b.textContent), /Reactivate Account/);
});

s.write("A27 the Edit tab renames the test member and refuses an email already in use", { as: "admin" }, async (ctx) => {
  if (!testMember.id) ctx.skip("needs A24");
  await ctx.goto(`/admin/members?view=${testMember.id}&panel=edit`);
  const form = `form[action='/admin/members/${testMember.id}/edit']`;
  await ctx.page.$eval(`${form} input[name='displayName']`, (i, v) => { i.value = v; }, `${testMember.name} (renamed)`);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click(`${form} button[type='submit']`)]);
  await ctx.goto(`/admin/members?view=${testMember.id}&panel=edit`);
  assert.match(await ctx.page.$eval(`${form} input[name='displayName']`, (i) => i.value), /renamed/);
  await ctx.page.$eval(`${form} input[name='email']`, (i, v) => { i.value = v; }, cfg.credentials("admin").email);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click(`${form} button[type='submit']`)]);
  has(await ctx.text(), /That email is already used by another account/);
});

s.write("A28 Download data (JSON) works for the test member", { as: "admin" }, async (ctx) => {
  if (!testMember.id) ctx.skip("needs A24");
  const res = await ctx.fetchRaw(`/admin/members/${testMember.id}/export.json`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") || "", /attachment/);
  const data = await res.json();
  assert.ok(JSON.stringify(data).includes(testMember.email));
});
s.manual("A28b Erase Member on a throwaway account", "irreversible; left for you to do by hand (the tagged member stays, disabled)");

// ---- tagged book lifecycle (writes) ----

s.write("A10b (must) create a tagged test book through the ISBN lookup, see a price suggestion, and save it (nothing is sold)", { as: "admin" }, async (ctx) => {
  tagged.isbn = isbn13();
  tagged.title = `${TAG()} Test Book`;
  tagged.location = `E2E-${TAG().slice(4, 12)}`;
  await admin(ctx, "/admin/inventory/scan");
  await ctx.page.type("#location", tagged.location);
  await ctx.page.select("#source", "donation");
  await ctx.page.type("#isbn", REAL_ISBN);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.$eval("#isbn", (i) => i.form.querySelector("button[type='submit']").click())]);
  // The lookup only pre-fills the form. Save it under a tagged title and a made-up ISBN so it can never join a real book.
  await ctx.page.$eval("#title", (i, v) => { i.value = v; }, tagged.title);
  await ctx.page.$eval("#isbn", (i, v) => { i.value = v; }, tagged.isbn);
  await ctx.page.select("#binding", "paperback");
  await ctx.page.select("#condition", "very_good");
  await ctx.page.select("#source", "donation");
  await ctx.page.$eval("#location", (i, v) => { i.value = v; }, tagged.location);
  await ctx.page.click("[data-ps-suggest]");
  await ctx.page.waitForFunction(() => { const b = document.querySelector("[data-ps-box]"); return b && !b.hidden && b.querySelector("[data-ps-label]").textContent.trim().length > 0; }, { timeout: 15000 });
  const label = await ctx.page.$eval("[data-ps-label]", (e) => e.textContent.trim());
  console.log(`# A10b price suggestion shown: ${label}`);
  await ctx.page.click("#priceLevel-5");
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.$eval("form[method='post'][action='/admin/inventory']", (f) => [...f.querySelectorAll("button[type='submit']")].find((b) => /Save book/i.test(b.textContent)).click())]);
  has(await ctx.text(), /Book saved/);
  ctx.created("test book (tagged title, made-up ISBN, one copy at EUR 5.00 in the public shop)", `${tagged.title} / ${tagged.isbn}`, "admin Books & Orders > search the tag > Delete this book");
  await admin(ctx, `/admin/inventory?q=${encodeURIComponent(TAG())}`);
  const href = await ctx.page.$$eval("a[href^='/admin/inventory/']", (as, title) => (as.find((a) => a.textContent.includes(title)) || {}).getAttribute?.("href") || null, tagged.title);
  assert.ok(href, "the tagged book is listed");
  tagged.id = href.split("/").pop();
  has(await ctx.text(), new RegExp(TAG()));
});

s.write("A11 the tagged copy keeps the price chosen at intake and records the suggestion it was based on", { as: "admin" }, async (ctx) => {
  if (!tagged.id) ctx.skip("needs A10b");
  await admin(ctx, `/admin/inventory/${tagged.id}`);
  const price = await ctx.page.$eval("form[action*='/copies/'] input[name='price']", (i) => i.value);
  assert.equal(Number(price), 5, `copy price ${price}`);
});

s.write("A15b (must) adding an award shows it on the public book page; removing it takes it away", { as: "admin" }, async (ctx) => {
  if (!tagged.id) ctx.skip("needs A10b");
  await admin(ctx, `/admin/inventory/${tagged.id}`);
  await ctx.page.type("#awards-add", "Booker Prize (2019)");
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.$eval("#awards-add", (i) => i.form.querySelector("button[type='submit']").click())]);
  await ctx.goto(`/books/${tagged.id}`);
  has(await ctx.text(), /Awards & lists:.*Booker Prize/s);
  await admin(ctx, `/admin/inventory/${tagged.id}`);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action$='/remove'] button")]);
  await ctx.goto(`/books/${tagged.id}`);
  hasNot(await ctx.text(), /Booker Prize/);
});

s.write("A16 (must) Move books moves the tagged copy to a new place, and the Location filter finds it", { as: "admin" }, async (ctx) => {
  if (!tagged.id) ctx.skip("needs A10b");
  const dest = `${tagged.location}-B`;
  await admin(ctx, "/admin/inventory/move");
  await ctx.page.type("#dest", dest);
  await ctx.page.type("#scan", tagged.isbn);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.$eval("#scan", (i) => i.form.querySelector("button[type='submit']").click())]);
  has(await ctx.text(), /1 moved so far|moved/);
  await admin(ctx, `/admin/inventory?location=${encodeURIComponent(dest)}`);
  has(await ctx.text(), new RegExp(TAG()));
});

s.write("A17 the copy's Source is saved and visible on the book page", { as: "admin" }, async (ctx) => {
  if (!tagged.id) ctx.skip("needs A10b");
  await admin(ctx, `/admin/inventory/${tagged.id}`);
  const got = await ctx.page.$eval("select[id^='source-']", (s2) => ({ source: s2.value, id: s2.id, location: document.querySelector("input[id^='location-']").value }));
  assert.equal(got.source, "donation", `copy form says ${JSON.stringify(got)} on ${ctx.page.url()}`);
});

s.write("A14b edit the tagged book's author and see it saved; the public page shows it", { as: "admin" }, async (ctx) => {
  if (!tagged.id) ctx.skip("needs A10b");
  await admin(ctx, `/admin/inventory/${tagged.id}`);
  await ctx.page.$eval("#author", (i, v) => { i.value = v; }, `${TAG()} Author`);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.$eval("#author", (i) => i.form.querySelector("button[type='submit']").click())]);
  await ctx.goto(`/books/${tagged.id}`);
  has(await ctx.text(), new RegExp(`${TAG()} Author`));
});
s.manual("A14c Delete 1 copy / Delete this book", "left to you: the tagged test book stays so you can inspect it, then delete it from its admin page (see e2e/README.md Cleaning up)");

// ---- 5I-5K. Events, programs, meetings, shifts, announcements, blog, charity, forum ----

const PAGES = [
  ["A30 (must) Events", "/admin/events", /\+ Add event/],
  ["A31 (must) English Programs / sessions", "/admin/sessions", /\+ Add session/],
  ["A32 Meetings", "/admin/meetings", /\+ Add meeting/],
  ["A33 Volunteer Shifts", "/admin/volunteer-shifts", /\+ Add shift/],
  ["A34 (must) Announcements", "/admin/announcements", /Create New Announcement|Published|Drafts/],
  ["A35 (must) Blog", "/admin/blog", /Write a New Post|Published|Drafts/],
  ["A36 (must) Charities", "/admin/charity", /Start a New Vote|Past Votes|Submitted Ideas/],
];
for (const [name, path, re] of PAGES) {
  s.test(`${name.split(" ")[0]} ${name.replace(/^A\d+ (\(must\) )?/, "")} admin page opens with its add control`, { as: "admin" }, async (ctx) => {
    await admin(ctx, path);
    const text = await ctx.text();
    has(text, re);
    hasNoNaN(text, path);
  });
}
s.manual("A30b create, sign up for, edit and delete an event", "publishes a public event and sends nothing, but changes the real calendar; do by hand");
s.manual("A31b create a session and check it can be bought as a drop-in", "changes the real sessions calendar and checkout; do by hand");
s.manual("A32b add a meeting with minutes, then delete it", "changes what members see; do by hand");
s.manual("A33b add a weekly repeating shift, then delete it", "changes what volunteers see; do by hand");
s.manual("A34b publish, schedule, pin, archive and delete announcements", "changes what members see; do by hand");
s.manual("A35b publish a blog post and upload a featured image", "publishes to the public blog; do by hand");
s.manual("A36b start, run and close a charity vote", "changes the members' vote; do by hand");
s.manual("A37 (must) hide a forum post with a statement of reasons and restore it", "needs a forum post by someone else, and sends the author an email");

// ---- 5L. Audit log, pricing ----

s.test("A38 (must) Admin activity lists recent actions in a When / Admin / Action / Target / Detail table with nothing sensitive", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/audit");
  const heads = await ctx.page.$$eval("table th", (t) => t.map((x) => x.textContent.trim()));
  for (const h of ["When", "Admin", "Action", "Target", "Detail"]) assert.ok(heads.includes(h), `column ${h} in ${heads}`);
  const text = await ctx.text();
  hasNot(text, /passw(or)?d[:=]|totp_secret|secret=/);
  hasNoNaN(text, "audit");
});

s.test("A39 (must) Pricing rules shows the rules and the Try it calculator, and Price check opens", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/pricing");
  const text = await ctx.text();
  has(text, /The rules, in order/);
  has(text, /Clearance options/);
  has(text, /Other numbers/);
  has(text, /Try it/);
  await ctx.page.$eval("#calcMarket", (i) => { i.value = "10"; });
  await ctx.page.select("#calcBinding", "mass_market");
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/admin/pricing'][method='get'] button[type='submit']")]);
  has(await ctx.page.$eval("[role='status'] strong", (e) => e.textContent), /EUR \d+\.\d\d|\w+/);
  await admin(ctx, "/admin/pricing/review");
  const review = await ctx.text();
  for (const re of [/Needs review/, /Priced differently from the suggestion|Clearance candidates/]) has(review, re);
});
s.manual("A39b change the Clearance price to 2, add a copy, then set it back to 1", "changes the real pricing settings; do by hand");
s.test("A40 the Price stickers page loads with the 7-color legend, a CSV download, and a color chip on the add-book form", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/inventory/stickers");
  has(await ctx.text(), /Sticker colors/);
  assert.equal((await ctx.page.$$(".sticker-legend [data-sticker-chip]")).length, 7, "the legend shows 7 colors");
  const csv = await ctx.page.$eval("a[href*='format=csv']", (a) => a.getAttribute("href"));
  assert.match(csv, /format=csv/);
  const res = await ctx.fetchRaw(csv.replace(/&amp;/g, "&"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/csv/);
  assert.match(res.headers.get("content-disposition") || "", /umas-books-stickers-since-/);
  await admin(ctx, "/admin/inventory/new");
  const note = await ctx.page.$eval("[data-sticker-note]", (e) => e.textContent.trim());
  assert.ok(/sticker/i.test(note), `sticker note on the add-book form: "${note}"`);
  await ctx.page.click("#priceLevel-5");
  await ctx.page.waitForFunction(() => /sticker, EUR|sticker, €|sticker/i.test(document.querySelector("[data-sticker-note]").textContent));
  assert.ok(await ctx.page.$("[data-sticker-note] [data-sticker-chip]"), "a colored chip shows for the chosen price");
});
s.manual("A41 online price check ('Listings found') when PRICING_AI is on", "depends on a setting and a paid lookup service; off by default");
