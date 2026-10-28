/* global document */
// Guest checkout and guest favourites on the REAL app (startTestApp: the real CSRF check, the real login and email
// confirmation, the real session store), every mail captured to a file (test/helpers/mailCapture.js):
//   - CSRF on every guest POST (reserve, confirm, manage cancel, favourites merge)
//   - the card cart icon adds straight to a signed-out visitor's cart (no sign-in detour), then the guest flow end to end
//   - guest orders are attached to an account with the same email ONLY once that email is confirmed (the email link,
//     a login of an account confirmed earlier), never to an unconfirmed one
//   - signed-out favourites: the page needs no account; on sign-in the browser's favourites are merged into the account
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");
const { createAccount } = require("../helpers/accounts");
const { hashToken } = require("../../src/lib/resetTokens");

const PORT = 6541;
const MAIL_FILE = path.join(os.tmpdir(), `umas-guest-mail-${process.pid}.jsonl`);
let app;
let pool;
let browser;
let skipReason = null;
let ipSeq = 1;
const newIp = () => `10.93.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const TOKEN = "[0-9a-f]{64}";

before(async () => {
  fs.writeFileSync(MAIL_FILE, "");
  try {
    browser = await require("puppeteer").launch({ headless: true, args: ["--no-sandbox"] });
  } catch (err) {
    skipReason = `no headless Chrome available: ${String(err.message).split("\n")[0]}`;
  }
  app = await startTestApp({
    port: PORT, isolated: true,
    env: { ANTHROPIC_API_KEY: "", ANON_SESSION_LIMIT: "100000", NODE_OPTIONS: `--require ${path.join(__dirname, "..", "helpers", "mailCapture.js")}`, MAIL_CAPTURE_FILE: MAIL_FILE },
  });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
});

after(async () => {
  if (browser) await browser.close();
  if (pool) await pool.end();
  if (app) await app.stop();
  try { fs.unlinkSync(MAIL_FILE); } catch { /* already gone */ }
});

async function mailsTo(to) {
  await new Promise((r) => setTimeout(r, 200));
  return fs.readFileSync(MAIL_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.to === to);
}

async function newCopy(price = 6) {
  const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'Guest Author') RETURNING id", [`Guest App Book ${uniq()}`]);
  const { rows } = await pool.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', $2, 'good') RETURNING id", [b[0].id, price]);
  return { bookId: b[0].id, copyId: rows[0].id };
}

function visitor() {
  const jar = makeCookieJar();
  const ip = newIp();
  const headers = (extra = {}) => ({ cookie: jar.header(), "x-forwarded-for": ip, ...extra });
  return {
    jar, ip,
    async get(p, extra) { const r = await fetch(`${app.base}${p}`, { redirect: "manual", headers: headers(extra) }); jar.capture(r); return r; },
    async post(p, body, extra) {
      const r = await fetch(`${app.base}${p}`, { method: "POST", redirect: "manual", headers: headers({ "content-type": "application/x-www-form-urlencoded", ...extra }), body: new URLSearchParams(body).toString() });
      jar.capture(r);
      return r;
    },
    token() { return fetchCsrfToken(app.base, jar, { "x-forwarded-for": ip }); },
    async session() { return (await this.get("/api/session")).json(); },
  };
}
async function signIn(v, account) {
  const r = await v.post("/login", { email: account.email, password: account.password, _csrf: await v.token() });
  assert.equal(r.status, 302, "logged in");
  return r;
}

// A guest reservation through the real routes. Resolves { order, confirm, manage, v }.
async function guestReserve(email, { v = visitor(), copy } = {}) {
  const c = copy || await newCopy();
  const add = await v.post("/cart/add", { copyId: c.copyId, via: "card", backTo: "/books.html", _csrf: await v.token() }, { accept: "application/json" });
  assert.equal(add.status, 200);
  const r = await v.post("/cart/guest/reserve", { name: "App Guest", email, phone: "", acceptCgv: "on", _csrf: await v.token() });
  assert.equal(r.status, 302, `reserved (${r.status} ${r.headers.get("location")})`);
  const token = /order=([0-9a-f-]{36})/.exec(r.headers.get("location"))[1];
  const { rows } = await pool.query("SELECT * FROM orders WHERE access_token = $1", [token]);
  const mail = (await mailsTo(email.toLowerCase())).pop();
  return {
    v, order: rows[0], copy: c,
    confirm: new RegExp(`/cart/guest/confirm/(${TOKEN})`).exec(mail.text)[1],
    manage: new RegExp(`/cart/guest/manage/(${TOKEN})`).exec(mail.text)[1],
  };
}

test("signed out, the card's cart icon adds the book directly (no sign-in detour); then the whole guest flow with the real CSRF check", async () => {
  const v = visitor();
  const c = await newCopy(8);
  const token = await v.token();
  const add = await v.post("/cart/add", { copyId: c.copyId, backTo: "/collections/x", via: "card", _csrf: token }, { accept: "application/json" });
  assert.deepEqual(await add.json(), { ok: true, inCart: true, cartCount: 1, bookId: c.bookId }, "no login address in the answer");
  const s = await v.session();
  assert.equal(s.loggedIn, false);
  assert.deepEqual(s.cartBookIds, [c.bookId], "the icons show it as in the cart");
  // without JavaScript, the plain form comes back to the page it was on (not the sign-in page)
  const plain = await v.post("/cart/add", { copyId: (await newCopy()).copyId, backTo: "/collections/x", via: "card", _csrf: token });
  assert.equal(plain.headers.get("location"), "/collections/x");

  const cart = await (await v.get("/cart")).text();
  assert.match(cart, /href="\/cart\/guest">Continue as a guest/);
  const form = await (await v.get("/cart/guest")).text();
  const formToken = /name="_csrf" value="([0-9a-f]{64})"/.exec(form)[1];
  const email = `app-guest-${uniq()}@example.test`;

  // CSRF: without the token, or a wrong one, nothing is reserved
  for (const bad of [{}, { _csrf: "0".repeat(64) }]) {
    const r = await v.post("/cart/guest/reserve", { name: "App Guest", email, acceptCgv: "on", ...bad });
    assert.equal(r.status, 403);
  }
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders WHERE buyer_email = $1", [email])).rows[0].n, 0);
  const r = await v.post("/cart/guest/reserve", { name: "App Guest", email, acceptCgv: "on", _csrf: formToken });
  assert.equal(r.status, 302);
  const mail = (await mailsTo(email)).pop();
  assert.ok(mail, "the confirmation link was emailed");
  const confirm = new RegExp(`/cart/guest/confirm/(${TOKEN})`).exec(mail.text)[1];
  const manage = new RegExp(`/cart/guest/manage/(${TOKEN})`).exec(mail.text)[1];
  assert.match(mail.text, new RegExp(`^${app.base.replace(/[.]/g, "\\.")}/cart/guest/confirm/`, "m"), "an absolute link");

  // confirm: the page has the button with a token; posting without it is refused
  const other = visitor(); // another browser (the email opened on a phone)
  const ask = await (await other.get(`/cart/guest/confirm/${confirm}`)).text();
  const askToken = /name="_csrf" value="([0-9a-f]{64})"/.exec(ask)[1];
  assert.equal((await other.post(`/cart/guest/confirm/${confirm}`, {})).status, 403);
  const { rows: [still] } = await pool.query("SELECT guest_confirmed_at FROM orders WHERE buyer_email = $1", [email]);
  assert.equal(still.guest_confirmed_at, null);
  const done = await other.post(`/cart/guest/confirm/${confirm}`, { _csrf: askToken });
  assert.equal(done.status, 303);
  assert.match(done.headers.get("location"), new RegExp(`^/cart/guest/manage/${TOKEN}\\?notice=confirmed$`));
  const { rows: [conf] } = await pool.query("SELECT id, guest_confirmed_at, status FROM orders WHERE buyer_email = $1", [email]);
  assert.ok(conf.guest_confirmed_at);
  const full = (await mailsTo(email)).pop();
  assert.match(full.text, /To see or cancel your reservation \(no account needed\)/);

  // manage cancel: refused without the token, works with it
  const page = await (await other.get(`/cart/guest/manage/${manage}`)).text();
  const pageToken = /name="_csrf" value="([0-9a-f]{64})"/.exec(page)[1];
  assert.equal((await other.post(`/cart/guest/manage/${manage}/cancel`, {})).status, 403);
  assert.equal((await pool.query("SELECT status FROM orders WHERE id = $1", [conf.id])).rows[0].status, "reserved");
  const cancel = await other.post(`/cart/guest/manage/${manage}/cancel`, { _csrf: pageToken });
  assert.equal(cancel.status, 303);
  assert.equal((await pool.query("SELECT status FROM orders WHERE id = $1", [conf.id])).rows[0].status, "cancelled");
  assert.equal((await pool.query("SELECT status FROM book_copies WHERE id = $1", [c.copyId])).rows[0].status, "in_stock");
});

test("guest orders are attached to an account with the same email only once that email is CONFIRMED", async () => {
  const email = `attach-${uniq()}@example.test`;
  const g = await guestReserve(email.toUpperCase());
  assert.equal(g.order.user_id, null);
  // an account with that address whose email is NOT confirmed (an address an admin changed; it can still log in)
  const account = await createAccount(pool, { email, confirmed: false });
  const v = visitor();
  await signIn(v, account);
  assert.equal((await pool.query("SELECT user_id FROM orders WHERE id = $1", [g.order.id])).rows[0].user_id, null, "never attached on an unconfirmed email");
  assert.doesNotMatch(await (await v.get("/account")).text(), new RegExp(`Reservation #${g.order.id}\\b`));

  // the email link confirms it: attached now
  const raw = require("node:crypto").randomBytes(32).toString("hex");
  await pool.query("INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [account.id, hashToken(raw)]);
  const page = await (await v.get(`/verify-email/${raw}`)).text();
  const token = /name="_csrf" value="([0-9a-f]{64})"/.exec(page)[1];
  const r = await v.post(`/verify-email/${raw}`, { _csrf: token });
  assert.equal(r.status, 302);
  assert.equal((await pool.query("SELECT user_id FROM orders WHERE id = $1", [g.order.id])).rows[0].user_id, account.id, "attached once confirmed");
  // it now belongs to the account: the account page lists it and the account's own cancel works
  const v2 = visitor();
  await signIn(v2, account);
  const acc = await (await v2.get("/account")).text();
  assert.match(acc, new RegExp(`/cart/reservations/${g.order.id}/cancel`));
  const cancel = await v2.post(`/cart/reservations/${g.order.id}/cancel`, { _csrf: /name="_csrf" value="([0-9a-f]{64})"/.exec(acc)[1] });
  assert.match(cancel.headers.get("location"), /reservation-cancelled/);

  // an account confirmed earlier: a guest order made later with its email is attached at the next login
  const known = await createAccount(pool, { email: `known-${uniq()}@example.test` });
  const later = await guestReserve(known.email);
  assert.equal(later.order.user_id, null, "not at the moment of the guest order (nobody proved the inbox then)");
  await signIn(visitor(), known);
  assert.equal((await pool.query("SELECT user_id FROM orders WHERE id = $1", [later.order.id])).rows[0].user_id, known.id);
  // a disabled account gets nothing
  const disabled = await createAccount(pool, { email: `disabled-${uniq()}@example.test` });
  const d = await guestReserve(disabled.email);
  await pool.query("UPDATE users SET is_disabled = TRUE WHERE id = $1", [disabled.id]);
  const { attachGuestOrders } = require("../../src/lib/guestOrders");
  assert.equal(await attachGuestOrders(pool, disabled.id), 0);
  assert.equal((await pool.query("SELECT user_id FROM orders WHERE id = $1", [d.order.id])).rows[0].user_id, null);
});

test("favourites: the page needs no account; sign-in merges the browser's list into the account (CSRF, once per login)", async () => {
  const guest = visitor();
  const fav = await guest.get("/favorites");
  assert.equal(fav.status, 200, "no sign-in redirect");
  const a = await newCopy();
  const b = await newCopy();
  // signed out: nothing is stored on the server
  const out = await guest.post("/api/favorites/merge", { ids: `${a.bookId}`, _csrf: await guest.token() });
  assert.equal(out.status, 204);
  const account = await createAccount(pool, { email: `fav-${uniq()}@example.test` });
  await pool.query("INSERT INTO favorites (user_id, book_id) VALUES ($1, $2)", [account.id, b.bookId]);
  const v = visitor();
  await signIn(v, account);
  assert.equal((await v.session()).favoritesMerge, true, "the browser is asked to merge after a sign-in");
  assert.equal((await v.post("/api/favorites/merge", { ids: `${a.bookId}` })).status, 403, "CSRF");
  const r = await v.post("/api/favorites/merge", { ids: `${a.bookId},${a.bookId},999999999,abc`, _csrf: await v.token() });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).ids.sort((x, y) => x - y), [a.bookId, b.bookId].sort((x, y) => x - y), "the account's whole list comes back");
  const { rows } = await pool.query("SELECT book_id FROM favorites WHERE user_id = $1 ORDER BY book_id", [account.id]);
  assert.deepEqual(rows.map((x) => x.book_id), [a.bookId, b.bookId].sort((x, y) => x - y), "unknown ids skipped");
  assert.equal((await v.session()).favoritesMerge, false, "once per login session");
});

test("in Chrome: signed-out favourites stay in the browser, show on the Favorites page, and are merged into the account at sign-in", async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  const a = await newCopy();
  const account = await createAccount(pool, { email: `chrome-fav-${uniq()}@example.test` });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setExtraHTTPHeaders({ "x-forwarded-for": newIp() });
  try {
    await page.goto(`${app.base}/books/${a.bookId}`, { waitUntil: "networkidle0" });
    await page.click(`.favorite-toggle[data-book-id="${a.bookId}"]`);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("umasbooks.favorites"))), [a.bookId]);
    await page.goto(`${app.base}/favorites`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.querySelectorAll("#favorites-list .book-card-wrap").length === 1, { timeout: 8000 });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM favorites WHERE user_id = $1", [account.id])).rows[0].n, 0);
    await page.goto(`${app.base}/login`, { waitUntil: "networkidle0" });
    await page.type("input[name=email]", account.email);
    await page.type("input[name=password]", account.password);
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.$eval("input[name=password]", (i) => i.form.requestSubmit())]);
    const deadline = Date.now() + 8000;
    let n = 0;
    while (Date.now() < deadline && n === 0) {
      n = (await pool.query("SELECT count(*)::int AS n FROM favorites WHERE user_id = $1 AND book_id = $2", [account.id, a.bookId])).rows[0].n;
      if (!n) await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(n, 1, "the signed-out favourite is now the account's");
  } finally {
    await ctx.close();
  }
});
