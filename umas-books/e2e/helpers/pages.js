// Small page-level helpers shared by the scenario files.

const assert = require("node:assert/strict");
const { books, sessionFor } = require("./harness");

// Regex match, case-insensitive (innerText follows CSS text-transform, so
// buttons styled in capitals read as capitals), with a SHORT failure message
// instead of dumping the whole page.
const ci = (re) => new RegExp(re.source, re.flags.includes("i") ? re.flags : `${re.flags}i`);
const peek = (text) => `${String(text).replace(/\s+/g, " ").slice(0, 160)}${String(text).length > 160 ? "..." : ""}`;
const has = (text, re, note = "") => assert.ok(ci(re).test(text), `${note ? `${note}: ` : ""}expected the page to match ${re}; it starts: "${peek(text)}"`);
const hasNot = (text, re, note = "") => assert.ok(!ci(re).test(text), `${note ? `${note}: ` : ""}expected the page NOT to match ${re}`);

// A book with at least one priced copy on the shelf (from the public search API).
async function stockedBook(ctx, pred = () => true) {
  const list = await books();
  const hit = list.find((b) => b.price != null && pred(b));
  if (!hit) ctx.skip("data: the site has no in-stock book matching this step");
  return hit;
}

// Opens a book page and presses Add to Cart on its first copy (the copy
// table's first form). Lands on the cart page. A harmless write: it only
// changes this browser's cart. `lines` is how many lines the cart should hold
// afterwards. The site redirects to /cart straight after the POST, and the
// session (which holds the cart) is saved a few milliseconds later, so on a
// very fast connection the first look at the cart can be one line short: the
// cart is looked at again (up to 3 times) and the race is noted in the output.
async function addFirstCopyToCart(ctx, book, lines = 1) {
  await ctx.goto(`/books/${book.id}`);
  const btn = await ctx.page.$(".copy-table form[action='/cart/add'] button[type='submit']");
  if (!btn) ctx.skip("data: the book page has no Add to Cart button");
  await Promise.all([ctx.page.waitForNavigation({ waitUntil: "domcontentloaded" }), btn.click()]);
  for (let i = 0; i < 3 && (await cartLineCount(ctx)) < lines; i++) {
    console.log(`# note: the cart showed ${await cartLineCount(ctx)} of ${lines} lines right after Add to Cart (the session was saved just after the redirect); looking again`);
    await new Promise((r) => setTimeout(r, 400));
    await ctx.page.reload({ waitUntil: "domcontentloaded" });
  }
}

async function cartLineCount(ctx) {
  return ctx.page.$$eval(".cart-item", (els) => els.length);
}

// Reservations (books and drop-in seats are reserved online and paid in the
// shop; nothing is ever paid by these tests). Cancels every open reservation of
// the logged-in account from its account page, like a person pressing "Cancel
// reservation" on each. Used to clean up what a test reserved.
const CANCEL_RESERVATION = "form[action^='/cart/reservations/'] button[type='submit']";
async function cancelOpenReservations(ctx) {
  for (let i = 0; i < 12; i++) {
    await ctx.goto("/account");
    const btn = await ctx.page.$(CANCEL_RESERVATION);
    if (!btn) return i;
    await Promise.all([ctx.page.waitForNavigation({ waitUntil: "domcontentloaded" }), btn.click()]); // the confirm box is accepted by the harness
  }
  return 12;
}
const openReservationCount = async (ctx) => { await ctx.goto("/account"); return (await ctx.page.$$(CANCEL_RESERVATION)).length; };

// The site allows 10 reservation requests an hour from one address. A full run uses about 10, so a test that
// hits the limit is skipped with this reason (wait an hour, or run the personas one by one).
const RATE_LIMITED = "the site's limit of 10 reservation requests an hour from one address was reached: wait an hour, or run this persona on its own";

// From the cart page, fills the reserve form (the name is the test tag) and presses "Reserve (free, no commitment)".
// Lands on the reservation page (/cart/return?order=<token>) when it works, else back on the cart with a message.
async function pressReserve(ctx, who) {
  const sel = "form[action='/cart/reserve']";
  await ctx.page.$eval(`${sel} #name`, (i) => { i.value = ""; });
  await ctx.page.type(`${sel} #name`, `${process.env.E2E_RUN_ID} ${who}`);
  await ctx.page.click(`${sel} input[name='acceptCgv']`);
  const [nav] = await Promise.all([ctx.page.waitForNavigation({ waitUntil: "domcontentloaded" }), ctx.page.click(`${sel} button[type='submit']`)]);
  if (nav && nav.status() === 429) ctx.skip(RATE_LIMITED);
  const u = new URL(ctx.page.url());
  return { ok: u.pathname === "/cart/return", token: u.searchParams.get("order") };
}

// Plain `fetch` of a page's HTML in a given language (no browser).
async function pageHtml(ctx, path, lang) {
  const res = await fetch(ctx.url(path), { headers: lang ? { cookie: `umasbooks_lang=${lang}` } : {} });
  return { status: res.status, html: await res.text(), headers: res.headers };
}

const stripTags = (html) => String(html).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&#39;|&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

// Words that only English text contains. A French page must not carry
// whole English sentences: used for "no English paragraphs left".
const EN_ONLY = [/\bthe\b.*\bof\b.*\bthe\b/i, /\byou can\b/i, /\bplease\b/i, /\bshall\b/i, /\bhereby\b/i, /\bour\b.*\bwe\b/i];

// ---- reservations made as the account-holder test login by plain HTTP (no browser window) ----
// For the admin tests, which need a reservation to work on while the admin is logged in in the browser.
// Uses the account persona's saved login; nothing is paid (nothing can be paid online for books and seats).
// Returns { id, token, copyIds }. Skips the test when the site has too few books on its shelves.
async function reserveViaHttp(ctx, who, count = 1) {
  const jar = new Map((await sessionFor("account")).filter((c) => c.name !== "umasbooks_lang").map((c) => [c.name, c.value]));
  const call = async (method, path, form) => {
    const headers = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
    let body;
    if (form) { body = new URLSearchParams(form); headers["content-type"] = "application/x-www-form-urlencoded"; }
    const res = await fetch(ctx.url(path), { method, headers, body, redirect: "manual" });
    for (const sc of res.headers.getSetCookie()) { const kv = sc.split(";")[0]; const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
    return res;
  };
  const csrf = async () => (await (await call("GET", "/api/csrf-token")).json()).token;
  // An empty cart first (the login session is shared with the other tests).
  const cartHtml = await (await call("GET", "/cart")).text();
  for (const m of cartHtml.matchAll(/name="lineId" value="(\d+)"/g)) await call("POST", "/cart/remove", { _csrf: await csrf(), lineId: m[1] });
  // Copies on the shelves (the public book pages list them with their Add to Cart forms).
  const copyIds = [];
  for (const b of (await books()).filter((x) => x.price != null)) {
    const html = await (await fetch(ctx.url(`/books/${b.id}`))).text();
    for (const m of html.matchAll(/action="\/cart\/add"[\s\S]*?name="copyId" value="(\d+)"/g)) if (copyIds.length < count && !copyIds.includes(m[1])) copyIds.push(m[1]);
    if (copyIds.length >= count) break;
  }
  if (copyIds.length < count) ctx.skip(`data: the site has only ${copyIds.length} copies on its shelves, this step needs ${count}`);
  for (const id of copyIds) await call("POST", "/cart/add", { _csrf: await csrf(), copyId: id });
  const res = await call("POST", "/cart/reserve", { _csrf: await csrf(), name: `${process.env.E2E_RUN_ID} ${who}`, acceptCgv: "on" });
  if (res.status === 429) ctx.skip(RATE_LIMITED);
  const where = res.headers.get("location") || "";
  const token = (where.match(/order=([0-9a-f-]{36})/i) || [])[1];
  assert.ok(token, `the reservation was not made (answered ${res.status}, ${where || "no redirect"})`);
  const page = await (await fetch(ctx.url(`/cart/return?order=${token}`))).text();
  const id = Number((page.match(/Reservation #(\d+) recorded/) || [])[1]);
  assert.ok(id, "the reservation page shows its number");
  return { id, token, copyIds: copyIds.map(Number) };
}

module.exports = { reserveViaHttp, has, hasNot, stockedBook, addFirstCopyToCart, cartLineCount, cancelOpenReservations, openReservationCount, pressReserve, pageHtml, stripTags, EN_ONLY };
