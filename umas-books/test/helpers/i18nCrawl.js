// The French-completeness crawler. Boots nothing itself: given a running test
// app (startTestApp) it
//   1. seeds one of everything a customer can see (books with awards, events,
//      classes, forum, meetings, shifts, charity round, announcement, orders...),
//   2. walks every customer-facing page as each persona (guest, account holder,
//      member, volunteer), in English and in French (cookie umasbooks_lang),
//   3. extracts the visible text and the text-bearing attributes, and
//   4. flags text that is still English on the French render.
// It is used by the permanent test (test/integration/i18nCrawler.test.js) and
// by `node scripts/i18n-audit.js`, which writes docs/i18n-audit.md.
//
// How text is judged (see findEnglish): the French text is "English" when
//   (a) it is identical in the English render of the same page (nobody
//       translated it), or
//   (b) it contains common English function words (the, and, your, please...),
//       or equals a known English UI string (tr() literals found in the source,
//       dictionary values of assets/i18n-common.js).
// Anything on the allow-list (test/i18n-allowlist.js, each entry with a reason)
// is skipped. A "not English" decision is deliberately conservative.

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { visibleText, visibleAttributes } = require("./i18nAudit");
const { makeCookieJar, fetchCsrfToken } = require("./httpClient");
const { createAccount, loginOverHttp } = require("./accounts");

const ROOT = path.join(__dirname, "..", "..");
const MARKETING_PAGES = require("../../src/lib/marketingPages");
const { isPublicPath, localize, splitUrl } = require("../../src/lib/frUrls");

const PERSONAS = ["guest", "account", "member", "volunteer"];

// ---------------------------------------------------------------- seeding

async function seed(app) {
  const c = new Client({ connectionString: app.databaseUrl });
  await c.connect();
  const q = async (sql, params) => (await c.query(sql, params)).rows;
  try {
    const out = {};
    const [b] = await q(
      "INSERT INTO books (title, authors, description, categories, binding, isbn, publisher, published_year) VALUES ('Crawl Book', 'Crawl Author', 'Crawl plain English description.', 'Fiction', 'trade', '9780141036144', 'Crawl Press', 1949) RETURNING id"
    ).catch(() => q("INSERT INTO books (title, authors, description, categories, binding) VALUES ('Crawl Book', 'Crawl Author', 'Crawl plain English description.', 'Fiction', 'trade') RETURNING id"));
    out.bookId = b.id;
    const [b2] = await q("INSERT INTO books (title, authors, description, binding) VALUES ('Crawl Second Book', 'Crawl Author', 'Crawl another description.', 'paperback') RETURNING id").catch(() => q("INSERT INTO books (title, authors) VALUES ('Crawl Second Book', 'Crawl Author') RETURNING id"));
    out.book2Id = b2.id;
    for (const [label, kind, source] of [["Crawl Award Prize", "award", "wikidata"], ["Crawl Bestseller List", "nyt_list", "nyt"]]) {
      await q("INSERT INTO book_awards (book_id, label, year, kind, source, status) VALUES ($1, $2, 2020, $3, $4, 'verified')", [b.id, label, kind, source]).catch(() => {});
    }
    const copies = await q(
      "INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 6.5, 'very_good'), ($1, 'in_stock', 9, 'good'), ($1, 'in_stock', 12, 'new'), ($1, 'in_stock', 3, 'acceptable'), ($2, 'in_stock', 4, 'like_new'), ($2, 'in_stock', 5, 'good'), ($2, 'in_stock', 7, 'good') RETURNING id",
      [b.id, b2.id]
    );
    out.copyIds = copies.map((r) => r.id);
    const [sold] = await q("INSERT INTO books (title, authors) VALUES ('Crawl Sold Book', 'Crawl Author') RETURNING id");
    await q("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'sold', 5)", [sold.id]);
    out.soldBookId = sold.id;

    // Curated collections (migrations/091 seeds them unpublished): one published with two books, one published whose
    // only book is sold (its page says so), so the Browse row and both collection pages are read in both languages.
    const [col] = await q("SELECT id, slug FROM curated_collections WHERE slug = 'paris-is-always-a-good-idea'");
    await q("INSERT INTO curated_collection_books (collection_id, book_id, status, reason, position) VALUES ($1, $2, 'approved', 'x', 1), ($1, $3, 'approved', 'x', 2)", [col.id, b.id, b2.id]);
    const [gone] = await q("SELECT id, slug FROM curated_collections WHERE slug = 'the-magic-we-never-outgrew'");
    await q("INSERT INTO curated_collection_books (collection_id, book_id, status, reason, position) VALUES ($1, $2, 'approved', 'x', 1)", [gone.id, sold.id]);
    await q("UPDATE curated_collections SET published = TRUE WHERE id = ANY($1)", [[col.id, gone.id]]);
    out.collectionSlug = col.slug;
    out.emptyCollectionSlug = gone.slug;

    // One set of accounts per language: an account email is written in the account's stored
    // language (users.lang), and the outbox throttles repeated mail to one address.
    out.users = { en: {}, fr: {} };
    for (const lang of ["en", "fr"]) {
      for (const [key, extra] of [
        ["account", {}],
        ["unconfirmed", { confirmed: false }],
        ["doomed", {}],
        ["member", { isMember: true, memberExpiresAt: new Date(Date.now() + 200 * 864e5) }],
        ["volunteer", { isMember: true, memberExpiresAt: new Date(Date.now() + 200 * 864e5) }],
      ]) {
        const u = await createAccount(c, { email: `crawl.${key}.${lang}@example.test`, displayName: `Crawl ${key}`, ...extra });
        await q("UPDATE users SET lang = $1, is_volunteer = $2 WHERE id = $3", [lang, key === "volunteer", u.id]);
        out.users[lang][key] = u;
      }
    }
    const users = out.users.en;

    const day = 864e5;
    const at = (d, h = 14) => new Date(Date.now() + d * day + h * 36e5 - (Date.now() % day));
    const [ev] = await q("INSERT INTO events (title, description, location, starts_at, ends_at, capacity, price) VALUES ('Crawl Event', 'Crawl event description.', 'Albi', $1, $2, 20, 5) RETURNING id", [at(5), at(5, 16)]);
    out.eventId = ev.id;
    await q("INSERT INTO events (title, description, location, starts_at, ends_at, capacity, price) VALUES ('Crawl Free Event', 'Crawl free.', 'Albi', $1, $2, 20, 0)", [at(8), at(8, 16)]);
    await q("INSERT INTO classes (title, description, location, starts_at, ends_at, capacity, dropin_price, program_type) VALUES ('Crawl Class', 'Crawl class description.', 'Albi', $1, $2, 8, 10, 'young_readers'), ('Crawl Dropin', 'Crawl drop-in description.', 'Albi', $3, $4, 8, 10, 'english_cafe')", [at(3), at(3, 16), at(4), at(4, 16)]).catch(async () => {
      await q("INSERT INTO classes (title, description, location, starts_at, ends_at, capacity) VALUES ('Crawl Class', 'Crawl class description.', 'Albi', $1, $2, 8)", [at(3), at(3, 16)]);
    });
    const [m] = await q("INSERT INTO meetings (title, scheduled_at, location, agenda, minutes) VALUES ('Crawl Meeting', $1, 'Albi', 'Crawl agenda.', 'Crawl minutes.') RETURNING id", [at(6)]);
    out.meetingId = m.id;
    await q("INSERT INTO volunteer_shifts (role, starts_at, ends_at, capacity, notes) VALUES ('Crawl Shift', $1, $2, 3, 'Crawl bring a coat.')", [at(4), at(4, 17)]);
    const [t] = await q("INSERT INTO forum_threads (title, body, author_id) VALUES ('Crawl Thread', 'Crawl thread body.', $1) RETURNING id", [users.member.id]);
    out.threadId = t.id;
    await q("INSERT INTO forum_replies (thread_id, body, author_id) VALUES ($1, 'Crawl reply.', $2)", [t.id, users.member.id]);
    await q("INSERT INTO announcements (title, body, status, published_at) VALUES ('Crawl Announcement', 'Crawl announcement body.', 'published', now())").catch(() => {});
    const [r] = await q("INSERT INTO charity_rounds (title, opens_at, closes_at, is_active, allow_multiple, visible_to) VALUES ('Crawl Round', now() - interval '1 day', now() + interval '10 days', true, false, 'members') RETURNING id").catch(() => q("INSERT INTO charity_rounds (title, opens_at, closes_at, is_active) VALUES ('Crawl Round', now() - interval '1 day', now() + interval '10 days', true) RETURNING id"));
    await q("INSERT INTO charity_options (round_id, name, description) VALUES ($1, 'Crawl Charity', 'Crawl helps.')", [r.id]);
    await q("INSERT INTO blog_posts (title, body, slug, status, published_at, excerpt) VALUES ('Crawl Post', 'Crawl body', 'crawl-post', 'published', now(), 'Crawl excerpt')").catch(() => {});

    out.orders = {};
    for (const [key, status] of [["paid", "paid"], ["cancelled", "cancelled"]]) {
      const [o] = await q("INSERT INTO orders (buyer_name, buyer_email, total_amount, status, paid_at) VALUES ('Buyer', 'buyer@example.test', 6.5, $1, now()) RETURNING id, access_token", [status]);
      const [oc] = await q("INSERT INTO book_copies (book_id, status, price) VALUES ($1, $2, 6.5) RETURNING id", [b.id, status === "paid" ? "sold" : "in_stock"]);
      await q("INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, 'Crawl Book', 6.5)", [o.id, oc.id]);
      out.orders[key] = o.access_token;
    }
    return out;
  } finally {
    await c.end();
  }
}

// ---------------------------------------------------------------- fetching

// Every session gets its own client address (X-Forwarded-For, trusted by the test app) so the
// per-IP rate limits never fire on the crawler's own traffic.
let ipCounter = 10;
const nextIp = () => { ipCounter += 1; return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`; };

async function newSession(app, seeded, persona, lang = "en") {
  const jar = makeCookieJar();
  jar.ip = nextIp();
  if (persona !== "guest") {
    const res = await loginOverHttp(app.base, jar, seeded.users[lang][persona], { "x-forwarded-for": jar.ip });
    if (res.status !== 302 && res.status !== 303) throw new Error(`login as ${persona} failed: ${res.status}`);
  }
  return jar;
}

// lang = null: no language cookie and no Accept-Language at all (what a search engine sends), and the
// reply's cookies are NOT kept (a /fr/ visit writes umasbooks_lang=fr, which would turn the English renders French).
async function get(app, jar, pathname, lang) {
  const cookie = [jar.header(), lang && `umasbooks_lang=${lang}`].filter(Boolean).join("; ");
  const res = await fetch(app.base + pathname, { redirect: "manual", headers: { cookie, "x-forwarded-for": jar.ip } });
  if (lang) jar.capture(res);
  const ctype = res.headers.get("content-type") || "";
  return { status: res.status, location: res.headers.get("location"), ctype, body: await res.text() };
}

// Customer pages: [path, personas that see it]. Everything a guest sees is also
// crawled as the signed-in personas (header and cart differ), but only the
// pages whose content differs are listed per persona to keep the run short.
function pageList(s) {
  const all = PERSONAS;
  const signedIn = ["account", "member", "volunteer"];
  const list = [
    ["/", all], ["/this-page-does-not-exist", ["guest", "member"]],
    ...MARKETING_PAGES.map((f) => ["/" + f, f === "membership.html" || f === "volunteer.html" || f === "programs.html" ? all : ["guest", "member"]]),
    ["/books/" + s.bookId, all], ["/books/" + s.book2Id, ["guest", "account"]], ["/books/" + s.soldBookId, ["guest"]],
    ["/collections/" + s.collectionSlug, ["guest", "account"]], ["/collections/" + s.emptyCollectionSlug, ["guest"]],
    ["/favorites", ["guest", "account"]], ["/cart", all],
    [`/cart/return?order=${s.orders.paid}`, ["guest"]], [`/cart/return?order=${s.orders.cancelled}`, ["guest"]],
    ["/contact", ["guest", "account"]], ["/contact?sent=1", ["guest"]],
    ["/events", all], ["/events?view=week", ["guest"]], ["/sessions", all], ["/sessions?view=week&type=dropin", ["guest"]],
    ["/immersion/calendar", ["guest"]],
    ["/login", ["guest"]], ["/login?reset=success", ["guest"]], ["/login?expired=1", ["guest"]], ["/login?next=/cart", ["guest"]],
    ["/signup", ["guest"]], ["/forgot-password", ["guest"]], ["/reset-password/not-a-real-token", ["guest"]],
    ["/verify-email/not-a-real-token", ["guest"]], ["/login/2fa", ["guest"]],
    ["/request-a-book", all], ["/request-a-book/sent", ["guest"]], ["/request-a-book/confirmed", ["guest"]],
    ["/request-a-book/confirm/not-a-real-token", ["guest"]], ["/my-requests", ["guest"]],
    ["/my-requests/not-a-real-token", ["guest"]], ["/my-requests/list/not-a-real-token", ["guest"]],
    ["/account/deleted", ["guest"]], ["/charity", ["guest", "member"]],
    ["/account", signedIn], ["/account/privacy", ["account", "member"]], ["/account/password", ["account"]], ["/account/2fa", ["account"]],
    ["/dashboard", ["account", "member", "volunteer"]], ["/announcements", ["member"]],
    ["/forum", ["member"]], ["/forum/new", ["member"]], [`/forum/${s.threadId}`, ["member"]],
    ["/meetings", ["member"]], ["/volunteer", ["volunteer", "account"]], ["/cart/checkout", ["account"]],
  ];
  return list;
}

// Pages that need a state built first (a cart, a reservation).
async function stateful(app, s, lang) {
  const out = [];
  const jar = await newSession(app, s, "account", lang);
  const token = await fetchCsrfToken(app.base, jar, { "x-forwarded-for": jar.ip });
  const post = (p, body) => fetch(app.base + p, {
    method: "POST", redirect: "manual",
    headers: { "x-forwarded-for": jar.ip, cookie: jar.header() + `; umasbooks_lang=${lang}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...body, _csrf: token }).toString(),
  }).then((r) => { jar.capture(r); return r; });
  const [c1, c2] = lang === "fr" ? [2, 3] : [0, 1];
  await post("/cart/add", { copyId: String(s.copyIds[c1]) });
  await post("/cart/add", { copyId: String(s.copyIds[c2]) });
  await new Promise((r) => setTimeout(r, 300));
  out.push(["cart with items", await get(app, jar, "/cart", lang)]);
  const res = await post("/cart/reserve", { name: "Ana Crawl", phone: "0600000000", acceptCgv: "on" });
  if (res.headers.get("location")) {
    const loc = res.headers.get("location");
    out.push(["after reserve " + loc, await get(app, jar, loc, lang)]);
  }
  out.push(["cart after reserve", await get(app, jar, "/cart", lang)]);
  out.push(["account after reserve", await get(app, jar, "/account", lang)]);
  return out;
}

// ---------------------------------------------------------------- form scenarios
// Refused and successful form posts: the page (or JSON, or plain text) a person
// is left on, in each language. Each scenario runs once per language, with its own
// session, and returns the final response.

async function submit(app, jar, lang, method, p, body, { json = false, followUp = true } = {}) {
  const token = await fetchCsrfToken(app.base, jar, { "x-forwarded-for": jar.ip });
  const cookie = () => [jar.header(), `umasbooks_lang=${lang}`].filter(Boolean).join("; ");
  const headers = { cookie: cookie(), "x-forwarded-for": jar.ip, "x-csrf-token": token, accept: json ? "application/json" : "text/html" };
  let init = { method, redirect: "manual", headers };
  if (method !== "GET") {
    init = { ...init, headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...body, _csrf: token }).toString() };
  }
  let res = await fetch(app.base + p, init);
  jar.capture(res);
  for (let i = 0; i < 3 && followUp && res.status >= 300 && res.status < 400 && res.headers.get("location"); i++) {
    res = await fetch(new URL(res.headers.get("location"), app.base), { redirect: "manual", headers: { cookie: cookie(), "x-forwarded-for": jar.ip } });
    jar.capture(res);
  }
  return { status: res.status, ctype: res.headers.get("content-type") || "", location: res.headers.get("location"), body: await res.text() };
}

function scenarios(app, s) {
  const S = (name, persona, fn) => ({ name, persona, fn });
  const copy = s.copyIds;
  const reserveCopy = (c) => String(c.lang === "fr" ? copy[6] : copy[5]);
  return [
    S("login: wrong password", "guest", (c) => c.post("/login", { email: c.userEmail("account"), password: "wrong-password" })),
    S("login: unknown account", "guest", (c) => c.post("/login", { email: "nobody@example.test", password: "x" })),
    S("login: empty", "guest", (c) => c.post("/login", { email: "", password: "" })),
    S("signup: no name", "guest", (c) => c.post("/signup", { email: `a${c.uniq}@example.test`, displayName: "" })),
    S("signup: bad email", "guest", (c) => c.post("/signup", { email: "not-an-email", displayName: "Ana" })),
    S("signup: ok", "guest", (c) => c.post("/signup", { email: `ok${c.uniq}@example.test`, displayName: "Ana Crawl" })),
    S("signup: existing account", "guest", (c) => c.post("/signup", { email: c.userEmail("account"), displayName: "Ana" })),
    S("membership join: bad", "guest", (c) => c.post("/membership/join", { email: "nope", displayName: "" })),
    S("membership join: ok", "guest", (c) => c.post("/membership/join", { email: `mj${c.uniq}@example.test`, displayName: "Marie Crawl" })),
    S("forgot password: known", "guest", (c) => c.post("/forgot-password", { email: c.userEmail("account") })),
    S("forgot password: unknown", "guest", (c) => c.post("/forgot-password", { email: "nobody@example.test" })),
    S("forgot password: bad", "guest", (c) => c.post("/forgot-password", { email: "x" })),
    S("reset password: bad token", "guest", (c) => c.post("/reset-password/not-a-real-token", { password: "Another-Passw0rd!x", confirm: "Another-Passw0rd!x" })),
    S("resend verification", "guest", (c) => c.post("/resend-verification", { email: c.userEmail("unconfirmed") })),
    S("verify email: bad token", "guest", (c) => c.post("/verify-email/not-a-real-token", {})),
    S("2FA login: no pending login", "guest", (c) => c.post("/login/2fa", { code: "123456" })),
    S("contact: empty", "guest", (c) => c.post("/contact", { name: "", email: "x", topic: "General question", message: "" })),
    S("contact: ok", "guest", (c) => c.post("/contact", { name: "Ana Crawl", email: "ana@example.test", topic: "General question", message: "Crawl hello" })),
    S("request a book: empty", "guest", (c) => c.post("/request-a-book", { title: "", email: "" })),
    S("request a book: ok", "guest", (c) => c.post("/request-a-book", { title: "Crawl Wanted", author: "Crawl Author", email: `rb${c.uniq}@example.test`, name: "Ana" })),
    S("find my requests", "guest", (c) => c.post("/my-requests", { email: `rb${c.uniq}@example.test` })),
    S("cart: add unknown copy", "account", (c) => c.post("/cart/add", { copyId: "999999" })),
    S("cart: reserve empty cart", "account", (c) => c.post("/cart/reserve", { name: "Ana", phone: "0600000000", acceptCgv: "on" })),
    S("cart: reserve without CGV", "account", async (c) => { await c.post("/cart/add", { copyId: String(copy[4]) }); return c.post("/cart/reserve", { name: "Ana", phone: "0600000000" }); }),
    S("cart: reserve without name", "account", async (c) => { await c.post("/cart/add", { copyId: String(copy[4]) }); return c.post("/cart/reserve", { name: "", phone: "", acceptCgv: "on" }); }),
    S("cart: reserve ok", "account", async (c) => { await c.post("/cart/add", { copyId: reserveCopy(c) }); return c.post("/cart/reserve", { name: "Ana Crawl", phone: "0600000000", acceptCgv: "on" }); }),
    S("cart: add dropin", "account", (c) => c.post("/cart/add-dropin", { classId: "999999" })),
    S("cart count (json)", "guest", (c) => c.get("/api/cart/count", { json: true })),
    S("session (json)", "guest", (c) => c.get("/api/session", { json: true })),
    S("favorite toggle without copy (json)", "guest", (c) => c.post("/api/favorites/toggle", { bookId: "abc" }, { json: true })),
    S("books search (json)", "guest", (c) => c.get("/api/books/search?q=crawl", { json: true })),
    S("new in (json)", "guest", (c) => c.get("/api/books/new-in", { json: true })),
    S("books by ids (json)", "guest", (c) => c.get(`/api/books/by-ids?ids=${s.bookId}`, { json: true })),
    S("events upcoming (json)", "guest", (c) => c.get("/api/events/upcoming", { json: true })),
    S("event signup: empty", "guest", (c) => c.post(`/events/${s.eventId}/signup`, { name: "", email: "" })),
    S("event signup: ok", "guest", (c) => c.post(`/events/${s.eventId}/signup`, { name: "Ana", email: `ev${c.uniq}@example.test` })),
    S("event signup: unknown", "guest", (c) => c.post(`/events/999999/signup`, { name: "Ana", email: "ev@example.test" })),
    S("event ics", "guest", (c) => c.get(`/events/${s.eventId}/ics`)),
    S("change password: wrong current", "account", (c) => c.post("/account/password", { currentPassword: "wrong", newPassword: "Another-Passw0rd!x" })),
    S("change password: weak new", "account", (c) => c.post("/account/password", { currentPassword: "Test-Password-1!", newPassword: "abc" })),
    S("privacy: export", "account", (c) => c.post("/account/privacy/export", {})),
    S("privacy: delete without confirmation", "account", (c) => c.post("/account/privacy/delete", { password: "wrong" })),
    S("privacy: delete the account", "doomed", (c) => c.post("/account/privacy/delete", { currentPassword: "Test-Password-1!", confirmation: c.lang === "fr" ? "SUPPRIMER" : "DELETE" })),
    S("privacy: resend verification", "account", (c) => c.post("/account/privacy/resend-verification", {})),
    S("2FA: enable with a bad code", "account", (c) => c.post("/account/2fa/enable", { code: "000000" })),
    S("forum: new without text", "member", (c) => c.post("/forum/new", { title: "", body: "" })),
    S("forum: reply empty", "member", (c) => c.post(`/forum/${s.threadId}/replies`, { body: "" })),
    S("forum: report", "member", (c) => c.post("/forum/report", { kind: "thread", id: String(s.threadId), reason: "illegal", comment: "Crawl" })),
    S("forum: report missing", "member", (c) => c.post("/forum/report", { kind: "thread", id: "999999", reason: "x" })),
    S("charity vote: nothing chosen", "member", (c) => c.post("/charity/vote", {})),
    S("charity idea: empty", "member", (c) => c.post("/charity/ideas", { name: "" })),
    S("meeting rsvp", "member", (c) => c.post(`/meetings/${s.meetingId}/rsvp`, { status: "yes" })),
    S("volunteer: sign up for a missing shift", "volunteer", (c) => c.post("/volunteer/999999/signup", {})),
    S("CSRF refused", "guest", async (c) => {
      const res = await fetch(app.base + "/login", { method: "POST", redirect: "manual", headers: { "x-forwarded-for": nextIp(), cookie: `umasbooks_lang=${c.lang}`, "content-type": "application/x-www-form-urlencoded", accept: "text/html" }, body: "email=a&password=b" });
      return { status: res.status, ctype: res.headers.get("content-type") || "", body: await res.text() };
    }),
    S("members-only page as a guest", "guest", (c) => c.get("/forum")),
    S("volunteer page as a member", "member", (c) => c.get("/volunteer")),
    S("admin page as a customer", "member", (c) => c.get("/admin")),
    S("500 page", "guest", (c) => c.get("/books/abc")),
  ];
}

// Mail capture (test/helpers/mailCapture.js): the app, started with captureEnv(), appends every
// mail it would send to a file. mailsSince(offset) reads what was captured after `offset`.
const MAIL_FILE = path.join(require("node:os").tmpdir(), `umas-crawl-mail-${process.pid}.jsonl`);
function captureEnv() {
  fs.writeFileSync(MAIL_FILE, "");
  return { NODE_OPTIONS: `--require ${path.join(__dirname, "mailCapture.js")}`, MAIL_CAPTURE_FILE: MAIL_FILE };
}
const mailOffset = () => { try { return fs.statSync(MAIL_FILE).size; } catch { return 0; } };
async function mailsSince(offset) {
  await new Promise((r) => setTimeout(r, 150)); // a mail is queued just after its page is sent
  let text = "";
  try { text = fs.readFileSync(MAIL_FILE).subarray(offset).toString("utf8"); } catch { /* no file: no mail */ }
  // Mail to the shop itself (contact form, forum report) is for the admins, who read English.
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((m) => !/^admin@umasbooks\.org$/i.test(String(m.to)));
}

async function runScenarios(app, s, allow) {
  const out = [];
  for (const sc of scenarios(app, s)) {
    const res = {};
    const mailed = {};
    for (const lang of ["en", "fr"]) {
      const jar = await newSession(app, s, sc.persona, lang);
      const mailStart = mailOffset();
      const stamp = `${lang}${Date.now().toString(36)}`;
      const c = {
        lang, uniq: stamp, userEmail: (persona) => s.users[lang][persona].email,
        get: (p, o = {}) => submit(app, jar, lang, "GET", p, {}, o),
        post: (p, b, o = {}) => submit(app, jar, lang, "POST", p, b, o),
      };
      try { res[lang] = await sc.fn(c); } catch (e) { res[lang] = { status: 0, ctype: "", body: String(e) }; }
      mailed[lang] = await mailsSince(mailStart);
    }
    out.push(judge(sc.persona, "POST " + sc.name, res.en, res.fr, allow));
    out.push(...judgeMails(sc.name, mailed.en, mailed.fr, allow));
  }
  return out;
}

// The mails a scenario made the app send, French against English (same scenario, same order).
function judgeMails(name, _enMails, frMails = [], allow) {
  const wrap = (m) => (m ? `<p>${m.subject}</p>` + String(m.text || "").split("\n").map((l) => `<p>${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`).join("") : "");
  return frMails.map((m) => ({
    persona: "email", path: `EMAIL ${name}: ${m.subject}`, status: 200, redirect: null, htmlLang: null,
    items: findEnglish("", wrap(m), allow), // no English twin: the English mail may hold the bilingual legal block
    texts: [m.subject, ...String(m.text || "").split("\n")],
  }));
}

// ---------------------------------------------------------------- judging

const EN_STOP = new Set(("the and your please click here with from you our not are this that have will for has was can if to of is it be by we would should been their they but all more only about when what which who how why also any there then than into over after before out up no yes may must").split(" "));
// words that are English but also real French words are left out on purpose:
// a, on, or, as, an, me, son, plus, pour, mais, dans, par, la, le, du, des, ...
const FR_HINT = new Set("le la les un une des du de et est sont vous votre vos nous notre nos pour dans avec sur par ce cette ces au aux ne pas ou où que qui il elle ils se sa son ses en à plus mais si être avoir faire".split(" "));

function words(text) {
  return (text.toLowerCase().match(/[a-zà-ÿ’']+/g) || []);
}

// English function words in `text`, ignoring text that is clearly French.
const BRAND = /Uma(?:'|’)s Books (?:and|&amp;|&) Adventures/gi;
function englishScore(text) {
  const w = words(text.replace(BRAND, " ")).map((x) => x.replace(/['’]s$/, ""));
  if (w.length === 0) return { en: 0, fr: 0, n: 0 };
  let en = 0, fr = 0;
  for (const x of w) {
    if (EN_STOP.has(x)) en += 1;
    if (FR_HINT.has(x) || /[àâçéèêëîïôûùüÿœ]/.test(x)) fr += 1;
  }
  return { en, fr, n: w.length };
}

function isAllowed(text, allow) {
  const lower = text.toLowerCase();
  for (const a of allow) {
    const m = a.match;
    if (m instanceof RegExp ? m.test(text) : String(m).toLowerCase() === lower) return a;
  }
  return null;
}

let knownEnglish = null;
// English UI strings known from the source: the first argument of every tr("en", "fr") call
// (views, routes, libs, emails) and the `en` dictionaries of assets/i18n-common.js and page scripts.
function loadKnownEnglish() {
  if (knownEnglish) return knownEnglish;
  const set = new Set();
  const files = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { if (!/node_modules|admin|test|\.git/.test(f.name)) walk(p); }
      else if (/\.(js|ejs)$/.test(f.name)) files.push(p);
    }
  };
  walk(path.join(ROOT, "src")); walk(path.join(ROOT, "views"));
  const RE = /\btr\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*,\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`)/g;
  for (const f of files) {
    if (/[\\/]views[\\/]admin[\\/]|routes[\\/]admin/.test(f)) continue;
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(RE)) {
      const en = (m[1] ?? m[2] ?? "").replace(/\\(["'])/g, "$1");
      const fr = m[3] ?? m[4] ?? "";
      if (en && !/\{\w+\}/.test(en) && en !== fr && en.length >= 4) set.add(en.toLowerCase());
    }
  }
  knownEnglish = set;
  return set;
}

// Returns [{ text, reason, allowed }] for the French page's English text.
function findEnglish(enHtml, frHtml, allow) {
  const frTexts = [...visibleText(frHtml), ...visibleAttributes(frHtml)];
  const enSet = new Set([...visibleText(enHtml), ...visibleAttributes(enHtml)]);
  const known = loadKnownEnglish();
  const found = [];
  const seen = new Set();
  for (const text of frTexts) {
    if (seen.has(text)) continue;
    seen.add(text);
    if ((text.match(/\p{L}/gu) || []).length < 3) continue;
    let reason = null;
    if (enSet.has(text)) reason = "same as English";
    const stripped = text.replace(/\u00a0/g, " ").replace(/[’]/g, "'");
    if (known.has(stripped.toLowerCase().replace(/\s*[:;!?]$/, "").trim()) || known.has(stripped.toLowerCase())) reason = reason || "known English string";
    const sc = englishScore(text);
    if (!reason && sc.en >= 2 && sc.fr === 0) reason = "English words";
    if (!reason && sc.en >= 1 && sc.n >= 4 && sc.fr === 0) reason = "English words";
    if (!reason) continue;
    const entry = isAllowed(text, allow);
    found.push({ text, reason, allowed: entry ? entry.reason : null });
  }
  return found;
}

function htmlLang(html) {
  const m = /<html[^>]*\slang="([^"]*)"/i.exec(html);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- the crawl

// Returns { pages: [{ persona, path, status, htmlLang, items: [...] }], errors: [...] }.
async function crawl(app, { allow = [], onlyPersona } = {}) {
  const s = await seed(app);
  const pages = [];
  const sessions = {};
  const jarFor = async (persona) => (sessions[persona] ||= await newSession(app, s, persona));
  for (const [p, personas] of pageList(s)) {
    for (const persona of personas) {
      if (onlyPersona && persona !== onlyPersona) continue;
      const jar = await jarFor(persona);
      const en = await get(app, jar, p, "en");
      const fr = await get(app, jar, p, "fr");
      pages.push(judge(persona, p, en, fr, allow));
      // The same public page at its /fr/ address: French with no cookie and no Accept-Language.
      if (isPublicPath(splitUrl(p)[0])) pages.push(judge(persona, localize(p), en, await get(app, jar, localize(p), null), allow));
    }
  }
  pages.push(...(await runScenarios(app, s, allow)));
  const enMark = mailOffset();
  const enStates = await stateful(app, s, "en").catch(() => []);
  const enMails = await mailsSince(enMark);
  const frMark = mailOffset();
  const frStates = await stateful(app, s, "fr");
  pages.push(...judgeMails("cart: reserve", enMails, await mailsSince(frMark), allow));
  frStates.forEach(([name, fr], i) => {
    const en = (enStates[i] && enStates[i][1]) || { status: 0, body: "", ctype: "" };
    pages.push(judge("account", name, en, fr, allow));
  });
  return { seeded: s, pages };
}

function jsonStrings(body) {
  const out = [];
  const walk = (v, key) => {
    if (typeof v === "string") { if (!/^(https?:|\/)/.test(v) && !/^[\w.-]+$/.test(v) || /\s/.test(v)) out.push(v); }
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  try { walk(JSON.parse(body)); } catch { /* not JSON */ }
  return out;
}

function judge(persona, p, en, fr, allow) {
  const isHtml = /html/.test(fr.ctype);
  let items = [];
  if (fr.status >= 300 && fr.status < 400) items = []; // a redirect's body is the framework's own line, nobody reads it
  else if (isHtml) items = findEnglish(en.body, fr.body, allow);
  else if (/json/.test(fr.ctype)) items = findEnglish(jsonStrings(en.body).map((t) => `<p>${t}</p>`).join(""), jsonStrings(fr.body).map((t) => `<p>${t}</p>`).join(""), allow);
  else if (/text\/plain/.test(fr.ctype) && !/calendar/.test(fr.ctype)) items = findEnglish(`<p>${en.body}</p>`, `<p>${fr.body}</p>`, allow);
  const texts = isHtml ? [...visibleText(fr.body), ...visibleAttributes(fr.body)] : /json/.test(fr.ctype) ? jsonStrings(fr.body) : [];
  return { persona, path: p, status: fr.status, enStatus: en.status, redirect: fr.location || null, htmlLang: isHtml ? htmlLang(fr.body) : null, items, texts, enTexts: /html/.test(en.ctype) ? [...visibleText(en.body), ...visibleAttributes(en.body)] : [] };
}

module.exports = { captureEnv, crawl, findEnglish, englishScore, htmlLang, PERSONAS, seed, loadKnownEnglish };
