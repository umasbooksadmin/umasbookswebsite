// Script 6 of docs/testing/manual-test-scripts.md (edge and negative tests)
// plus the cross-cutting checks the manual script cannot do by eye: security
// headers and cookies, a link crawl, accessibility basics, keyboard focus,
// 375 px layouts. Ids starting with X are those extras.

const assert = require("node:assert/strict");
const e2e = require("../helpers/harness");
const { has, hasNot, stockedBook, addFirstCopyToCart, cartLineCount } = require("../helpers/pages");
const cfg = require("../helpers/config");

const s = e2e.persona("edge");
const PHONE = { width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const noOverflow = async (ctx, label) => {
  const m = await ctx.page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth, body: document.body.scrollWidth }));
  assert.ok(m.scroll <= m.inner && m.body <= m.inner, `${label}: horizontal scroll (document ${m.scroll}px, body ${m.body}px, window ${m.inner}px)`);
};

// ---- Script 6 ----

s.test("E1 (must) a form sent after the session cookie was deleted shows the plain 'session expired' page", async (ctx) => {
  await ctx.goto("/login");
  await ctx.page.type("form[action='/login'] #email", cfg.testEmail("csrf"));
  await ctx.page.type("form[action='/login'] #password", "Not-A-Real-Password-1!");
  await ctx.page.deleteCookie(...(await ctx.cookies()).filter((c) => c.name === "umasbooks.sid"));
  const [res] = await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/login'] button[type='submit']")]);
  assert.equal(res.status(), 403);
  has(await ctx.text(), /Your session expired or this form is out of date\. Please go back and try again\./);
  // Go back, reload, try again: the form works again (a wrong password is a normal answer, not an error page).
  await ctx.goto("/login");
  await ctx.page.type("form[action='/login'] #email", cfg.testEmail("csrf"));
  await ctx.page.type("form[action='/login'] #password", "Not-A-Real-Password-1!");
  const [again] = await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/login'] button[type='submit']")]);
  assert.equal(again.status(), 401);
  has(await ctx.text(), /Incorrect email or password\./);
});

s.test("X6 the expired-session page is translated when the site is in French", { lang: "fr" }, async (ctx) => {
  await ctx.goto("/login");
  await ctx.page.type("form[action='/login'] #email", cfg.testEmail("csrf-fr"));
  await ctx.page.type("form[action='/login'] #password", "Not-A-Real-Password-1!");
  await ctx.page.deleteCookie(...(await ctx.cookies()).filter((c) => c.name === "umasbooks.sid"));
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/login'] button[type='submit']")]);
  hasNot(await ctx.text(), /Your session expired/);
  has(await ctx.text(), /Votre session a expiré/);
});

s.write("E2 (must) two Order with obligation to pay requests at the same moment start ONE checkout, not two (payments on; needs the account-holder login, because buying needs an account)", { as: "account" }, async (ctx) => {
  if (ctx.preview) ctx.skip("preview mode: there is no Order with obligation to pay button");
  const book = await stockedBook(ctx);
  await addFirstCopyToCart(ctx, book);
  if (!(await ctx.page.$("form[action='/cart/checkout']"))) ctx.skip("payments are not switched on");
  const tag = process.env.E2E_RUN_ID;
  const email = cfg.testEmail("double-click");
  // What a double-click sends: the same form twice at once. Sent from the page with fetch (redirects are
  // not followed, so nothing is opened and HelloAsso is never contacted by the browser).
  const results = await ctx.page.evaluate(async (name, mail) => {
    const { token } = await (await fetch("/api/csrf-token")).json();
    const send = () => fetch("/cart/checkout", { method: "POST", redirect: "manual", body: new URLSearchParams({ _csrf: token, name, email: mail, acceptCgv: "on" }) }).then((r) => ({ type: r.type, status: r.status }));
    return Promise.all([send(), send()]);
  }, `${tag} Double Click`, email);
  ctx.created("unpaid order from the double-submit test (never paid, expires by itself)", `${tag} Double Click <${email}>`, "admin Orders: there must be only ONE pending order for it");
  const redirects = results.filter((r) => r.type === "opaqueredirect").length;
  assert.equal(redirects, 1, `exactly one of the two requests may start a checkout; got ${JSON.stringify(results)}`);
});

s.test("E2b double-clicking Add to Cart adds the copy once", async (ctx) => {
  const book = await stockedBook(ctx);
  await ctx.goto(`/books/${book.id}`);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click(".copy-table form[action='/cart/add'] button", { count: 2, delay: 10 })]).catch(() => {});
  await ctx.goto("/cart");
  assert.equal(await cartLineCount(ctx), 1);
});

s.test("E3 (must) the back button after cart actions shows no error page and the cart stays consistent", async (ctx) => {
  const book = await stockedBook(ctx);
  await addFirstCopyToCart(ctx, book);
  assert.equal(await cartLineCount(ctx), 1);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click(".cart-item form[action='/cart/remove'] button")]);
  assert.equal(await cartLineCount(ctx), 0);
  await ctx.page.goBack({ waitUntil: "domcontentloaded" }); // back to the page that still shows the line
  hasNot(await ctx.text(), /Something went wrong|session expired|Cannot POST/);
  const stale = await ctx.page.$(".cart-item form[action='/cart/remove'] button");
  if (stale) {
    await Promise.all([ctx.page.waitForNavigation(), stale.click()]); // Remove again on the old page
    hasNot(await ctx.text(), /Something went wrong|session expired|Cannot POST/);
  }
  await ctx.page.goForward({ waitUntil: "domcontentloaded" }).catch(() => {});
  await ctx.goto("/cart");
  assert.equal(await cartLineCount(ctx), 0, "the cart is empty");
});

s.manual("E4 (must) the HelloAsso page's back link returns to the cart", "needs the HelloAsso page, which the tests never load");

const MOBILE_PAGES = async (ctx) => {
  const book = await stockedBook(ctx);
  return [["home", "/"], ["books", "/books.html"], ["book page with copies table", `/books/${book.id}`], ["events", "/events"], ["contact", "/contact"], ["login", "/login"], ["membership", "/membership.html"]];
};

for (const lang of ["en", "fr"]) {
  s.test(`E5 (must) 375 px layout in ${lang.toUpperCase()}: no sideways scrolling on the main pages, copies table and tap targets usable`, { viewport: PHONE, lang }, async (ctx) => {
    for (const [label, p] of await MOBILE_PAGES(ctx)) {
      await ctx.goto(p, "networkidle2");
      await noOverflow(ctx, `${label} (${lang})`);
    }
    // The copies table: inside the window, and tap targets big enough.
    const book = await stockedBook(ctx);
    await ctx.goto(`/books/${book.id}`);
    const table = await ctx.page.$eval(".copy-table", (t) => { const r = t.getBoundingClientRect(); return { left: r.left, right: r.right, width: window.innerWidth }; });
    assert.ok(table.left >= -1 && table.right <= table.width + 1, `copies table ${JSON.stringify(table)} sticks out of the screen`);
    const small = await ctx.page.$$eval(".copy-table button, .copy-table a", (els) => els.map((e) => ({ text: e.textContent.trim().slice(0, 20), w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) })).filter((r) => r.h < 24 || r.w < 24));
    assert.deepEqual(small, [], "Add to Cart buttons should be at least 24 px tall and wide (WCAG 2.2 AA minimum target size)");
    // The cart and the checkout form.
    await addFirstCopyToCart(ctx, book);
    await noOverflow(ctx, `cart (${lang})`);
    if (await ctx.page.$("form[action='/cart/checkout']")) {
      const reach = await ctx.page.$eval("form[action='/cart/checkout'] button[type='submit']", (b) => { b.scrollIntoView(); const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth && r.height >= 24; });
      assert.ok(reach, "Order with obligation to pay is reachable and at least 24 px tall");
      await noOverflow(ctx, `checkout form (${lang})`);
    }
  });
}

s.test("E6 in preview mode on a phone the banner does not cover the menu or the cart button", { viewport: PHONE }, async (ctx) => {
  if (!ctx.preview) ctx.skip("the site is not in preview mode");
  await ctx.goto("/", "networkidle2");
  const m = await ctx.page.evaluate(() => {
    const banner = document.querySelector(".preview-banner").getBoundingClientRect();
    const cart = document.querySelector("a.h-tool[href='/cart']");
    const r = cart.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { bannerBottom: banner.bottom, headerTop: document.querySelector("header").getBoundingClientRect().top, cartTopmost: hit === cart || cart.contains(hit), position: getComputedStyle(document.querySelector(".preview-banner")).position };
  });
  assert.ok(m.cartTopmost, "the cart button is covered by something");
  assert.ok(m.headerTop >= m.bannerBottom - 1 || m.position !== "fixed", `banner (bottom ${m.bannerBottom}) overlaps the header (top ${m.headerTop})`);
});

s.manual("E7 changing the password in one browser logs the other browser out", "needs two real browsers and changes the account's password");

s.test("E8 a logged-in account holder opening /admin sees 'Admins only.'; a guest gets the login page", { anon: true, as: "account" }, async (ctx) => {
  const res = await ctx.goto("/admin");
  assert.ok([401, 403].includes(res.status()), `status ${res.status()}`);
  has(await ctx.text(), /Admins only\./);
  const guest = await ctx.fetchRaw("/admin", { headers: { cookie: "" } });
  assert.ok([301, 302, 303, 307].includes(guest.status), "a guest is redirected to the login page");
  assert.match(guest.headers.get("location") || "", /\/login/);
});

s.test("E9 a 300-character book request title is refused with a clear message (nothing is created)", async (ctx) => {
  await ctx.goto("/request-a-book");
  const r = await ctx.page.evaluate(async (title) => {
    const { token } = await (await fetch("/api/csrf-token")).json();
    const res = await fetch("/request-a-book", { method: "POST", body: new URLSearchParams({ _csrf: token, title, email: "e2e-too-long@example.invalid", website: "" }) });
    return { status: res.status, body: await res.text() };
  }, "T".repeat(300));
  assert.ok(r.status >= 400 && r.status < 500, `status ${r.status}`);
  has(r.body, /Something you typed is too long\. Titles can have up to 200 characters and notes up to 500\./);
});

s.write("E9b a 6000-character contact message does not crash (it is cut to 5000 and sent, tagged)", async (ctx) => {
  await ctx.goto("/contact");
  await ctx.page.type("#c-name", `${process.env.E2E_RUN_ID} Long Message`);
  await ctx.page.type("#c-email", cfg.testEmail("long-message"));
  await ctx.page.$eval("#c-message", (t, text) => { t.removeAttribute("maxlength"); t.value = text; }, `${process.env.E2E_RUN_ID} automated test, please ignore. ${"x".repeat(6000)}`);
  const [res] = await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/contact'] button[type='submit']")]);
  assert.ok(res.status() < 500, `status ${res.status()}`);
  has(await ctx.text(), /Thank you|Merci/);
  ctx.created("contact message, 6000 characters (email to the admin mailbox)", `${process.env.E2E_RUN_ID} Long Message`, "delete the email from the shop mailbox");
});

s.test("E10 (must) with the browser in French and no choice made, the first visit is in French", { lang: null, browserLang: "fr-FR" }, async (ctx) => {
  for (const p of ["/", "/contact", "/cart"]) {
    await ctx.goto(p, "networkidle2");
    assert.equal(await ctx.page.$eval("html", (h) => h.lang), "fr", `${p} is not French on a first visit`);
  }
  has(await ctx.text(), /Panier/);
  // The mirror image: an English browser stays in English.
});

s.test("E10b with the browser in English and no choice made, the first visit is in English", { lang: null, browserLang: "en-GB" }, async (ctx) => {
  await ctx.goto("/", "networkidle2");
  assert.equal(await ctx.page.$eval("html", (h) => h.lang), "en");
});

// ---- Cross-cutting checks (X) ----

s.test("X1 security headers: CSP, no server version leak, nosniff, and HSTS over https", async (ctx) => {
  for (const p of ["/", "/login", "/books.html", "/api/books/search?q=a"]) {
    const res = await fetch(ctx.url(p), { redirect: "manual" });
    const csp = res.headers.get("content-security-policy") || "";
    assert.match(csp, /default-src 'self'/, `${p} has no CSP`);
    assert.match(csp, /object-src 'none'/, `${p} CSP`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", `${p} nosniff`);
    assert.equal(res.headers.get("x-powered-by"), null, `${p} leaks X-Powered-By`);
    const server = res.headers.get("server") || "";
    assert.ok(!/\d+\.\d+/.test(server) && !/express|node/i.test(server), `${p} leaks a server version: ${server}`);
    if (ctx.isHttps) assert.match(res.headers.get("strict-transport-security") || "", /max-age=\d{6,}/, `${p} HSTS over https`);
    if (!/^\/(api|books\.html)/.test(p)) assert.match(csp, /frame-ancestors 'none'|frame-ancestors 'self'/, `${p} framing`);
  }
});

s.test("X2 the session cookie is HttpOnly, SameSite and (over https) Secure", async (ctx) => {
  const res = await fetch(ctx.url("/api/csrf-token"), { redirect: "manual" });
  const cookies = res.headers.getSetCookie();
  const sid = cookies.find((c) => c.startsWith("umasbooks.sid="));
  assert.ok(sid, `no session cookie in ${cookies.map((c) => c.split("=")[0])}`);
  assert.match(sid, /HttpOnly/i);
  assert.match(sid, /SameSite=(Lax|Strict)/i);
  if (ctx.isHttps) assert.match(sid, /;\s*Secure/i, "session cookie must be Secure over https");
  else console.log("# X2 note: the Secure flag is only checked on https targets");
});

s.test("X3 every internal link on the home page, Browse Books and the footer answers 2xx/3xx; no mixed content; same-site images load", async (ctx) => {
  const pages = ["/", "/books.html", "/about.html", "/events", "/contact"];
  const links = new Set();
  const mixed = [];
  const brokenImages = [];
  for (const p of pages) {
    await ctx.goto(p, "networkidle2");
    const found = await ctx.page.evaluate(() => ({
      links: [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")),
      http: [...document.querySelectorAll("[src], link[href]")].map((e) => e.getAttribute("src") || e.getAttribute("href")).filter((u) => /^http:\/\//i.test(u || "")),
      imgs: [...document.images].filter((i) => i.currentSrc && new URL(i.currentSrc).origin === location.origin && i.complete && i.naturalWidth === 0).map((i) => i.currentSrc),
    }));
    for (const h of found.links) {
      if (!h || /^(mailto:|tel:|sms:|javascript:|#)/i.test(h)) continue;
      const u = new URL(h, ctx.url(p));
      if (u.origin === new URL(ctx.base).origin && !/[?&](month|week|view|format)=/.test(u.search)) links.add(u.pathname + u.search);
    }
    if (ctx.isHttps) mixed.push(...found.http);
    brokenImages.push(...found.imgs);
  }
  const bad = [];
  for (const l of links) {
    const res = await fetch(ctx.url(l), { redirect: "manual" });
    if (res.status >= 400) bad.push(`${l} -> ${res.status}`);
  }
  assert.deepEqual(bad, [], `broken links: ${bad.join(", ")}`);
  assert.deepEqual(mixed, [], "http:// resources on an https page");
  assert.deepEqual(brokenImages, [], "images that did not load");
  assert.ok(links.size >= 10, `only ${links.size} internal links found`);
});

const A11Y_PAGES = ["/", "/books.html", "/cart", "/login", "/signup", "/contact", "/events", "/request-a-book", "/terms-of-sale.html", "/no-such-page"];
for (const lang of ["en", "fr"]) {
  s.test(`X4 accessibility basics in ${lang.toUpperCase()}: one h1, labelled fields, html lang matches the language`, { lang }, async (ctx) => {
    const book = await stockedBook(ctx);
    for (const p of A11Y_PAGES.concat([`/books/${book.id}`])) {
      await ctx.goto(p, "networkidle2");
      const r = await ctx.page.evaluate(() => {
        const visible = (e) => { const st = getComputedStyle(e); const b = e.getBoundingClientRect(); return st.display !== "none" && st.visibility !== "hidden" && (b.width > 0 || b.height > 0) && !e.closest("[hidden],[aria-hidden='true']"); };
        const unlabeled = [...document.querySelectorAll("input:not([type='hidden']):not([type='submit']):not([type='button']), select, textarea")]
          .filter(visible)
          .filter((e) => !(e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)) && !e.closest("label") && !e.getAttribute("aria-label") && !e.getAttribute("aria-labelledby"))
          .map((e) => e.name || e.id || e.type);
        return { h1: [...document.querySelectorAll("h1")].filter(visible).length, lang: document.documentElement.lang, unlabeled };
      });
      assert.equal(r.h1, 1, `${p}: ${r.h1} visible h1`);
      assert.equal(r.lang, lang, `${p}: <html lang="${r.lang}"> but the page is ${lang}`);
      assert.deepEqual(r.unlabeled, [], `${p}: fields without a label`);
    }
  });
}

s.test("X5 keyboard: the skip link comes first and the login form is reachable in order with a visible focus", async (ctx) => {
  await ctx.goto("/login");
  const seen = [];
  for (let i = 0; i < 40; i++) {
    await ctx.page.keyboard.press("Tab");
    const f = await ctx.page.evaluate(() => {
      const e = document.activeElement;
      const st = getComputedStyle(e);
      return { tag: e.tagName, id: e.id, cls: e.className, href: e.getAttribute("href"), type: e.getAttribute("type"), outline: st.outlineStyle !== "none" && parseFloat(st.outlineWidth) > 0 || st.boxShadow !== "none" };
    });
    seen.push(f);
  }
  assert.match(String(seen[0].cls), /skip-link/, "the first Tab stop is the skip link");
  const order = seen.map((f) => f.id || "").filter(Boolean);
  const e = order.indexOf("email");
  const p = order.indexOf("password");
  assert.ok(e >= 0 && p > e, `email then password in the Tab order: ${order}`);
  const focused = seen.filter((f) => f.id === "email" || f.id === "password");
  assert.ok(focused.every((f) => f.outline), "a visible focus indicator on the login fields");
});

s.test("X7 safety self-check: the test browser cannot open any HelloAsso page", async (ctx) => {
  await assert.rejects(() => ctx.goto("https://www.helloasso.com/", "domcontentloaded"), /ERR_BLOCKED_BY_CLIENT|net::ERR/);
  assert.ok(ctx.blocked.some((u) => /helloasso\.com/.test(u)), "the attempt was recorded as blocked");
  await ctx.goto("/membership.html");
  const framed = await ctx.page.$$eval("iframe", (f) => f.map((x) => x.src).filter((u) => /helloasso/.test(u)));
  for (const url of framed) assert.ok(ctx.blocked.some((b) => b.startsWith(url.split("?")[0])), `iframe ${url} was not blocked`);
});
