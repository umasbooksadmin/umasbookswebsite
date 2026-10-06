// Generic "is this page fully translated?" check. Each page in PAGES is
// rendered in English and in French by the real app, and untranslated()
// (test/helpers/i18nAudit.js) must find no text that is identical in both.
//
// HOW TO USE (follow-up translation PRs): once a customer-facing GET page is
// translated, append its path to PAGES below. Pages that need a login or
// special data are not covered here; test those in their own file with the
// same untranslated() helper. Text that is legitimately the same in both
// languages (a brand name, a legal identifier) goes in EXTRA_ALLOWLIST (exact
// string or RegExp); keep that list short and justified, the shared one is
// ALLOWLIST in the helper.
//
// Port 3691 is reserved for this file (3690 is i18nCore.test.js).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");
const { Client } = require("pg");
const { untranslated } = require("../helpers/i18nAudit");
const { makeCookieJar, fetchCsrfToken, waitForCartCount } = require("../helpers/httpClient");

const PORT = 3691;
const MARKETING_PAGES = require("../../src/lib/marketingPages");

// Append translated customer-facing pages here.
const PAGES = [
  "/this-page-does-not-exist", // views/404.ejs
  "/account/deleted", // views/account_deleted.ejs
  "/events", // views/events.ejs + calendar partials (seeded calendars: i18nCommunity.test.js)
  "/events?view=week",
  "/sessions", // views/sessions.ejs
  "/sessions?view=week&type=dropin",
  "/contact", // views/contact.ejs
  "/contact?sent=1",
  "/favorites", // views/favorites.ejs (the list itself is rendered client-side)
  "/login", // views/login.ejs
  "/login?reset=success", // login notice
  "/signup", // views/signup.ejs (and the privacy note)
  "/forgot-password", // views/forgot_password.ejs
  "/reset-password/not-a-real-token", // views/reset_password.ejs (invalid link branch)
  "/request-a-book", // views/request_book.ejs (and the privacy note)
  "/my-requests", // views/my_requests.ejs ("find my requests" form)
  "/my-requests/not-a-real-token", // views/my_request.ejs (invalid link branch)
  "/my-requests/list/not-a-real-token", // views/my_requests.ejs (invalid list link)
  "/request-a-book/confirm/not-a-real-token", // views/request_book_confirm.ejs (invalid link)
];

// Every marketing page (views/marketing/*.ejs), including the home page: the
// server must send the French text itself (lib/pageDictionary.js).
for (const p of ["/", ...MARKETING_PAGES.map((f) => "/" + f)]) PAGES.push(p);

// Pages that need seeded data or a session: each entry sets itself up against
// the running app and returns { path, headers? } (headers carry a session cookie).
// Seeded titles are English-only data, so they are the same in both renders and
// are allowlisted by prefix below.
const DYNAMIC_PAGES = {
  "book_detail (two copies, with description)": async () => ({ path: `/books/${(await seed()).bookId}` }),
  "book_detail (no copies)": async () => ({ path: `/books/${(await seed()).soldBookId}` }),
  "cart (with an item)": async () => {
    const { copyId } = await seed();
    const jar = makeCookieJar();
    const token = await fetchCsrfToken(app.base, jar);
    const add = await fetch(`${app.base}/cart/add`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: jar.header(), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ copyId: String(copyId), _csrf: token }).toString(),
    });
    assert.equal(add.status, 302);
    await waitForCartCount(app.base, jar, 1); // the 302 can arrive before the session write lands
    return { path: "/cart", session: jar.header() };
  },
  "cart (empty)": async () => ({ path: "/cart" }),
  "cart_return (paid)": async () => ({ path: `/cart/return?order=${(await seed()).orders.paid}` }),
  "cart_return (paid, with a drop-in seat)": async () => ({ path: `/cart/return?order=${(await seed()).orders.dropin}` }),
  "cart_return (cancelled)": async () => ({ path: `/cart/return?order=${(await seed()).orders.cancelled}` }),
  "cart_return (payment received, not fulfilled)": async () => ({ path: `/cart/return?order=${(await seed()).orders.unfulfilled}` }),
};

// "Éveil" is a program name, French in both languages; "Message" is the same word in French.
// An award label is a proper name from an outside source, shown as it is in both languages.
// "Cloudflare" is a company name and "umasbooks_lang" the literal name of our language cookie (a code
// element in the legal notice): neither is translated.
const EXTRA_ALLOWLIST = [/^I18n Shop (Book|Sold|Author|Class|Award)/, /^[ÉE]veil$/, "Message", "Cloudflare", "umasbooks_lang"];

let app;
let seeded;
before(async () => {
  // Own database: in CI every file shares one, and events/sessions seeded by other
  // files (English titles, identical in both renders) would be flagged here.
  app = await startTestApp({ port: PORT, isolated: true });
});
after(async () => {
  await app.stop();
});

// Seed once: a book with two in-stock copies (a description, a genre), a book
// with only a sold copy, and three orders (paid / cancelled / paid-but-unfulfilled).
async function seed() {
  if (seeded) return seeded;
  const client = new Client({ connectionString: app.databaseUrl });
  await client.connect();
  try {
    const { rows: b } = await client.query(
      "INSERT INTO books (title, authors, description, description_fr, categories, categories_fr, binding) VALUES ('I18n Shop Book', 'I18n Shop Author', 'A plain English description.', 'Une description en français.', 'Fiction', 'Roman', 'paperback') RETURNING id"
    );
    await client.query("INSERT INTO books (title, authors) VALUES ('I18n Shop Book Two', 'I18n Shop Author')");
    await client.query("INSERT INTO book_awards (book_id, label, year, kind, source, status) VALUES ($1, 'I18n Shop Award Prize', 2020, 'award', 'wikidata', 'verified')", [b[0].id]);
    const { rows: c } = await client.query(
      "INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 6.5, 'very_good'), ($1, 'in_stock', 9, 'like_new'), ($1, 'in_stock', 12, 'new'), ($1, 'in_stock', 3, 'acceptable') RETURNING id",
      [b[0].id]
    );
    const { rows: sold } = await client.query("INSERT INTO books (title, authors) VALUES ('I18n Shop Sold Book', 'I18n Shop Author') RETURNING id");
    await client.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'sold', 5)", [sold[0].id]);
    const orders = {};
    for (const [key, status, hello] of [["paid", "paid", null], ["cancelled", "cancelled", null], ["unfulfilled", "cancelled", "ha-1"]]) {
      const { rows } = await client.query(
        "INSERT INTO orders (buyer_name, buyer_email, total_amount, status, helloasso_order_id) VALUES ('Buyer', 'buyer@example.test', 6.5, $1, $2) RETURNING id, access_token",
        [status, hello]
      );
      const { rows: oc } = await client.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'sold', 6.5) RETURNING id", [sold[0].id]);
      await client.query("INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, 'I18n Shop Book', 6.5)", [rows[0].id, oc[0].id]);
      orders[key] = rows[0].access_token;
    }
    // A paid order with a drop-in seat: the line is rendered from the class row.
    const { rows: cls } = await client.query(
      "INSERT INTO classes (title, starts_at, capacity, dropin_price) VALUES ('I18n Shop Class', '2092-12-12T17:00:00Z', 10, 5) RETURNING id"
    );
    const { rows: dord } = await client.query(
      "INSERT INTO orders (buyer_name, buyer_email, total_amount, status) VALUES ('Buyer', 'buyer@example.test', 5, 'paid') RETURNING access_token, id"
    );
    const { rows: seat } = await client.query(
      "INSERT INTO class_dropin_seats (class_id, status, order_id) VALUES ($1, 'sold', $2) RETURNING id",
      [cls[0].id, dord[0].id]
    );
    await client.query(
      "INSERT INTO order_items (order_id, class_dropin_seat_id, item_title, price) VALUES ($1, $2, 'I18n Shop Class — 12 Dec, 18:00', 5)",
      [dord[0].id, seat[0].id]
    );
    orders.dropin = dord[0].access_token;
    seeded = { bookId: b[0].id, soldBookId: sold[0].id, copyId: c[0].id, orders };
  } finally {
    await client.end();
  }
  return seeded;
}

const render = async (path, cookie, session) =>
  (await fetch(`${app.base}${path}`, { headers: { cookie: [session, cookie].filter(Boolean).join("; ") } })).text();

async function assertTranslated(path, session) {
  const en = await render(path, "umasbooks_lang=en", session);
  const fr = await render(path, "umasbooks_lang=fr", session);
  assert.match(fr, /<html lang="fr"/);
  assert.deepEqual(untranslated(en, fr, EXTRA_ALLOWLIST), [], `${path}: same text in English and French`);
  return { en, fr };
}

for (const path of PAGES) {
  test(`${path} is fully translated`, async () => {
    await assertTranslated(path);
  });
}

for (const [name, setup] of Object.entries(DYNAMIC_PAGES)) {
  test(`${name} is fully translated`, async () => {
    const { path, session } = await setup();
    const { en, fr } = await assertTranslated(path, session);
    assert.ok(visibleTextLength(fr) > 0 && en !== fr, `${name}: French render differs from English`);
    if (name.startsWith("book_detail (two copies")) {
      assert.match(fr, /Prix et classements/);
      assert.match(en, /Awards &amp; lists/);
      assert.ok(fr.includes("I18n Shop Award Prize (2020)"), "the label itself stays as it is");
    }
  });
}

const visibleTextLength = (html) => html.replace(/<[^>]*>/g, "").trim().length;
