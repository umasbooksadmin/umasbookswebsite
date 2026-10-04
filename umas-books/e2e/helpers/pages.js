// Small page-level helpers shared by the scenario files.

const assert = require("node:assert/strict");
const { books } = require("./harness");

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

// Plain `fetch` of a page's HTML in a given language (no browser).
async function pageHtml(ctx, path, lang) {
  const res = await fetch(ctx.url(path), { headers: lang ? { cookie: `umasbooks_lang=${lang}` } : {} });
  return { status: res.status, html: await res.text(), headers: res.headers };
}

const stripTags = (html) => String(html).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&#39;|&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

// Words that only English text contains. A French page must not carry
// whole English sentences: used for "no English paragraphs left".
const EN_ONLY = [/\bthe\b.*\bof\b.*\bthe\b/i, /\byou can\b/i, /\bplease\b/i, /\bshall\b/i, /\bhereby\b/i, /\bour\b.*\bwe\b/i];

module.exports = { has, hasNot, stockedBook, addFirstCopyToCart, cartLineCount, pageHtml, stripTags, EN_ONLY };
