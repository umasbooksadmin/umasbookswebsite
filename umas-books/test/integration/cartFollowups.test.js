// Follow-ups from the 2026-10-27 reviews, on the REAL app (startTestApp: real CSRF check, sessions, templates):
//   H4  a visitor with something in the cart who reaches the log-in or sign-up page is told their books are waiting in the cart
//       (English and French) and is offered the guest checkout (GET /cart/guest); in preview mode the guest offer is left out
//       (nothing can be reserved yet); an empty cart gets no notice
//   H10 the header's cart link carries a visible count badge (shown by CSS on phones), with the count in the page already
//   H11 a book with several copies at different prices says "from <lowest price>" on its card and on the book page's
//       "More by" cards; the choose button has its own icon
// Ports 6551 (normal mode) and 6552 (preview mode) are reserved for this file.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Client } = require("pg");
const { loadSheet } = require("../helpers/css");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

let app;
let preview;
let pool;
let ipSeq = 1;
const newIp = () => `10.98.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
const id = {};
const copy = {};

async function addBook(title, authors, copies) {
  const { rows } = await pool.query(
    "INSERT INTO books (title, authors, categories, binding, description) VALUES ($1, $2, 'Fiction', 'trade', 'x') RETURNING id",
    [title, authors]
  );
  id[title] = rows[0].id;
  copy[title] = [];
  for (const [price, condition] of copies) {
    const r = await pool.query("INSERT INTO book_copies (book_id, condition, price, status) VALUES ($1, $2, $3, 'in_stock') RETURNING id", [rows[0].id, condition, price]);
    copy[title].push(r.rows[0].id);
  }
}

before(async () => {
  app = await startTestApp({ port: 6551, isolated: true, env: { ANTHROPIC_API_KEY: "", ANON_SESSION_LIMIT: "100000", PREVIEW_MODE: "" } });
  preview = await startTestApp({ port: 6552, isolated: true, env: { ANTHROPIC_API_KEY: "", ANON_SESSION_LIMIT: "100000", PREVIEW_MODE: "true" } });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  await addBook("Follow Single", "Follow Author", [[5, "very_good"]]);
  await addBook("Follow Two Prices", "Follow Author", [[6, "very_good"], [3.5, "acceptable"]]);
  await addBook("Follow Same Price", "Follow Author", [[4, "good"], [4, "very_good"]]);
  await addBook("Follow Three Prices", "Other Author", [[9, "good"], [5, "acceptable"], [12, "like_new"]]);
});
after(async () => {
  if (pool) await pool.end();
  if (app) await app.stop();
  if (preview) await preview.stop();
});

// One visitor of one of the apps: a cookie jar and their own client address.
function visitor(server = app, lang) {
  const jar = makeCookieJar();
  const ip = newIp();
  const headers = (extra = {}) => ({ cookie: [jar.header(), lang ? `umasbooks_lang=${lang}` : ""].filter(Boolean).join("; "), "x-forwarded-for": ip, ...extra });
  return {
    async get(p, extra) { const r = await fetch(`${server.base}${p}`, { redirect: "manual", headers: headers(extra) }); jar.capture(r); return r; },
    async post(p, body, extra) {
      const r = await fetch(`${server.base}${p}`, { method: "POST", redirect: "manual", headers: headers({ "content-type": "application/x-www-form-urlencoded", ...extra }), body: new URLSearchParams(body).toString() });
      jar.capture(r);
      return r;
    },
    async addToCart(copyId) {
      const token = await fetchCsrfToken(server.base, jar, { "x-forwarded-for": ip });
      const r = await this.post("/cart/add", { copyId, backTo: "/", via: "card", _csrf: token }, { accept: "application/json" });
      assert.equal((await r.json()).ok, true, `copy ${copyId} is in the cart`);
    },
  };
}
const text = async (r) => (await r).text();

// ---------------------------------------------------------------- H4
test("H4: an empty cart gets the plain log-in and sign-up pages (no notice)", async () => {
  const v = visitor();
  for (const p of ["/login", "/signup"]) {
    const html = await text(v.get(p));
    assert.doesNotMatch(html, /cart-waiting|waiting in your cart/, p);
  }
});

test("H4: with a book in the cart, log-in and sign-up say so and offer the guest checkout and the cart", async () => {
  const v = visitor();
  await v.addToCart(copy["Follow Single"][0]);
  for (const p of ["/login", "/signup", "/login?returnTo=%2Fcart", "/signup?returnTo=%2Fcart"]) {
    const html = await text(v.get(p));
    assert.match(html, /<div role="status" class="notice-box cart-waiting" id="cart-waiting">/, p);
    assert.match(html, /Your books are waiting in your cart/, p);
    assert.match(html, /<a class="btn btn-small" href="\/cart\/guest">Reserve as a guest<\/a>/, `${p}: guest checkout offered`);
    assert.match(html, /<a class="tap-link" href="\/cart">View your cart<\/a>/, p);
    assert.equal((html.match(/id="cart-waiting"/g) || []).length, 1, `${p}: one notice`);
    assert.doesNotMatch(html, /Log in or create an account to reserve\. Your cart is kept\./, `${p}: the older returnTo=/cart note is not repeated`);
  }
  // and the link leads somewhere: the guest form lists the cart
  const guest = await v.get("/cart/guest");
  assert.equal(guest.status, 200);
  assert.match(await guest.text(), /Follow Single/);
});

test("H4: the same in French", async () => {
  const v = visitor(app, "fr");
  await v.addToCart(copy["Follow Single"][0]);
  const html = await text(v.get("/login"));
  assert.match(html, /Vos livres vous attendent dans votre panier/);
  assert.match(html, /<a class="btn btn-small" href="\/cart\/guest">Réserver en tant qu’invité<\/a>/);
  assert.match(html, /<a class="tap-link" href="\/cart">Voir votre panier<\/a>/);
  assert.doesNotMatch(html, /waiting in your cart|Reserve as a guest/);
});

test("H4: the older returnTo=/cart note still shows for an empty cart", async () => {
  const html = await text(visitor().get("/login?returnTo=%2Fcart"));
  assert.match(html, /Log in or create an account to reserve\. Your cart is kept\./);
  assert.doesNotMatch(html, /cart-waiting/);
});

test("H4: in preview mode (nothing can be reserved yet) the notice does not offer the guest form", async () => {
  const db = new Client({ connectionString: preview.databaseUrl });
  await db.connect();
  const { rows: b } = await db.query("INSERT INTO books (title, authors) VALUES ('Preview Single', 'P') RETURNING id");
  const { rows: c } = await db.query("INSERT INTO book_copies (book_id, condition, price, status) VALUES ($1, 'good', 5, 'in_stock') RETURNING id", [b[0].id]);
  await db.end();
  const v = visitor(preview);
  await v.addToCart(c[0].id);
  const html = await text(v.get("/login"));
  assert.match(html, /Your books are waiting in your cart/);
  assert.match(html, /Online reservations open when we launch\. Your cart is kept/);
  assert.match(html, /<a class="tap-link" href="\/cart">View your cart<\/a>/);
  assert.doesNotMatch(html, /\/cart\/guest/);
});

// ---------------------------------------------------------------- H10
const BADGE = '<span class="h-cart-badge" data-cart-badge aria-hidden="true" hidden></span>';

test("H10: every page's header carries the cart badge (hidden, aria-hidden), and the link keeps its spoken name 'Cart (n)'", async () => {
  const v = visitor();
  for (const p of ["/books.html", "/", "/login", "/cart", "/fr/books.html"]) {
    const html = await text(v.get(p));
    assert.ok(html.includes(BADGE), `${p}: badge present`);
    assert.match(html, /<a class="h-tool h-cart" href="\/cart">/, p);
    assert.match(html, /<span class="label"><span data-i18n="tool.cart">(Cart|Panier)<\/span> \(<span data-cart-count>0<\/span>\)<\/span>/, `${p}: the link's own label still carries the count for screen readers`);
  }
});

test("H10: the badge is only drawn in the phone header; the number is written by assets/site.js and public/cart-add.js", () => {
  const header = loadSheet("public/site-header.css");
  assert.equal(header.getDecl("header.mkt-header .h-cart-badge", "display"), "none", "not on computers: the label says Cart (n) there");
  const phone = { at: "@media (max-width: 640px), (max-height: 500px) and (max-width: 1000px)" };
  assert.equal(header.getDecl("header.mkt-header .h-cart-badge", "display", phone), "flex", "on phones");
  assert.equal(header.getDecl("header.mkt-header .h-cart-badge", "position", phone), "absolute", "it overlays the icon: nothing moves when it appears");
  assert.equal(header.getDecl("header.mkt-header .h-cart-badge[hidden]", "display", phone), "none", "hidden when the cart is empty");
  assert.equal(header.getDecl("header.mkt-header .h-cart", "position"), "relative");

  // assets/site.js: window.UmasShowCartCount(n) sets the label, and shows / hides the badge
  const els = (names) => names.map((n) => ({ textContent: "", hidden: true, n }));
  const counts = els(["a"]);
  const badges = els(["b"]);
  const window = {};
  const document = { querySelectorAll: (sel) => (sel === "[data-cart-count]" ? counts : sel === "[data-cart-badge]" ? badges : []), querySelector: () => null, addEventListener: () => {}, readyState: "loading", documentElement: { lang: "en" }, cookie: "" };
  try {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "..", "..", "assets", "site.js"), "utf8"), { window, document, location: { pathname: "/", search: "" }, navigator: {}, setTimeout, console, localStorage: { getItem: () => null, setItem: () => {} } });
  } catch { /* the rest of site.js may need a fuller page; the helper is defined first */ }
  assert.equal(typeof window.UmasShowCartCount, "function", "site.js exposes the helper");
  window.UmasShowCartCount(3);
  assert.deepEqual([counts[0].textContent, badges[0].textContent, badges[0].hidden], ["3", "3", false]);
  window.UmasShowCartCount(0);
  assert.deepEqual([counts[0].textContent, badges[0].textContent, badges[0].hidden], ["0", "0", true]);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "..", "public", "cart-add.js"), "utf8"), /window\.UmasShowCartCount\(data\.cartCount\)/, "cart-add.js uses it after an add");
});

test("H10 in headless Chrome at 375px: adding a book from a card shows the number on the cart icon, still there on the next page", async (t) => {
  let browser;
  try { browser = await require("puppeteer").launch({ headless: true, args: ["--no-sandbox"] }); } catch (err) { return t.skip(`no headless Chrome available: ${String(err.message).split("\n")[0]}`); }
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 375, height: 740, isMobile: true, hasTouch: true });
    await page.setExtraHTTPHeaders({ "x-forwarded-for": newIp() });
    await page.goto(`${app.base}/books.html`, { waitUntil: "networkidle0" });
    const badge = () => page.$eval("[data-cart-badge]", (b) => ({ shown: getComputedStyle(b).display !== "none" && !b.hidden, text: b.textContent, w: b.getBoundingClientRect().width }));
    assert.equal((await badge()).shown, false, "empty cart: no badge");
    await page.waitForSelector(".bk-cart-add button");
    await page.click(".bk-cart-add button");
    await page.waitForFunction(() => !document.querySelector("[data-cart-badge]").hidden, { timeout: 8000 });
    const b = await badge();
    assert.equal(b.shown, true);
    assert.equal(b.text, "1");
    assert.ok(b.w >= 18, "a readable badge");
    assert.equal(await page.$eval("a.h-cart", (a) => a.getAttribute("aria-label")), null, "named by its text, not a label that could go stale");
    await page.goto(`${app.base}/cart`, { waitUntil: "networkidle0" });
    assert.deepEqual(await badge().then((x) => [x.shown, x.text]), [true, "1"], "the next page shows it too");
  } finally {
    await browser.close();
  }
});
