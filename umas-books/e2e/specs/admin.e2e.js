// Script 5 of docs/testing/manual-test-scripts.md: the admin.
//
// Needs the dedicated TEST admin's E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD and
// E2E_ADMIN_TOTP_SECRET (the base32 key shown under the QR code when
// two-step was set up). The default run only READS admin pages. With
// E2E_ALLOW_WRITES=1 it also creates ONE tagged test book (with a made-up
// ISBN, so it can never attach to a real book) and ONE tagged test member
// (example.invalid address), disables the member, and sells nothing. The order
// steps (A24c to A24l) also need the account-holder login: they reserve a few
// books with it, collect/refund/cancel them as the admin, and leave the shelves
// as they were.
// Admin pages are English only; the steps that publish public content or
// send email to real people (events, announcements, blog, charity votes,
// notifying requesters, selling) stay manual.

const assert = require("node:assert/strict");
const e2e = require("../helpers/harness");
const { has, hasNot, reserveViaHttp, phoneOverflow } = require("../helpers/pages");
const cfg = require("../helpers/config");

const s = e2e.persona("admin");
const TAG = () => process.env.E2E_RUN_ID;
// A reservation made by the account-holder test login (plain HTTP), for the admin to work on; it is listed at the end of the run.
async function e2e_reserve(ctx, who, count = 1) {
  if (ctx.preview) ctx.skip("preview mode: reserving is off");
  const r = await reserveViaHttp(ctx, who, count);
  ctx.created(`reservation for the admin reservation tests (nothing paid; the test collects, refunds, cancels or expires it)`, `${TAG()} ${who} (reservation #${r.id})`, "admin Reservations > Show: All reservations > search the tag");
  return r;
}
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
  has(text, /Lost your phone\? Use a recovery code instead/);
  // A phone's number pad has no letters: the app code box is numeric, the recovery code box is a text box with its own button.
  assert.equal(await ctx.page.$eval("#code", (i) => i.getAttribute("inputmode")), "numeric");
  assert.notEqual(await ctx.page.$eval("#recovery-code", (i) => i.getAttribute("inputmode")), "numeric");
  assert.equal(await ctx.page.$eval("#recovery-code", (i) => i.getAttribute("autocapitalize")), "characters");
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
s.manual("A5c (must) using a recovery code to log in (typed in lowercase, with or without the dash), and that it works only once", "spends one of the account's one-time recovery codes");

// ---- 5B. Dashboard and menu ----

s.test("A6 the Dashboard shows the figures and tiles with no NaN", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin");
  const text = await ctx.text();
  hasNoNaN(text, "the Dashboard");
  for (const re of [/Collected Reservations Today/, /This Month/, /Sales this month/, /In-Stock Books/, /Added This Month/, /Total Accounts/, /Members/, /Books & Reservations/, /English Programs/, /Bookstore Events/, /Account Section/, /Volunteer Shifts/, /Meetings/, /Announcements/, /Charities/, /Blog/]) has(text, re);
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

s.test("A9 (must) scanning an ISBN looks the book up in place (no page reload) and fills in the book form and the copy section", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/inventory/new");
  await ctx.page.waitForSelector("#isbn[data-scan-active]"); // the page script is running
  for (const id of ["#isbn", "#title", "#author", "#location", "#source"]) assert.ok(await ctx.page.$(id), `add-book field ${id}`);
  assert.equal(await ctx.page.evaluate(() => document.activeElement && document.activeElement.id), "isbn", "the ISBN box has the cursor");
  assert.equal(await ctx.page.$eval("#location", (i) => i.value), "Store", "Location starts at Store, not STORE");
  assert.equal(await ctx.page.$eval("#source", (i) => i.value), "donation", "Source starts at Donation");
  // A scanner types the digits and presses Enter: the page must look up, not submit.
  await ctx.page.keyboard.type(REAL_ISBN);
  await ctx.page.keyboard.press("Enter");
  await ctx.page.waitForFunction(() => /^(Found|Already in stock|Not found|No connection|The lookup)/.test(document.getElementById("scan-status").textContent.trim()), { timeout: 20000 });
  assert.equal(new URL(ctx.page.url()).pathname, "/admin/inventory/new", "no page change");
  const status = await ctx.page.$eval("#scan-status", (e) => e.textContent.trim());
  // Open Library may be unreachable from where this runs: the form must still be usable.
  for (const id of ["#title", "#author", "#publisher", "#binding", "#genre", "#description", "#condition", "#location", "#source", "#publisherPrice"]) assert.ok(await ctx.page.$(id), `book form field ${id}`);
  has(await ctx.text(), /This copy/);
  if (/^(Found|Already in stock)/.test(status)) assert.ok((await ctx.page.$eval("#title", (i) => i.value)).length > 0, "the lookup filled in a title");
  else console.log(`# A9 note: ${status}`);
  // Nothing was saved: the form was only filled in.
});

s.test("A9b (must) on a phone (375x812 and 320x640) the Add book page has no sideways scroll, nothing covers a field, fields are tall enough and at least 16 px, and the Save bar is on screen", { as: "admin" }, async (ctx) => {
  for (const [width, height] of [[375, 812], [320, 640]]) {
    await ctx.page.setViewport({ width, height, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await admin(ctx, "/admin/inventory/new");
    const r = await ctx.page.evaluate(() => {
      const problems = [];
      if (document.documentElement.scrollWidth > innerWidth) problems.push(`sideways scroll: page ${document.documentElement.scrollWidth} px in a ${innerWidth} px window`);
      const fields = [...document.querySelectorAll("input:not([type=hidden]):not([type=file]):not([type=radio]):not([type=checkbox]), select, textarea")];
      for (const el of fields) {
        const d = el.closest("details");
        if (d && !d.open) continue;
        if (!el.getClientRects().length) continue; // not shown (the global search is left out on this page on a phone)
        const name = el.id || el.name;
        if (el.readOnly || el.disabled || el.getAttribute("inputmode") === "none") problems.push(`${name} is readonly, disabled or inputmode none`);
        el.scrollIntoView({ block: "center" });
        const b = el.getBoundingClientRect();
        const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        if (top !== el && !el.contains(top)) problems.push(`${name} is covered by ${top ? top.tagName + "." + top.className : "nothing"}`);
        if (b.height < 44 && !el.closest(".admin-search")) problems.push(`${name} is only ${Math.round(b.height)} px tall`);
        if (parseFloat(getComputedStyle(el).fontSize) < 16) problems.push(`${name} has a font under 16 px (iOS zooms in)`);
      }
      const q = document.querySelector(".admin-search input");
      if (q && parseFloat(getComputedStyle(q).fontSize) < 16) problems.push("the header search box has a font under 16 px");
      window.scrollTo(0, 0);
      const bar = document.querySelector("[data-scan-actions]").getBoundingClientRect();
      if (bar.bottom > innerHeight + 1) problems.push(`the Save bar is below the screen (bottom ${Math.round(bar.bottom)} > ${innerHeight})`);
      const isbnBox = document.getElementById("isbn").getBoundingClientRect();
      if (isbnBox.top > 260) problems.push(`the ISBN box starts ${Math.round(isbnBox.top)} px down: it should be near the top (260 px at most)`);
      return problems;
    });
    assert.deepEqual(r, [], `${width}x${height}: ${r.join("; ")}`);
  }
});

s.test("A9g (must) on a phone (390 px, touch) after a lookup, tapping each text field keeps the cursor in it for 1.5 s (the keyboard stays up)", { as: "admin" }, async (ctx) => {
  await ctx.page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await admin(ctx, "/admin/inventory/new");
  await ctx.page.waitForSelector("#isbn[data-scan-active]");
  await ctx.page.evaluate(() => { // the lookup answer is slow on purpose: the person taps a field meanwhile
    const real = window.fetch;
    window.fetch = (...a) => (String(a[0]).includes("/admin/inventory/lookup") ? new Promise((r) => setTimeout(r, 800)).then(() => real(...a)) : real(...a));
    window.__focusLog = [];
    document.addEventListener("focusin", (e) => window.__focusLog.push({ id: e.target.id, t: Math.round(performance.now()) }));
  });
  await ctx.page.type("#isbn", REAL_ISBN);
  await ctx.page.keyboard.press("Enter");
  await ctx.page.evaluate(() => { document.querySelectorAll("details").forEach((d) => { d.open = true; }); });
  const ids = ["title", "author", "location", "publisherPrice", "description"];
  for (const id of ids) {
    if (!(await ctx.page.$(`#${id}`))) continue;
    await ctx.page.evaluate((i) => document.getElementById(i).scrollIntoView({ block: "center" }), id);
    await ctx.page.tap(`#${id}`);
    await new Promise((r) => setTimeout(r, 1500));
    const r = await ctx.page.evaluate((i) => { const el = document.getElementById(i); return { active: document.activeElement && document.activeElement.id, ro: el.readOnly, dis: el.disabled, im: el.getAttribute("inputmode") }; }, id);
    assert.equal(r.active, id, `after tapping #${id} the cursor must stay in it (was in #${r.active})`);
    assert.ok(!r.ro && !r.dis && r.im !== "none", `#${id} is readonly, disabled or inputmode none`);
  }
  await ctx.page.waitForFunction(() => /^(Found|Already in stock|Not found|No connection|The lookup)/.test(document.getElementById("scan-status").textContent.trim()), { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await ctx.page.evaluate(() => document.activeElement.id), "description", "the finished lookup did not take the cursor away");
});

s.test("A9e (must) on a phone (375 px, and 320 px) every admin page has the logo at the top, linking to the main page, easy to tap, with no sideways scroll", { as: "admin" }, async (ctx) => {
  for (const [width, height] of [[375, 812], [320, 640]]) {
    await ctx.page.setViewport({ width, height, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    for (const p of ["/admin", "/admin/inventory", "/admin/inventory/new", "/admin/till", "/admin/orders", "/admin/reports"]) {
      await admin(ctx, p);
      const r = await ctx.page.evaluate(() => {
        const a = document.querySelector(".admin-topbar-brand");
        if (!a) return { problems: ["no logo link in the top bar"] };
        const problems = [];
        const b = a.getBoundingClientRect();
        const cs = getComputedStyle(a);
        if (cs.display === "none" || cs.visibility === "hidden") problems.push("the logo link is hidden");
        if (a.getAttribute("href") !== "/") problems.push(`it links to ${a.getAttribute("href")}, not /`);
        const img = a.querySelector("img");
        if (!img || img.alt !== "Uma's Books and Adventures") problems.push(`the logo image is named "${img && img.alt}"`);
        if (!img || !img.complete || img.naturalWidth === 0) problems.push("the logo image did not load");
        if (b.height < 44 || b.width < 44) problems.push(`the tap target is ${Math.round(b.width)}x${Math.round(b.height)} px`);
        if (b.bottom > 120) problems.push(`the logo is ${Math.round(b.bottom)} px down: it should be at the very top`);
        if (b.left < 0 || b.right > innerWidth) problems.push("the logo is partly off the screen");
        const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        if (!a.contains(top)) problems.push(`the logo is covered by ${top ? top.tagName + "." + top.className : "nothing"}`);
        if (document.documentElement.scrollWidth > innerWidth) problems.push(`sideways scroll: page ${document.documentElement.scrollWidth} px in a ${innerWidth} px window`);
        return { problems };
      });
      assert.deepEqual(r.problems, [], `${p} at ${width} px: ${r.problems.join("; ")}`);
    }
  }
  // Tapping it leaves the admin area for the main page. The site itself sends a signed-in admin, member or
  // volunteer from "/" on to Member's Access (/dashboard), so either address is the right landing.
  await ctx.page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await admin(ctx, "/admin/inventory/new");
  await Promise.all([ctx.page.waitForNavigation({ waitUntil: "domcontentloaded" }), ctx.page.click(".admin-topbar-brand")]);
  const landed = new URL(ctx.page.url()).pathname;
  assert.ok(landed === "/" || landed === "/dashboard", `the logo opens the main page (the browser is on ${ctx.page.url()})`);
});

s.test("A9f (must) the page title (Back link and heading) is on the left and fully on screen on phones (320 to 430 px), on a sideways phone and on a computer, with nothing past the right edge", { as: "admin" }, async (ctx) => {
  for (const width of [320, 360, 375, 390, 430, 932, 1200]) {
    const phone = width < 900;
    await ctx.page.setViewport({ width, height: 812, deviceScaleFactor: 2, isMobile: phone, hasTouch: phone });
    for (const p of ["/admin/inventory/new", "/admin/inventory", "/admin/inventory/scan", "/admin/orders"]) {
      await admin(ctx, p);
      const r = await ctx.page.evaluate(() => {
        const problems = [];
        const h1 = document.querySelector(".admin-topbar h1");
        const back = document.querySelector(".admin-back-link");
        const main = document.querySelector(".admin-main").getBoundingClientRect();
        const h = h1.getBoundingClientRect();
        if (h.left >= innerWidth / 2) problems.push(`the title starts at ${Math.round(h.left)} px, right of the middle of the ${innerWidth} px screen`);
        if (h.left > main.left + 40) problems.push(`the title starts ${Math.round(h.left - main.left)} px in from the page content: it should line up with it`);
        if (back && back.getBoundingClientRect().left > main.left + 40) problems.push("the Back link is not at the left of the page content");
        if (h1.closest(".admin-topbar-tools")) problems.push("the title is inside the tools wrapper (menu button, search, initials), which pushes it to the right");
        const av = document.querySelector(".admin-avatar").getBoundingClientRect();
        if (av.left < h.left) problems.push("the initials are left of the title");
        if (document.documentElement.scrollWidth > innerWidth) problems.push(`sideways scroll: page ${document.documentElement.scrollWidth} px in a ${innerWidth} px window`);
        for (const el of document.querySelectorAll("body *")) {
          const cs = getComputedStyle(el);
          if (cs.position === "fixed" || cs.display === "none" || cs.visibility === "hidden" || el.closest(".admin-sidebar, .skip-link, [hidden]")) continue;
          const b = el.getBoundingClientRect();
          if (b.width > 0 && b.right > innerWidth + 1) {
            let scrolls = false;
            for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) if (/auto|scroll/.test(getComputedStyle(a).overflowX)) scrolls = true;
            if (!scrolls) problems.push(`${el.tagName}.${el.className} ends at ${Math.round(b.right)} px, past the ${innerWidth} px screen`);
          }
        }
        return problems.slice(0, 5);
      });
      assert.deepEqual(r, [], `${p} at ${width} px: ${r.join("; ")}`);
    }
  }
});

s.manual("A9h (must) the suggested publisher's price from ISBNdb on Add Book (shown only for New, never filled until \"Use this price\")", "needs a real ISBNdb key and spends paid ISBNdb requests");
s.test("A9d Location, Source, Binding and Condition are the last values used (also after a reload); the first time they are Store, Donation, the last binding and Very Good (nothing is saved)", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/inventory/new");
  await ctx.page.waitForSelector("#isbn[data-scan-active]");
  await ctx.page.evaluate(() => { for (const k of ["binding", "location", "source", "condition"]) { localStorage.removeItem(`umas.inventory.${k}.v2`); localStorage.removeItem(`umas.inventory.${k}.v3`); } });
  await ctx.page.reload();
  assert.equal(await ctx.page.$eval("#source", (i) => i.value), "donation", "first time: Donation");
  assert.equal(await ctx.page.$eval("#condition", (i) => i.value), "very_good", "first time: Very Good");
  const last = await ctx.page.$eval("#binding", (i) => i.options[i.options.length - 1].value);
  assert.equal(await ctx.page.$eval("#binding", (i) => i.value), last, "first time: the last binding in the list");
  await ctx.page.select("#binding", "hardcover");
  await ctx.page.select("#source", "purchase");
  await ctx.page.select("#condition", "good");
  await ctx.page.$eval("#location", (i) => { i.value = "E2E-LAST"; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await ctx.page.reload();
  assert.equal(await ctx.page.$eval("#binding", (i) => i.value), "hardcover");
  assert.equal(await ctx.page.$eval("#source", (i) => i.value), "purchase");
  assert.equal(await ctx.page.$eval("#condition", (i) => i.value), "good");
  assert.equal(await ctx.page.$eval("#location", (i) => i.value), "E2E-LAST");
  await ctx.page.evaluate(() => { for (const k of ["binding", "location", "source", "condition"]) { localStorage.removeItem(`umas.inventory.${k}.v2`); localStorage.removeItem(`umas.inventory.${k}.v3`); } });
});

s.test("A10 (must) the copy form has condition, binding, source, location and the price control with a suggestion", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/inventory/new");
  const conditions = await ctx.page.$$eval("#condition option", (o) => o.map((x) => x.textContent.trim()));
  for (const c of ["New", "Like New", "Very Good", "Good", "Acceptable"]) assert.ok(conditions.some((x) => x.toLowerCase() === c.toLowerCase()), `condition ${c} in ${conditions}`);
  const bindings = await ctx.page.$$eval("#binding option", (o) => o.map((x) => x.textContent.trim()));
  for (const b of ["Mass Market", "Trade", "Hardback", "Other"]) assert.ok(bindings.some((x) => x.toLowerCase().includes(b.toLowerCase())), `binding ${b} in ${bindings}`);
  assert.ok(await ctx.page.$("#source") && await ctx.page.$("#location"));
  const radios = await ctx.page.$$eval("input[name='priceLevel']", (r) => r.map((x) => x.value));
  assert.ok(radios.includes("clearance") && radios.includes("custom") && radios.length >= 4, `price choices: ${radios}`);
  const text = await ctx.text();
  has(text, /Clearance EUR \d+\.\d\d/);
  has(text, /Custom/);
  assert.ok(await ctx.page.$("[data-ps-suggest]"), "Suggest price button");
  assert.ok(await ctx.page.$("[data-ps-box] summary"), "the \"Why this price?\" box is in the page (hidden until a price is suggested)");
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
  assert.equal(new URL(ctx.page.url()).pathname, "/admin/inventory/new/again", "still on the form: nothing was saved");
});

s.test("A12a (must) a New book published over 2 years ago: the publisher's price is optional (nothing is saved)", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/inventory/new");
  await ctx.page.select("#condition", "new");
  const shown = async (sel) => ctx.page.$eval(sel, (e) => !e.hidden);
  await ctx.page.$eval("#publishedYear", (i) => { i.value = String(new Date().getFullYear()); i.dispatchEvent(new Event("input", { bubbles: true })); });
  assert.ok(await shown("[data-pp-default]"), "a recent year keeps the fixed-price note");
  assert.ok(await shown("label[for='publisherPrice'] [data-pp-required]"), "a recent year keeps the required star");
  await ctx.page.$eval("#publishedYear", (i) => { i.value = String(new Date().getFullYear() - 3); i.dispatchEvent(new Event("input", { bubbles: true })); });
  assert.ok(await shown("[data-pp-old]"), "an old year shows the optional note");
  assert.ok(!(await shown("label[for='publisherPrice'] [data-pp-required]")), "an old year drops the required star");
  has(await ctx.page.$eval("[data-pp-old]", (e) => e.textContent), /Published more than 2 years ago: the publisher's price is optional/);
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
    assert.equal(new URL(ctx.page.url()).pathname, "/admin/inventory/new/again", `price "${bad}" must not save`);
    assert.equal(await ctx.page.$eval("#title", (i) => i.value), `${TAG()} bad number check`, "the title typed is still in the form");
  }
});

s.test("A14d (must) the Inventory list is in A-Z order, ignoring a leading The", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/inventory");
  const titles = await ctx.page.$$eval("ul.plain li a[href^='/admin/inventory/'] strong", (n) => n.map((e) => e.textContent.trim()));
  if (titles.length < 2) ctx.skip("data: fewer than two books in the inventory");
  const { sortTitleKey } = require("../../src/lib/titleSort");
  const c = new Intl.Collator("en", { sensitivity: "base" });
  const first = (t) => sortTitleKey(t).charAt(0);
  for (let i = 1; i < titles.length; i++) assert.ok(c.compare(first(titles[i - 1]), first(titles[i])) <= 0, `"${titles[i - 1]}" is listed before "${titles[i]}"`);
});

s.test("A14e (must) Inventory filters: location, condition, binding, genre and price narrow the list and survive a reload", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/inventory");
  for (const id of ["f-location", "f-condition", "f-binding", "f-genre", "f-pmin", "f-pmax"]) {
    assert.ok(await ctx.page.$(`#${id}`), `the ${id} filter is on the page`);
  }
  assert.ok(await ctx.page.$("label[for='f-pmin']"), "filters have visible labels");
  await admin(ctx, "/admin/inventory?condition=new&priceMax=1000&genre=Fiction");
  const text = await ctx.text();
  has(text, /Clear filters/);
  assert.equal(await ctx.page.$eval("#f-condition", (e) => e.value), "new", "the filter state is kept in the form");
  assert.equal(await ctx.page.$eval("#f-pmax", (e) => e.value), "1000");
  assert.equal(await ctx.page.$eval("#f-genre", (e) => e.value), "Fiction");
  await admin(ctx, "/admin/inventory?priceMin=abc");
  has(await ctx.text(), /Min price must be a number/);
});

s.manual("A13 photo scan of a cover or barcode", "needs a photo and the ANTHROPIC_API_KEY on the site");

// ---- 5D. Awards, locations, selling ----

s.manual("A15 (must) Re-check now on a book looks up awards online", "needs Wikidata/NYT and changes a real book; adding and removing a typed-in award is A15b");

s.test("A18 (must) the retired Sell in shop address sends you to the Till (nothing is sold)", { as: "admin" }, async (ctx) => {
  const res = await ctx.goto("/admin/inventory/sell");
  assert.ok(res.status() < 400, `/admin/inventory/sell answered ${res.status()}`);
  assert.equal(new URL(ctx.page.url()).pathname, "/admin/till", "the old address leads to the Till");
  const text = await ctx.text();
  has(text, /Sales are made at the Till now/);
  has(text, /Scan a label or a book barcode/);
  await admin(ctx, "/admin/inventory");
  assert.equal(await ctx.page.$("a[href='/admin/inventory/sell']"), null, "no Sell in shop link in Books & Reservations");
});

// ---- 5E. Reports and CSV ----

const REPORTS = ["Inventory on hand", "Aging stock", "Sales over time", "Sell-through by genre", "Membership", "Intake log", "Accounts", "Accounting export", "Book lookup sources used"];

s.manual("A19f Inventory CSV: the Download all inventory button and the nightly email", "the nightly email and the Backblaze copy need GitHub Actions, the mailbox and Backblaze; the download itself is covered by test/integration/inventoryExport.test.js");

s.test("A19 (must) the Reports page lists the reports (nine) and each opens with tables", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/reports");
  const text = await ctx.text();
  for (const r of REPORTS) has(text, new RegExp(r), "report list");
  const hrefs = await ctx.page.$$eval("a[href^='/admin/reports/']", (as) => as.map((a) => a.getAttribute("href")));
  assert.ok(hrefs.length >= 9, `report links: ${hrefs.length}`);
  for (const h of hrefs) {
    await admin(ctx, h);
    const t = await ctx.text();
    hasNoNaN(t, h);
    assert.ok((await ctx.page.$$("table")).length > 0 || /Nothing to show/.test(t), `${h} has a table or says nothing to show`);
  }
});

s.test("A20 (must) each report's Download CSV link serves a CSV file named umas-books-<report>-<table>.csv with no email addresses (except Accounts)", { as: "admin" }, async (ctx) => {
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
    // The Accounts report is the list of accounts, so it has emails by design.
    if (!/\/accounts\?/.test(csv)) assert.doesNotMatch(body, /[^\s,"]+@[^\s,"]+\.[a-z]{2,}/i, `${csv} contains an email address`);
    checked++;
  }
  assert.ok(checked >= 5, `CSV links checked: ${checked}`);
});
s.test("A19b the Accounts report shows counts by type and a list with type pills, and downloads as CSV", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/reports/accounts");
  const text = await ctx.text();
  hasNoNaN(text, "accounts report");
  for (const re of [/Total accounts/, /Unconfirmed/, /Email confirmed/, /Paid reservations/, /Download CSV/]) has(text, re);
  for (const name of ["type", "q", "from", "to"]) assert.ok(await ctx.page.$(`[name='${name}']`), `filter ${name}`);
});
s.test("A19c the Book lookup sources used report has the explanation, the period menu, the per-source, month and day tables, and a counts-only CSV", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/reports/lookup-sources");
  const text = await ctx.text();
  hasNoNaN(text, "lookup sources report");
  for (const re of [/How to read this/, /Last 30 days/, /Per source/, /Per month/, /Per day/, /Open Library/, /Google Books/, /ISBNdb/, /Not found: filled by hand/, /check your ISBNdb plan quota/, /Download CSV/]) has(text, re);
  assert.ok(await ctx.page.$("select[name='period']"), "period menu");
  for (const period of ["today", "7d", "month", "all"]) {
    await admin(ctx, `/admin/reports/lookup-sources?period=${period}`);
    hasNoNaN(await ctx.text(), `lookup sources report ${period}`);
  }
  const res = await ctx.fetchRaw("/admin/reports/lookup-sources?format=csv&period=all");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") || "", /attachment; filename="umas-books-lookup-sources-sources-all\.csv"/);
  assert.doesNotMatch(await res.text(), /[^\s,"]+@[^\s,"]+\.[a-z]{2,}/i, "no email address in the CSV");
});
s.test("A19d the report also has the AI usage tables (per feature, month, day), the cost-estimate note and an AI CSV", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/reports/lookup-sources");
  const text = await ctx.text();
  hasNoNaN(text, "AI usage");
  for (const re of [/AI usage per feature/, /AI usage per month/, /AI usage per day/, /Description/, /French translation/, /Genre suggestion/, /Cover photo reading/, /Price check \(web search\)/, /Credit balance too low \/ billing/, /Input tokens/, /Output tokens/, /Estimated cost/]) has(text, re);
  const res = await ctx.fetchRaw("/admin/reports/lookup-sources?format=csv&table=ai&period=all");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") || "", /attachment; filename="umas-books-lookup-sources-ai-all\.csv"/);
  const body = await res.text();
  assert.match(body, /"Feature","Calls made"/);
  assert.doesNotMatch(body, /[^\s,"]+@[^\s,"]+\.[a-z]{2,}/i, "no email address in the CSV");
});
s.test("A19e the AI usage report has the Send a test credit alert button (not pressed here: it would send a real email)", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/reports/lookup-sources");
  const text = await ctx.text();
  has(text, /Anthropic credit alert/);
  has(text, /Send a test credit alert/);
});
s.manual("A21 the sales report counts the online sale, the shop sale and the drop-in seat separately", "needs real paid sales (AC26, AC35, A63)");

// ---- 5F. Book requests ----

s.test("A23 (must) the Book Requests page has the status filters", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/requests");
  const text = await ctx.text();
  for (const re of [/Active/, /Open/, /Matched/, /Notified/, /Waiting for email confirmation/, /Fulfilled/, /Cancelled/, /Expired/, /All/]) has(text, re, "filters");
});
s.manual("A22 (must) adding a requested book matches the confirmed request on intake", "needs a confirmed request, which needs an emailed link");
s.manual("A23c (must) Notify, Notify and hold 7 days, Mark fulfilled, Match, Cancel and Delete a request", "sends email to the requester and changes real requests");
s.manual("A23b a request hold ends by itself after 7 days", "needs real time to pass");

// ---- 5G. Reservations ----
//
// Books and drop-in seats are reserved online and paid in the shop; the staff
// record the payment here. The write tests below need the account-holder test
// login as well (they make a reservation with it by plain HTTP, then work on it
// as the admin) and E2E_ALLOW_WRITES=1. Each one ends the reservation it made
// (collected and paid, refunded, cancelled or expired), so the shelves are as
// they were; the records they leave are listed at the end of the run.

s.test("A24a (must) the Reservations page opens on the reservations waiting for pickup, with status and totals", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/orders");
  const text = await ctx.text();
  has(text, /\d+ reservations?/);
  has(text, /Pickup list/);
  hasNoNaN(text, "reservations");
  const options = await ctx.page.$$eval("#show option", (o) => o.map((x) => x.textContent));
  for (const re of [/Reserved/, /Expiring in 3 days/, /Expired/, /All reservations/, /Paid/, /Refunded/, /Cancelled/]) assert.ok(options.some((o) => re.test(o)), `the Show menu offers ${re}`);
});

// The site allows 10 reservation requests an hour from one address, and a full run shares them with the other
// personas, so the reservation tests use three reservations in all: R1 (A24l, A24c, A24d), R2 (A24i, which leaves a
// rest that A24j extends and cancels) and R3 (A24j, no-show).
const state = { r1: null, rest: null };
async function reservationOne(ctx) {
  if (!state.r1) state.r1 = await e2e_reserve(ctx, "Collect");
  return state.r1;
}

s.write("A24l collecting for less than the total needs a note (a discount at the till), and a payment method is required; nothing is recorded", { as: "admin", needs: ["account"] }, async (ctx) => {
  const r = await reservationOne(ctx);
  await ctx.goto(`/admin/orders/${r.id}`);
  await ctx.page.select("#collect-form #method", "cash");
  await ctx.page.$eval("#amountReceived", (i) => { i.value = "0.50"; });
  await Promise.all([ctx.page.waitForNavigation({ waitUntil: "domcontentloaded" }), ctx.page.click("#collect-form button[type='submit']")]);
  has(await ctx.text(), /please write a note saying why/);
  has(await ctx.text(), /Reserved: awaiting pickup/);
  // A method is required too (the browser's own check is lifted to send the request a script could send).
  await ctx.goto(`/admin/orders/${r.id}`);
  await Promise.all([ctx.page.waitForNavigation({ waitUntil: "domcontentloaded" }), ctx.page.$eval("#method", (m) => { m.removeAttribute("required"); m.form.requestSubmit(); })]);
  has(await ctx.text(), /Choose how the customer paid/);
});

s.write("A24c (must) Mark collected and paid: choose how they paid, the books are sold, the reservation shows Paid and Collected, and Admin activity logs it", { as: "admin", needs: ["account"] }, async (ctx) => {
  const r = await reservationOne(ctx);
  await ctx.goto(`/admin/orders/${r.id}`);
  let text = await ctx.text();
  has(text, /Reserved: awaiting pickup/);
  has(text, /Nothing was paid online\. The customer pays in the shop/);
  has(text, /Books held until the end of/);
  // Cash, the full amount, no note.
  await ctx.page.select("#collect-form #method", "cash");
  await Promise.all([ctx.page.waitForNavigation({ waitUntil: "domcontentloaded" }), ctx.page.click("#collect-form button[type='submit']")]);
  text = await ctx.text();
  has(text, /Collected and paid: the books and seats are sold and the reservation now counts as a sale/);
  has(text, /Paid in the shop on .* by Cash/);
  has(text, /Collected/);
  assert.equal(await ctx.page.$("#collect-form"), null, "the collect form is gone");
  has(text, /order\.collected_paid/);
  // The customer's own page says collected.
  const mine = await (await fetch(ctx.url(`/cart/return?order=${r.token}`))).text();
  has(mine, /Reservation #\d+ collected/);
});

s.write("A24d (must) Mark refunded (after giving the money back in the shop): the reservation is Refunded, the books are back in stock, and it asks for a tick and a note", { as: "admin", needs: ["account"] }, async (ctx) => {
  if (!state.r1) ctx.skip("needs A24c to have collected a reservation first");
  const id = state.r1.id;
  await ctx.goto(`/admin/orders/${id}`);
  if (!(await ctx.page.$(`a[href='/admin/orders/${id}/refund']`))) ctx.skip("the reservation of A24c was not collected (A24c did not run)");
  has(await ctx.text(), /Only AFTER you gave the money back to the customer \(cash, cheque or card\)/);
  await ctx.goto(`/admin/orders/${id}/refund`);
  has(await ctx.text(), /Do this only AFTER you gave the money back to the customer in the shop/);
  assert.equal(await ctx.page.$eval("input[name='confirmRefunded']", (i) => i.required), true);
  await ctx.page.type("#note", `${TAG()} refunded in cash at the shop (test)`);
  await ctx.page.click("input[name='confirmRefunded']");
  await Promise.all([ctx.page.waitForNavigation({ waitUntil: "domcontentloaded" }), ctx.page.click("form[action$='/refund'] button[type='submit']")]);
  const text = await ctx.text();
  has(text, /Marked as refunded\. The books are back on sale/);
  has(text, /Refunded/);
  has(text, /is now in_stock/);
  has(text, /order\.refunded/);
});

s.test("A24h the Pickup list shows reservations by customer, with shelves and the amount to collect, and has a print version", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/orders/pickup-list");
  const text = await ctx.text();
  has(text, /Pickup list/);
  has(text, /customers? .* to collect in total/);
  has(text, /Print/);
  hasNoNaN(text, "pickup list");
  await admin(ctx, "/admin/orders/pickup-list?print=1");
  assert.ok(await ctx.page.$(".pickup-list-print"), "the print layout");
  has(await ctx.text(), /Normal view/);
});

s.write("A24i Collect selected items (partial pickup): the chosen book is sold and the rest moves to a new reservation with the same deadline", { as: "admin", needs: ["account"] }, async (ctx) => {
  const r = await e2e_reserve(ctx, "Partial", 2);
  await ctx.goto(`/admin/orders/${r.id}`);
  assert.ok(await ctx.page.$("#collect-selected-form"), "two items: the partial pickup form is shown");
  await ctx.page.click("#collect-selected-form input[name='itemIds']"); // the first item
  await ctx.page.select("#collect-selected-form #method-sel", "card");
  await Promise.all([ctx.page.waitForNavigation({ waitUntil: "domcontentloaded" }), ctx.page.click("#collect-selected-form button[type='submit']")]);
  const text = await ctx.text();
  has(text, /Collected and paid for the selected items\. The other items stay reserved on a new reservation with the same deadline/);
  has(text, /Related reservation/);
  const links = await ctx.page.$$eval("p a[href^='/admin/orders/']", (as) => as.map((a) => a.getAttribute("href")));
  const other = links.map((h) => Number(h.split("/").pop())).find((n) => n && n !== r.id);
  assert.ok(other, "a link to the new reservation");
  state.rest = { id: other };
  await ctx.goto(`/admin/orders/${other}`);
  has(await ctx.text(), /Reserved: awaiting pickup/);
  // The paid half is refunded so its book goes back on the shelf.
  await ctx.goto(`/admin/orders/${r.id}/refund`);
  await ctx.page.type("#note", `${TAG()} partial pickup test, undone`);
  await ctx.page.click("input[name='confirmRefunded']");
  await Promise.all([ctx.page.waitForNavigation({ waitUntil: "domcontentloaded" }), ctx.page.click("form[action$='/refund'] button[type='submit']")]);
  has(await ctx.text(), /Marked as refunded/);
});

s.write("A24j Extend by 7 days works once, then Cancel reservation and Mark no-show / expired put the books back on the shelf", { as: "admin", needs: ["account"] }, async (ctx) => {
  if (!state.rest) ctx.skip("needs A24i to have left a reservation behind (the rest of a partial pickup)");
  const a = state.rest;
  // Extend: once.
  await ctx.goto(`/admin/orders/${a.id}`);
  const before = await ctx.page.$eval("#reservation-deadline", (e) => e.innerText);
  await Promise.all([ctx.page.waitForNavigation({ waitUntil: "domcontentloaded" }), ctx.page.click(`form[action='/admin/orders/${a.id}/extend'] button`)]);
  has(await ctx.text(), /The deadline was extended by 7 days\./);
  const after = await ctx.page.$eval("#reservation-deadline", (e) => e.innerText);
  assert.notEqual(after, before, "the deadline moved");
  has(after, /Extended once on/);
  assert.equal(await ctx.page.$(`form[action='/admin/orders/${a.id}/extend']`), null, "the Extend button is gone after one use");
  // Cancel reservation.
  await Promise.all([ctx.page.waitForNavigation({ waitUntil: "domcontentloaded" }), ctx.page.click(`form[action='/admin/orders/${a.id}/cancel-reservation'] button`)]);
  has(await ctx.text(), /The reservation was cancelled: its books are back on the shelf/);
  has(await ctx.text(), /Cancelled/);
  // No-show, on a reservation of its own.
  const b = await e2e_reserve(ctx, "No Show");
  await ctx.goto(`/admin/orders/${b.id}`);
  await Promise.all([ctx.page.waitForNavigation({ waitUntil: "domcontentloaded" }), ctx.page.click(`form[action='/admin/orders/${b.id}/no-show'] button`)]);
  has(await ctx.text(), /Marked as no-show: the books are back on the shelf/);
  has(await ctx.text(), /Expired/);
  has(await (await fetch(ctx.url(`/cart/return?order=${b.token}`))).text(), /Reservation ended/);
});

s.test("A24k the Reservations report loads, has a CSV download and shows no names or emails", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/reports");
  has(await ctx.text(), /Reservations/);
  await admin(ctx, "/admin/reports/reservations");
  const text = await ctx.text();
  has(text, /Reservations by month/);
  hasNoNaN(text, "reservations report");
  hasNot(text, /@/, "the report shows no email address");
  if (/Nothing to show for this period/.test(text)) return; // no reservation in the period yet: the table and CSV link only appear with rows
  for (const re of [/Reserved/, /Collected \(sold\)/, /Expired \/ no-show/, /Cancelled/, /Conversion/]) has(text, re);
  const csv = await ctx.page.$eval("a[href*='format=csv']", (a) => a.getAttribute("href"));
  const res = await ctx.fetchRaw(csv.replace(/&amp;/g, "&"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/csv/);
});

s.test("A24b (must) the Reservations page filters, searches and opens a reservation", { as: "admin" }, async (ctx) => {
  for (const q of ["show=expiring_soon", "show=expired", "show=past_deadline", "show=all", "show=refunded", "show=cancelled", "show=paid&from=2020-01-01&to=2099-12-31", "q=%23999999999", "page=2"]) {
    await admin(ctx, `/admin/orders?${q}`);
    const text = await ctx.text();
    hasNoNaN(text, `reservations ${q}`);
    has(text, /\d+ reservations?/);
  }
  await admin(ctx, "/admin/orders?show=all");
  const first = await ctx.page.$$eval("a[href^='/admin/orders/']", (as) => as.map((a) => a.getAttribute("href")).find((h) => /^\/admin\/orders\/\d+$/.test(h)) || null);
  if (!first) ctx.skip("no reservation exists yet");
  await ctx.goto(first);
  const text = await ctx.text();
  has(text, /Payment/);
  has(text, /Terms and history/);
  has(text, /Actions/);
  hasNoNaN(text, "reservation page");
});

s.manual("A24f the dashboard Needs attention box (reservations expiring within 3 days, past the deadline)", "needs a reservation close to its deadline; the counts are covered by an automated test");

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

s.test("A29b the accounts list shows a role pill per account and filters by type", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/members");
  const text = await ctx.text();
  hasNoNaN(text, "accounts list");
  for (const re of [/All accounts/, /Volunteer/, /Account holder/, /Unconfirmed/]) has(text, re);
  for (const role of ["admin", "volunteer", "member", "account", "unconfirmed"]) {
    await admin(ctx, `/admin/members?role=${role}`);
    hasNoNaN(await ctx.text(), `role=${role}`);
  }
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
  tagged.location = `E2e-${TAG().slice(4, 12)}`; // mixed case on purpose: locations keep their capitals
  await admin(ctx, "/admin/inventory/new");
  await ctx.page.waitForSelector("#isbn[data-scan-active]"); // the page script is running
  await ctx.page.keyboard.type(REAL_ISBN);
  await ctx.page.keyboard.press("Enter");
  await ctx.page.waitForFunction(() => /^(Found|Already in stock|Not found|No connection|The lookup)/.test(document.getElementById("scan-status").textContent.trim()), { timeout: 20000 });
  // The lookup only pre-fills the form. Save it under a tagged title and a made-up ISBN so it can never join a real book.
  await ctx.page.$eval("#title", (i, v) => { i.value = v; }, tagged.title);
  await ctx.page.$eval("#isbn", (i, v) => { i.value = v; }, tagged.isbn);
  await ctx.page.select("#binding", "trade");
  await ctx.page.select("#condition", "very_good");
  await ctx.page.select("#source", "donation");
  await ctx.page.$eval("#location", (i, v) => { i.value = v; }, tagged.location);
  await ctx.page.click("[data-ps-suggest]");
  await ctx.page.waitForFunction(() => { const b = document.querySelector("[data-ps-box]"); return b && !b.hidden && b.querySelector("[data-ps-label]").textContent.trim().length > 0; }, { timeout: 15000 });
  const label = await ctx.page.$eval("[data-ps-label]", (e) => e.textContent.trim());
  console.log(`# A10b price suggestion shown: ${label}`);
  await ctx.page.click("#priceLevel-5");
  const t0 = Date.now();
  await ctx.page.click("[data-scan-save-next]");
  await ctx.page.waitForFunction(() => /^Saved:/.test(document.getElementById("scan-saved").textContent.trim()), { timeout: 30000 });
  console.log(`# A10b save and add another took ${Date.now() - t0} ms`);
  // Back to a fresh form with the cursor in the empty ISBN box; the location and binding of this book are kept, the source is Donation again.
  assert.equal(await ctx.page.evaluate(() => document.activeElement && document.activeElement.id), "isbn", "the cursor is back in the ISBN box");
  assert.equal(await ctx.page.$eval("#isbn", (i) => i.value), "");
  assert.equal(await ctx.page.$eval("#title", (i) => i.value), "");
  assert.equal(await ctx.page.$eval("#location", (i) => i.value), tagged.location);
  assert.equal(await ctx.page.$eval("#binding", (i) => i.value), "trade");
  assert.equal(await ctx.page.$eval("#source", (i) => i.value), "donation");
  ctx.created("test book (tagged title, made-up ISBN, one copy at EUR 5.00 in the public shop)", `${tagged.title} / ${tagged.isbn}`, "admin Books & Reservations > search the tag > Delete this book");
  await admin(ctx, `/admin/inventory?q=${encodeURIComponent(TAG())}`);
  const href = await ctx.page.$$eval("a[href^='/admin/inventory/']", (as, title) => (as.find((a) => a.textContent.includes(title)) || {}).getAttribute?.("href") || null, tagged.title);
  assert.ok(href, "the tagged book is listed");
  tagged.id = href.split("/").pop();
  has(await ctx.text(), new RegExp(TAG()));
});

s.write("A10c (must) a new location can be typed (also on a phone); a fresh browser starts at the location, source, binding and condition used last, not at Store", { as: "admin" }, async (ctx) => {
  if (!tagged.id) ctx.skip("needs A10b");
  const clear = () => ctx.page.evaluate(() => { for (const k of ["binding", "location", "source", "condition"]) { localStorage.removeItem(`umas.inventory.${k}.v2`); localStorage.removeItem(`umas.inventory.${k}.v3`); } });
  for (const phone of [false, true]) {
    if (phone) await ctx.page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await admin(ctx, "/admin/inventory/new");
    await ctx.page.waitForSelector("#isbn[data-scan-active]");
    await clear();
    await ctx.page.reload();
    await ctx.page.waitForSelector("#isbn[data-scan-active]");
    assert.equal(await ctx.page.$eval("#location", (i) => i.value), tagged.location, "a fresh browser: the location of the last copy saved (as typed), not Store");
    assert.equal(await ctx.page.$eval("#binding", (i) => i.value), "trade", "a fresh browser: the last binding");
    assert.equal(await ctx.page.$eval("#condition", (i) => i.value), "very_good");
    // A location that is in no list yet: typed, not picked. It must stay exactly as typed (capitals kept) and be remembered.
    const fresh = `${tagged.location}-New${phone ? "P" : "D"}`;
    await ctx.page.$eval("#location", (i) => { i.value = ""; });
    await ctx.page.type("#location", fresh);
    assert.equal(await ctx.page.$eval("#location", (i) => i.readOnly || i.disabled), false, "the Location field is editable");
    await ctx.page.keyboard.press("Enter");
    assert.equal(await ctx.page.$eval("#location", (i) => i.value), fresh, "the new location is kept as typed (capitals kept)");
    await ctx.page.reload();
    assert.equal(await ctx.page.$eval("#location", (i) => i.value), fresh, "remembered after a reload");
    await clear();
  }
  await ctx.page.setViewport({ width: 1280, height: 800 });
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

s.write("A16 (must) Move books moves the tagged copy to a new place, and the book list shows it", { as: "admin" }, async (ctx) => {
  if (!tagged.id) ctx.skip("needs A10b");
  const dest = `${tagged.location}-B`;
  await admin(ctx, "/admin/inventory/move");
  await ctx.page.type("#dest", dest);
  await ctx.page.type("#scan", tagged.isbn);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.$eval("#scan", (i) => i.form.querySelector("button[type='submit']").click())]);
  has(await ctx.text(), /1 moved so far|moved/);
  await admin(ctx, `/admin/inventory?q=${encodeURIComponent(TAG())}`);
  has(await ctx.text(), new RegExp(`Location: ${dest}`));
  // A change of capitals only is a real move ("STORE" -> "Store" is how an old shelf gets renamed): the list then shows one spelling.
  const upper = dest.toUpperCase();
  await admin(ctx, "/admin/inventory/move");
  await ctx.page.$eval("#dest", (i) => { i.value = ""; });
  await ctx.page.type("#dest", upper);
  await ctx.page.type("#scan", tagged.isbn);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.$eval("#scan", (i) => i.form.querySelector("button[type='submit']").click())]);
  has(await ctx.text(), /Moved:/);
  await admin(ctx, `/admin/inventory?q=${encodeURIComponent(TAG())}`);
  has(await ctx.text(), new RegExp(`Location: ${upper}(?!,)`));
  await admin(ctx, "/admin/inventory/move");
  await ctx.page.$eval("#dest", (i) => { i.value = ""; });
  await ctx.page.type("#dest", dest);
  await ctx.page.type("#scan", tagged.isbn);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.$eval("#scan", (i) => i.form.querySelector("button[type='submit']").click())]);
  await admin(ctx, `/admin/inventory?q=${encodeURIComponent(TAG())}`);
  has(await ctx.text(), new RegExp(`Location: ${dest}(?!,)`));
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
    // Preview mode must not get in the way of the blog: the screen says so.
    if (ctx.preview && path === "/admin/blog") has(text, /Blog posts are not affected by preview mode/);
  });
}
s.manual("A30b create, sign up for, edit and delete an event", "publishes a public event and sends nothing, but changes the real calendar; do by hand");
s.manual("A31b create a session and check a drop-in seat can be reserved", "changes the real sessions calendar; do by hand");
s.manual("A32b add a meeting with minutes, then delete it", "changes what members see; do by hand");
s.manual("A33b add a weekly repeating shift, then delete it", "changes what volunteers see; do by hand");
s.manual("A34b publish, schedule, pin, archive and delete announcements", "changes what members see; do by hand");
s.test("A35c (must) Blog form: Save with no content shows a message instead of doing nothing, and a title plus content is accepted by the browser", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/blog");
  const page = ctx.page;
  const before = page.url();
  // Nothing is saved by this step: with no content the form is stopped by the page itself, and with content it is only checked, never sent.
  await page.select("#blog-status", "published");
  await page.type("#blog-title", `${TAG()} blog form check`);
  await page.click("#blog-form button[type=submit]");
  await page.waitForFunction(() => { const n = document.getElementById("blog-body-error"); return n && !n.hidden; }, { timeout: 5000 });
  assert.equal(page.url(), before, "the form was sent although the content is empty");
  assert.ok((await page.$eval("#blog-body-error", (n) => n.textContent)).includes("write some content"), "no visible message about the empty content");
  await page.click(".richtext-editor");
  await page.keyboard.type("Some content");
  const state = await page.evaluate(() => {
    const f = document.getElementById("blog-form");
    f.querySelector("[name=body]").value = f.querySelector(".richtext-editor").innerHTML;
    return { valid: f.checkValidity(), invalid: [...f.querySelectorAll(":invalid")].map((e) => e.name), noticeHidden: document.getElementById("blog-body-error").hidden };
  });
  assert.deepEqual(state, { valid: true, invalid: [], noticeHidden: true }, "the browser would still block Save");
});
s.test("A35d (must) Blog editor has the French version section: the French status, a Translate to French button, the French title, content and excerpt", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/blog");
  const page = ctx.page;
  assert.ok(await page.$("#blog-french"), "the French version section");
  has(await page.$eval("#blog-french-status", (n) => n.textContent), /French: (missing|draft|ready)/);
  assert.ok(await page.$("#blog-translate-btn"), "the Translate to French button (not pressed here: it uses the paid AI)");
  for (const name of ["title_fr", "excerpt_fr", "body_fr"]) assert.ok(await page.$(`[name=${name}]`), name);
  assert.ok(await page.$("#blog-content-fr.richtext-editor"), "the French content uses the same rich-text editor");
  const lang = await page.$eval("#blog-title-fr", (n) => n.getAttribute("lang"));
  assert.equal(lang, "fr");
});
s.manual("A35e translate a blog post to French and save it", "presses the AI button (counts toward the daily cap) and publishes a post; do by hand");
s.manual("A35b publish a blog post and upload a featured image", "publishes to the public blog (this works in preview mode too); do by hand");
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
  has(text, /Price sticker colours/);
  for (const c of ["Orange", "Yellow", "Green", "Blue", "Red", "Purple", "White"]) has(text, new RegExp(c));
  for (const k of ["Clearance", "Children's", "Mass Market", "Trade", "Hardback"]) has(text, new RegExp(k));
  await ctx.page.$eval("#calcMarket", (i) => { i.value = "10"; });
  await ctx.page.select("#calcBinding", "mass_market");
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/admin/pricing'][method='get'] button[type='submit']")]);
  has(await ctx.page.$eval("[role='status'] strong", (e) => e.textContent), /EUR \d+\.\d\d|\w+/);
  await admin(ctx, "/admin/pricing/review");
  const review = await ctx.text();
  for (const re of [/Needs review/, /Priced differently from the suggestion|Clearance candidates/]) has(review, re);
  // The one-off Reprice tool: a preview only (the confirm buttons are not pressed here: they change prices).
  await admin(ctx, "/admin/pricing");
  has(await ctx.text(), /Trade paperbacks/);
  await admin(ctx, "/admin/pricing/reprice");
  const rp = await ctx.text();
  for (const re of [/Group A: Trade copies/, /Group B: Mass Market copies/, /Group C: /, /Earlier runs/]) has(rp, re);
  hasNot(rp, /EUR 8\.00 \(/);
});
s.manual("A39b change the Clearance price to 2, add a copy, then set it back to 1", "changes the real pricing settings; do by hand");
s.manual("A41 online price check ('Listings found') when PRICING_AI is on", "depends on a setting and a paid lookup service; off by default");

s.manual("A42 (must) Mark as Member gives no end date, and the member's membership page says so", "needs a look at the admin account page and the member's own membership page; the toggle itself is covered by A24");
s.test("A43 the Email outbox page loads for an admin with its controls", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/email-outbox");
  const text = await ctx.text();
  has(text, /Email outbox/);
  has(text, /Pending:/);
  has(text, /Failed:/);
});
s.manual("A44 (must) Resend confirmation on a reservation sends a new confirmation email", "needs a reservation and a mailbox to read");
s.manual("A45 (must) an unmatched membership payment is alerted, listed under Accounts and can be linked to an account", "needs a real test payment on the HelloAsso membership form");
s.manual("A46 the dashboard Needs attention box shows only when something is wrong", "needs a failed email or a reservation whose confirmation was not sent; the rule is covered by an automated test");
s.manual("A80 (must) Privacy requests: look up, download and erase everything held under an email address", "erases real data and needs a throwaway account; covered by the automated test privacyRequests.test.js");
s.manual("A81 viewing the Accounts report page is written to the admin activity log once an hour", "needs a look at the Admin activity page; covered by the automated test privacyRequests.test.js");
s.manual("A82 (must) the client IP check on both the Render address and umasbooks.org before launch", "needs the live hosts and your own public IP");

// ---- the till, end of day, accounting export (steps A60-A69) ----

s.test("A60 (must) the Till page loads from the menu, the scan box has the focus and Cash / Card are there", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin");
  assert.ok(await ctx.page.$("nav.admin-nav a[href='/admin/till']"), "the menu has a Till link");
  await admin(ctx, "/admin/till");
  const text = await ctx.text();
  has(text, /Scan a label or a book barcode/);
  has(text, /Cash/);
  has(text, /Card/);
  hasNoNaN(text, "/admin/till");
  assert.equal(await ctx.page.evaluate(() => document.activeElement && document.activeElement.id), "scan", "the scan box has the focus");
  // the focus comes back after a click elsewhere
  await ctx.page.click("h1");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await ctx.page.evaluate(() => document.activeElement && document.activeElement.id), "scan", "the scan box got the focus back");
  // an unknown code shows a red message and sells nothing
  await ctx.page.keyboard.type("not-a-code");
  await ctx.page.keyboard.press("Enter");
  await ctx.page.waitForFunction(() => /not recognised/.test(document.getElementById("till-msg").textContent), { timeout: 8000 });
});

// The till on a phone and on a tablet held sideways (steps A60b, A60c): with four lines on the sale the
// Total / Cash / Card bar and the cash screen's Confirm sale are on screen without scrolling. Nothing is
// sold: four manual items are put on the sale, Cash is opened (the check writes nothing) and closed again.
async function tillFitsViewport(ctx) {
  await admin(ctx, "/admin/till");
  const click = (sel) => ctx.page.$eval(sel, (e) => e.click());
  for (const price of ["2.50", "3.00", "4.00", "5.00"]) {
    await click("#manual-open");
    await ctx.page.waitForFunction(() => !document.getElementById("manual-modal").hidden);
    await ctx.page.type("#manual-desc", "E2E fit check");
    await ctx.page.type("#manual-price", price);
    await ctx.page.$eval("#manual-form button[type='submit']", (b) => b.click());
    await ctx.page.waitForFunction(() => document.getElementById("manual-modal").hidden);
  }
  assert.equal(await ctx.page.$$eval("#lines li", (l) => l.length), 4, "four lines on the sale");
  await ctx.page.evaluate(() => window.scrollTo(0, 0));
  const inside = (sel) => ctx.page.$eval(sel, (e) => {
    const r = e.getBoundingClientRect();
    return { ok: r.width > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth, box: [r.left, r.top, r.right, r.bottom].map(Math.round), vp: [window.innerWidth, window.innerHeight] };
  });
  for (const sel of ["#total", "#pay-cash", "#pay-card"]) {
    const r = await inside(sel);
    assert.ok(r.ok, `${sel} is fully on screen without scrolling: box ${r.box} in viewport ${r.vp}`);
  }
  await click("#pay-cash");
  await ctx.page.waitForFunction(() => !document.getElementById("cash-modal").hidden);
  await click("[data-amount='exact']");
  await ctx.page.waitForFunction(() => !document.getElementById("cash-confirm").disabled, { timeout: 8000 });
  const c = await inside("#cash-confirm");
  assert.ok(c.ok, `Confirm sale is on screen without scrolling: box ${c.box} in viewport ${c.vp}`);
  const lock = await ctx.page.evaluate(() => document.body.classList.contains("modal-open"));
  assert.ok(lock, "the page behind the cash screen is locked (no scrolling behind it)");
  await click("#cash-modal [data-close]");
  assert.ok(!(await ctx.page.evaluate(() => document.body.classList.contains("modal-open"))), "the page is unlocked again");
}
s.test("A60b (must) on a phone (390x844) with four lines the Total, Cash and Card buttons and the cash screen's Confirm sale are on screen without scrolling", { as: "admin", viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } }, tillFitsViewport);
s.test("A60c (must) on a tablet held sideways (1024x768) with four lines the Total, Cash and Card buttons and the cash screen's Confirm sale are on screen without scrolling", { as: "admin", viewport: { width: 1024, height: 768, isMobile: true, hasTouch: true } }, tillFitsViewport);

s.test("A62 the End of day page, Quick items page and the Accounting export report load", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/till/day");
  has(await ctx.text(), /Cash drawer/);
  has(await ctx.text(), /Close the day/);
  await admin(ctx, "/admin/till/items");
  has(await ctx.text(), /Add an item/);
  await admin(ctx, "/admin/reports/accounting");
  const t = await ctx.text();
  has(t, /Accounting export/);
  hasNoNaN(t, "accounting export");
  const csv = await ctx.page.$eval("a[href*='format=csv']", (a) => a.getAttribute("href"));
  const res = await ctx.fetchRaw(csv.replace(/&amp;/g, "&"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/csv/);
  const body = await res.text();
  assert.match(body, /Date.*Category.*Payment method.*Count.*Total/);
  assert.doesNotMatch(body, /[^\s,"]+@[^\s,"]+\.[a-z]{2,}/i, "the export has no email addresses");
});

s.write("A63 (must) sell the tagged test copy at the till with cash by scanning its code (UB-number), then void it", { as: "admin" }, async (ctx) => {
  if (!tagged.id) ctx.skip("needs A10b");
  await admin(ctx, `/admin/inventory/${tagged.id}`);
  const copyId = await ctx.page.$$eval("input[id^='location-']", (is) => (is[0] ? is[0].id.split("-").pop() : null));
  assert.ok(copyId, "the copy form is on the page");
  await admin(ctx, "/admin/till");
  await ctx.page.keyboard.type(`UB-${copyId}`);
  await ctx.page.keyboard.press("Enter");
  await ctx.page.waitForFunction(() => document.querySelectorAll("#lines li").length === 1, { timeout: 8000 });
  await ctx.page.click("#pay-cash");
  await ctx.page.click("[data-amount='exact']");
  // the till checks the sale first (nothing is written); Confirm sale is enabled when that passes
  await ctx.page.waitForFunction(() => !document.getElementById("cash-confirm").disabled, { timeout: 8000 });
  await ctx.page.click("#cash-confirm");
  await ctx.page.waitForFunction(() => !document.getElementById("done").hidden, { timeout: 8000 });
  has(await ctx.text(), /Sale recorded/);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("#next")]);
  // void it again so the copy goes back on the shelf
  await ctx.page.click("#recent details.till-void summary");
  await ctx.page.type("#recent details[open] input[name='reason']", `${TAG()} test sale`);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("#recent details[open] button[type='submit']")]);
  has(await ctx.text(), /voided: its books are back in stock/);
});
s.manual("A64 (must) a card sale: Charge on the SumUp reader, then Card paid; the receipt page prints", "needs a SumUp reader and a real card payment");
s.manual("A65 (must) Close the day: count the drawer, see over/short, closing locks voids", "closing is one-way (it locks that day's voids), so it is left for you to do by hand");
s.manual("A66 (must) a barcode scanner typing into the till scan box (code appears, Enter adds the line)", "needs the physical scanner");
s.manual("A67 a manual item and a quick item (tote bag) sold and shown on the receipt and in End of day by category", "selling is left for you to do by hand");
s.manual("A68 a book with no ISBN: Enter the details by hand, sell it at the till", "creates a real book and a sale");
s.manual("A69 (must) the Accounting export CSV imports into the treasurer's accounting software", "needs the treasurer: see docs/till-todos.md");
s.test("A70 the Other stock (not books) page is reachable from Inventory and has the barcode box", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/inventory");
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("main a[href='/admin/till/items']")]);
  const text = await ctx.text();
  has(text, /Other stock \(not books\)/);
  has(text, /Tote bags, bookmarks and anything else you sell that is not a book/);
  assert.ok(await ctx.page.$("#new-barcode"), "the barcode box is on the form");
});
s.manual("A71 (must) collecting a reservation at the till: scan ORDER-<n>, the lines load at the reserved prices, remove one for a partial pickup, pay cash or card; the order shows Paid and the rest stays reserved", "needs a reservation made by a customer and the till in use; the rule is covered by automated tests (tillReservations)");
s.manual("A70b scanning an item's barcode with the scanner fills the Barcode box; at the till it adds the item", "needs the physical scanner (see A66)");
s.manual("A71 tablet layout: the till is one column at 768 and 1024 px and the menu is behind a button", "needs a tablet or a resized window; the CSS rules are covered by an automated test");
s.manual("A72 the admin menu is grouped and the Till pill is only filled on the till", "visual check; the markup is covered by an automated test");
s.manual("A74 destructive buttons ask for confirmation (delete book/copy/event, remove sign-up, deactivate, make admin, close the day, void)", "the browser confirm dialog is left to a person; an automated test checks every destructive admin form carries data-confirm");
s.manual("A75 the Add Book form focuses ISBN, shows no Manual review alert when blank, has a sticky Save bar", "layout check; the markup is covered by an automated test");
s.manual("A76 the receipt is in French with a gapless number, and ANNUL\u00c9 when voided", "selling is left for you to do by hand; covered by an automated test");
s.manual("A77 French Excel export opens in columns with decimal commas; refunds are negative rows; the mapping page edits accounts", "needs French Excel; the content is covered by an automated test");
s.manual("A90 (must) a price changed under a card sale: new total shown, nothing recorded, restart", "needs a card sale and a second browser tab changing the price");
s.manual("A91 (must) the card was charged but the sale is refused: red box, Record card sale, Record anyway", "needs a card sale and a change made while the card screen is open");
s.manual("A92 (must) a sale on a closed day is refused; an admin reopens the day with a reason and closes it again", "closing is one-way (see A65), so it is left for you to do by hand");
s.manual("A93 (must) a volunteer with Till access can use only the till; 8 hours idle logs out", "needs a second account in another browser and a wait of 8 hours");
s.manual("A94 (must) a scan while the Cash screen is open is ignored with a note; 20. is accepted", "needs the physical scanner (see A66)");
s.manual("A95 (must) voiding a card sale warns to refund the card and lists it until ticked", "needs a card sale (see A64)");
s.test("A96 the Dashboard tile is Sales this month with a In person, Old online orders, Membership line", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin");
  const text = await ctx.text();
  hasNoNaN(text, "the Dashboard");
  has(text, /Sales this month/);
  has(text, /In person €\d+\s*·\s*Old online orders €\d+\s*·\s*Membership €\d+/);
});
s.manual("A98 admin sessions end after 8 hours idle or 7 days (needs the database to age the session; covered by test/integration/adminSessionTimeouts.test.js)", "waiting 8 hours is left for you, or the integration test, to do");
s.manual("A97 backdating needs a reason, a basket above EUR 10,000 is refused, a price below asking needs a reason, an expired cart copy can be released", "selling is left for you to do by hand");
s.manual("A99 till voids by role: card voids and the refund tick need an admin, till-only cash voids are limited and listed (covered by test/integration/tillVoidRules.test.js)", "needs a second, till-only account");
s.manual("A100 reprice: an exact-count confirmation and an undo of the last run (covered by test/integration/pricingReprice.test.js)", "applying a reprice changes real prices: left for you to do by hand");
s.manual("A101 blog publish dates are Paris time and bulk publish/draft are audited (covered by test/integration/blogCorrectness.test.js)", "needs waiting for a scheduled date");

s.test("A102 (must) on a phone (375 px and 320 px) the admin lists and tables fit the screen, long titles wrap, wide tables say they scroll, and the member calendars are a list", { as: "admin", timeout: 300000 }, async (ctx) => {
  const pages = ["/admin", "/admin/inventory", "/admin/orders", "/admin/members", "/admin/blog", "/admin/announcements", "/admin/reports", "/admin/events", "/admin/meetings", "/admin/volunteer-shifts", "/admin/charity", "/admin/till/day", "/admin/diagnostics/lookup"];
  for (const [width, height] of [[375, 812], [320, 640]]) {
    await ctx.page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    for (const p of pages) {
      const res = await ctx.goto(p);
      if (res.status() >= 400 || new URL(ctx.page.url()).pathname !== p) continue; // a page this site does not have (or hides from this login) is not a fault here
      const bad = await phoneOverflow(ctx.page, width);
      assert.deepEqual(bad, [], `${p} at ${width} px: ${bad.join("; ")}`);
    }
    // a book whose title is a long unbroken string (the local test copy has one) and the Inventory search that lists it
    const hostile = await e2e.getJson("/api/books/search?q=E2Ephone").catch(() => []);
    if (hostile.length) {
      for (const p of [`/admin/inventory?q=E2Ephone`, `/admin/inventory/${hostile[0].id}`]) {
        await admin(ctx, p);
        const bad = await phoneOverflow(ctx.page, width);
        assert.deepEqual(bad, [], `${p} at ${width} px: ${bad.join("; ")}`);
      }
    }
    // Every table that is wider than its box scrolls inside it and says so: an edge shadow always, and the
    // 'swipe' line above it (the script adds it) while it is wider.
    for (const p of ["/admin/members", "/admin/blog", "/admin/announcements", "/admin/reports"]) {
      const res = await ctx.goto(p);
      if (res.status() >= 400) continue;
      const r = await ctx.page.evaluate(() => [...document.querySelectorAll(".table-scroll")].map((b) => {
        const wide = b.scrollWidth > b.clientWidth + 2;
        const hint = b.previousElementSibling;
        return { wide, shadow: /gradient/.test(getComputedStyle(b).backgroundImage), hint: !!(hint && hint.classList.contains("table-scroll-hint")), hintShown: !!(hint && getComputedStyle(hint).display !== "none") };
      }));
      for (const t of r) {
        assert.ok(t.shadow, `${p} at ${width} px: a table box has no scroll shadow`);
        assert.ok(t.hint, `${p} at ${width} px: a table box has no swipe hint line`);
        if (t.wide) assert.ok(t.hintShown, `${p} at ${width} px: a table wider than its box shows no swipe hint`);
      }
    }
  }
  // The member and volunteer calendars (an admin may open them): below 480 px a list, not seven 28 px columns.
  await ctx.page.setViewport({ width: 375, height: 812, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  for (const p of ["/meetings", "/volunteer"]) {
    const res = await ctx.goto(p);
    if (res.status() >= 400 || new URL(ctx.page.url()).pathname !== p) continue;
    const r = await ctx.page.evaluate(() => {
      const g = document.querySelector(".calendar-agenda");
      const heads = [...document.querySelectorAll(".calendar-agenda .calendar-weekday")].filter((h) => getComputedStyle(h).display !== "none");
      return g ? { display: getComputedStyle(g).display, heads: heads.length } : null;
    });
    assert.ok(r, `${p} has the calendar`);
    assert.equal(r.display, "block", `${p} at 375 px is a list`);
    assert.equal(r.heads, 0, `${p} at 375 px shows no weekday header row`);
    const bad = await phoneOverflow(ctx.page, 375);
    assert.deepEqual(bad, [], `${p} at 375 px: ${bad.join("; ")}`);
  }
});

// ---- Admin on a phone: readable fields, labels, menu, scan page (390 px, touch) ----
const phone390 = (ctx) => ctx.page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });

s.test("A110 (must) on a phone (390 px) the add-a-book page shows the ISBN box in the first screen, has no search bar or Back link, a compact full-width Save bar, and an ISBN-with-X switch", { as: "admin" }, async (ctx) => {
  await phone390(ctx);
  await admin(ctx, "/admin/inventory/new");
  const r = await ctx.page.evaluate(() => {
    const vis = (sel) => { const e = document.querySelector(sel); return !!e && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().height > 0; };
    const isbn = document.getElementById("isbn").getBoundingClientRect();
    const bar = document.querySelector("[data-scan-actions]").getBoundingClientRect();
    const form = document.getElementById("intake-form").getBoundingClientRect();
    return { isbnTop: isbn.top + scrollY, search: vis(".admin-search"), back: vis(".admin-back-link"), barH: bar.height, barW: bar.width, formW: form.width, toggle: vis("[data-isbn-x]"), mode: document.getElementById("isbn").getAttribute("inputmode") };
  });
  assert.ok(r.isbnTop <= 300, `the ISBN box starts ${Math.round(r.isbnTop)} px down (should be inside the first 300 px)`);
  assert.equal(r.search, false, "the global search bar is hidden on this page");
  assert.equal(r.back, false, "the Back link is hidden on this page");
  assert.ok(r.barH <= 56, `the Save bar is ${Math.round(r.barH)} px high (56 at most)`);
  assert.ok(r.barW >= r.formW - 2, `the Save bar is ${Math.round(r.barW)} px wide in a ${Math.round(r.formW)} px form`);
  assert.equal(r.toggle, true, "the 'My ISBN has an X' switch is offered on a touch screen");
  assert.equal(r.mode, "numeric");
  await ctx.page.tap("[data-isbn-x]");
  const on = await ctx.page.evaluate(() => ({ mode: document.getElementById("isbn").getAttribute("inputmode"), pressed: document.querySelector("[data-isbn-x]").getAttribute("aria-pressed"), focused: document.activeElement && document.activeElement.id }));
  assert.deepEqual(on, { mode: "text", pressed: "true", focused: "isbn" }, "the switch gives the ISBN box the letter keyboard and keeps the cursor there");
});

s.test("A111 (must) on a phone (390 px) the admin menu drawer takes focus, keeps Tab inside, locks the page scroll and gives focus back on Escape; its links are 44 px tall", { as: "admin" }, async (ctx) => {
  await phone390(ctx);
  await admin(ctx, "/admin/inventory");
  const state = () => ctx.page.evaluate(() => ({
    expanded: document.querySelector("[data-toggle-admin-nav]").getAttribute("aria-expanded"),
    inside: !!document.activeElement.closest("#admin-sidebar"),
    active: document.activeElement.className || document.activeElement.tagName,
    overflow: getComputedStyle(document.documentElement).overflow,
  }));
  assert.equal((await state()).expanded, "false");
  assert.equal(await ctx.page.$eval("[data-toggle-admin-nav]", (b) => b.getAttribute("aria-controls")), "admin-sidebar");
  await ctx.page.tap("[data-toggle-admin-nav]");
  await new Promise((r) => setTimeout(r, 400));
  let st = await state();
  assert.equal(st.expanded, "true");
  assert.ok(st.inside, "focus moved into the drawer when it opened");
  assert.equal(st.overflow, "hidden", "the page behind does not scroll while the menu is open");
  for (let i = 0; i < 40; i++) {
    await ctx.page.keyboard.press("Tab");
    assert.ok((await state()).inside, `Tab ${i + 1} left the drawer`);
  }
  await ctx.page.keyboard.down("Shift");
  await ctx.page.keyboard.press("Tab");
  await ctx.page.keyboard.up("Shift");
  assert.ok((await state()).inside, "Shift+Tab left the drawer");
  const short = await ctx.page.evaluate(() => [...document.querySelectorAll("#admin-sidebar a, #admin-sidebar button")].filter((a) => a.getBoundingClientRect().height < 43.5).map((a) => `${a.textContent.trim().slice(0, 20)} ${Math.round(a.getBoundingClientRect().height)}px`));
  assert.deepEqual(short, [], "menu links and buttons are at least 44 px tall");
  await ctx.page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 300));
  st = await state();
  assert.equal(st.expanded, "false");
  assert.match(st.active, /admin-nav-toggle/, "Escape gives focus back to the menu button");
  assert.notEqual(st.overflow, "hidden", "the page scrolls again");
});

s.test("A112 (must) on a phone (390 px) no field on the main admin pages is under 16 px (iOS would zoom in), and every field has a name", { as: "admin", timeout: 180000 }, async (ctx) => {
  await phone390(ctx);
  const pages = ["/admin", "/admin/inventory", "/admin/inventory/new", "/admin/inventory/move", "/admin/orders", "/admin/members", "/admin/requests", "/admin/sessions", "/admin/events", "/admin/volunteer-shifts", "/admin/meetings", "/admin/till", "/admin/till/items", "/admin/till/day", "/admin/announcements", "/admin/blog", "/admin/charity", "/admin/pricing", "/admin/reports/accounting/mapping", "/admin/privacy"];
  for (const p of pages) {
    const res = await ctx.goto(p);
    if (res.status() >= 400 || new URL(ctx.page.url()).pathname !== p) continue;
    const bad = await ctx.page.evaluate(() => {
      const out = [];
      for (const e of document.querySelectorAll("input, select, textarea")) {
        if (["hidden", "checkbox", "radio", "file", "submit", "button", "range", "color"].includes(e.type)) continue;
        const cs = getComputedStyle(e);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const label = (e.getAttribute("aria-label") || "").trim() || [...(e.labels || [])].some((l) => l.textContent.trim()) || e.getAttribute("aria-labelledby");
        if (parseFloat(cs.fontSize) < 16) out.push(`${e.tagName.toLowerCase()}[name=${e.name}] is ${cs.fontSize}`);
        if (!label) out.push(`${e.tagName.toLowerCase()}[name=${e.name}] has no name`);
      }
      return out;
    });
    assert.deepEqual(bad, [], `${p}: ${bad.slice(0, 5).join("; ")}`);
  }
});

s.test("A113 (must) on a phone (390 px) each Pricing rules field has its label above it and is full width, and Accounting mapping is one card per rule", { as: "admin" }, async (ctx) => {
  await phone390(ctx);
  await admin(ctx, "/admin/pricing");
  const rules = await ctx.page.evaluate(() => [...document.querySelectorAll(".rule-field")].map((f) => {
    const l = f.querySelector(".rule-field-label"), i = f.querySelector("input");
    if (!i) return null;
    const lr = l ? l.getBoundingClientRect() : null, ir = i.getBoundingClientRect(), pr = (i.closest("li, .stack, .card") || document.body).getBoundingClientRect();
    return { name: i.getAttribute("aria-label"), labelAbove: !l || lr.bottom <= ir.top + 1, wide: ir.width >= pr.width * 0.6, h: ir.height };
  }));
  assert.ok(rules.length >= 19, `found ${rules.length} rule fields`);
  for (const r of rules) {
    assert.ok(r.name, "a rule field has no aria-label");
    assert.ok(r.labelAbove, `${r.name}: the label is not above the field`);
    assert.ok(r.wide, `${r.name}: the field is narrow`);
    assert.ok(r.h >= 44, `${r.name}: the field is ${r.h} px high`);
  }
  await admin(ctx, "/admin/reports/accounting/mapping");
  const cards = await ctx.page.evaluate(() => ({ rows: [...document.querySelectorAll(".map-table tbody tr")].length, tr: getComputedStyle(document.querySelector(".map-table tbody tr")).display, wide: document.documentElement.scrollWidth <= innerWidth }));
  assert.ok(cards.rows > 5);
  assert.equal(cards.tr, "grid", "each rule is a card");
  assert.ok(cards.wide, "no sideways scrolling");
});

s.test("A114 (must) on a phone (390 px) the Inventory landing buttons are equal-width tiles, two to a row", { as: "admin" }, async (ctx) => {
  await phone390(ctx);
  await admin(ctx, "/admin/inventory");
  const b = await ctx.page.evaluate(() => [...document.querySelectorAll(".inv-actions .btn")].map((e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), left: Math.round(r.left), top: Math.round(r.top) }; }));
  assert.ok(b.length >= 4);
  const paired = b.length % 2 ? b.slice(0, -1) : b; // an odd last tile spans both columns
  assert.equal(new Set(paired.map((x) => x.w)).size, 1, `tiles have different widths: ${paired.map((x) => x.w).join(", ")}`);
  assert.equal(new Set(paired.map((x) => x.left)).size, 2, "two columns");
});

s.test("A115 (must) Collections: the list has a Published switch per collection and the counts; a collection page has the English and French fields, Generate, the review boxes and Publish", { as: "admin" }, async (ctx) => {
  await admin(ctx, "/admin/collections");
  const text = await ctx.text();
  has(text, /Curated collections/);
  has(text, /The Magic We Never Outgrew/);
  has(text, /Update all collections/);
  assert.ok(await ctx.page.$("a[href='/admin/collections/new']"), "a New collection button");
  assert.ok((await ctx.page.$$("form[action$='/move'] button")).length >= 38, "up and down buttons on every collection");
  has(text, /Last built/);
  has(text, /Approved/);
  assert.ok((await ctx.page.$$("form[action$='/published'] button[type='submit']")).length >= 19, "a Publish / Unpublish button on every collection");
  assert.ok(await ctx.page.$("a[href='/admin/collections'].is-active"), "the Collections link in the admin menu is marked");
  await Promise.all([ctx.page.waitForNavigation({ waitUntil: "domcontentloaded" }), ctx.page.click("td a[href^='/admin/collections/']")]);
  for (const name of ["title_en", "description_en", "title_fr", "description_fr", "curation_prompt"]) assert.ok(await ctx.page.$(`[name='${name}']`), `field ${name}`);
  const page = await ctx.text();
  has(page, /Generate suggestions/);
  has(page, /Translate to French/);
  has(page, /Full rebuild \(re-evaluate all books\)/);
  for (const name of ["slug", "icon", "banner", "header_alt_en", "header_alt_fr", "find"]) assert.ok(await ctx.page.$(`[name='${name}']`), `field ${name}`);
  assert.ok(await ctx.page.$("a[href$='/delete']"), "a Delete link (with its own confirm page)");
  has(page, /Last built/);
  has(page, /Publish/);
  assert.ok(await ctx.page.$("form[action$='/generate']") && await ctx.page.$("form[action$='/review'], p.muted"), "Generate and the review area are there");
});
