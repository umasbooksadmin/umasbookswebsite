// Reserving (books and drop-in seats: nothing is paid online) requires an account.
//
//  - A guest can browse and fill the cart, but POST /cart/reserve (and GET
//    /cart/checkout, kept as a harmless bookmark redirect) sends them to the
//    login page (with a safe returnTo=/cart) and creates nothing.
//  - The cart survives the login's session regeneration, and the whole
//    signup -> confirm email -> choose password -> login path (the returnTo
//    travels inside the single-use tokens), and every open-redirect attempt
//    is refused.
//  - A logged-in account reserves under its OWN confirmed email (a posted
//    email is ignored), the order carries user_id, and the old rules (CGV,
//    price guard, caps) are untouched (their own test files).
//  - Preview mode keeps its 403 notice: the login redirect never masks it.
//  - Orders created before the change (user_id NULL, status 'pending') still show
//    their page by token, and the old online-payment endpoint is gone (404).
//
// In-process (test/helpers/inProcessApp.js): the mailer is stubbed, HelloAsso
// must never be called (it throws here), and the REAL auth + cart routes run,
// including the real login with its session regeneration. Every request carries
// its own client IP (trusted X-Forwarded-For) so the per-IP limits of the
// files sharing the CI database never collide.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");
const { makeCookieJar } = require("../helpers/httpClient");
const { createAccount } = require("../helpers/accounts");
const { MAX_ACTIVE_RESERVATIONS } = require("../../src/lib/legal");

const db = prepareDatabase("account_to_buy", { isolated: true });

const mailer = require("../../src/mailer");
const sentEmails = [];
mailer.sendMail = async (opts) => { sentEmails.push(opts); };

// Nothing about buying may talk to HelloAsso any more: every call here throws and is counted.
const helloasso = require("../../src/lib/helloasso");
const helloassoCalls = [];
for (const name of Object.keys(helloasso)) {
  if (typeof helloasso[name] !== "function") continue;
  helloasso[name] = async () => { helloassoCalls.push(name); throw new Error(`HelloAsso must not be called (${name})`); };
}
// Membership (the only thing still paid online) is looked up at signup/login: nothing to find here.
helloasso.isConfigured = () => true;
helloasso.findMembershipOrdersByEmail = async () => [];

// The password-breach lookup is a network call; keep these tests offline.
const realFetch = global.fetch;
global.fetch = (url, ...rest) => (String(url).includes("pwnedpasswords.com")
  ? Promise.resolve(new Response("", { status: 200 }))
  : realFetch(url, ...rest));

const { pool } = require("../../src/db");

let server;
before(async () => {
  db.create();
  const express = require("express");
  const { isPreviewMode } = require("../../src/lib/preview");
  const previewLocals = express.Router();
  previewLocals.use((req, res, next) => { res.locals.preview = isPreviewMode(); next(); });
  // A session store whose writes land late (like a busy database): only when a
  // route awaits its own save before redirecting does the next request see the change.
  const slowSave = express.Router();
  slowSave.use((req, res, next) => {
    if (req.get("x-slow-session")) {
      const orig = req.session.save.bind(req.session);
      req.session.save = (cb) => setTimeout(() => orig(cb), 150);
    }
    next();
  });
  const app = buildApp([slowSave, previewLocals, require("../../src/routes/auth"), require("../../src/routes/cart")]);
  app.set("trust proxy", true);
  server = await listen(app);
});
after(async () => {
  delete process.env.PREVIEW_MODE;
  global.fetch = realFetch;
  await server.close();
  await pool.end();
  db.drop();
});
beforeEach(() => {
  sentEmails.length = 0;
  delete process.env.PREVIEW_MODE;
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let ipSeq = Math.floor(Math.random() * 200) * 250;
const nextIp = () => { ipSeq += 1; return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`; };

function guest(lang, fixedIp) {
  const jar = makeCookieJar();
  const ip = fixedIp || nextIp();
  const send = async (path, { method = "GET", form } = {}) => {
    const res = await fetch(`${server.base}${path}`, {
      method,
      redirect: "manual",
      headers: {
        "x-forwarded-for": ip,
        cookie: [jar.header(), lang ? `umasbooks_lang=${lang}` : ""].filter(Boolean).join("; "),
        ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    jar.capture(res);
    return { res, text: await res.text(), location: res.headers.get("location") };
  };
  return {
    jar,
    get: (p) => send(p),
    post: (p, form) => send(p, { method: "POST", form }),
    count: async () => JSON.parse((await send("/api/cart/count")).text).count,
    sessionCookie: () => jar.header().split("; ").find((c) => c.startsWith("test.sid=")),
  };
}

async function makeCopy(price = 6) {
  const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'Acct Author') RETURNING id", [`Acct Book ${uniq()}`]);
  const { rows } = await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', $2) RETURNING id", [b[0].id, price]);
  return rows[0].id;
}
const copyStatus = async (id) => (await pool.query("SELECT status FROM book_copies WHERE id = $1", [id])).rows[0].status;
const ordersFor = async (email) => (await pool.query("SELECT * FROM orders WHERE buyer_email = $1 ORDER BY id", [email])).rows;
const login = (v, account, extra = {}) => v.post("/login", { email: account.email, password: account.password, ...extra });

// ---------- 1. a guest is stopped at the reservation ----------

test("guest POST /cart/reserve creates nothing and redirects to login with returnTo=/cart; the cart is kept", async () => {
  const v = guest();
  const copy = await makeCopy();
  await v.post("/cart/add", { copyId: copy });
  const before = (await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n;

  const r = await v.post("/cart/reserve", { name: "Guest", email: "guest@example.test", acceptCgv: "on" });
  assert.equal(r.res.status, 302);
  assert.equal(r.location, "/login?returnTo=%2Fcart");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n, before, "no order row");
  assert.equal(await copyStatus(copy), "in_stock", "nothing held");
  assert.equal(await v.count(), 1, "the cart is still there");
  assert.equal((await ordersFor("guest@example.test")).length, 0);
  // The old online-payment endpoint is gone for everyone.
  assert.equal((await v.post("/cart/checkout", { name: "Guest", acceptCgv: "on" })).res.status, 404);
});

test("guest GET /cart/checkout redirects to login too; a logged-in GET just goes back to the cart", async () => {
  const anon = guest();
  assert.equal((await anon.get("/cart/checkout")).location, "/login?returnTo=%2Fcart");
  const v = guest();
  const account = await createAccount(pool, { email: `getco-${uniq()}@example.test` });
  assert.equal((await login(v, account)).res.status, 302);
  assert.equal((await v.get("/cart/checkout")).location, "/cart");
});

test("a drop-in seat needs the account too (same reservation)", async () => {
  const { rows } = await pool.query("INSERT INTO classes (title, starts_at, capacity, dropin_price) VALUES ('Acct Session', $1, 5, 8) RETURNING id", [new Date(Date.now() + 7 * 86400000)]);
  const v = guest();
  await v.post("/cart/add-dropin", { classId: rows[0].id });
  const r = await v.post("/cart/reserve", { name: "G", acceptCgv: "on" });
  assert.equal(r.location, "/login?returnTo=%2Fcart");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM class_dropin_seats WHERE class_id = $1", [rows[0].id])).rows[0].n, 0);
});

// ---------- 2. what the cart page shows ----------

test("the cart page: a guest sees the log-in-or-create-account block and no reservation form; an account holder the form with a read-only email", async () => {
  const copy = await makeCopy();
  for (const [lang, heading, loginLabel] of [
    ["en", "Log in or create an account to reserve", "Log in"],
    ["fr", "Connectez-vous ou créez un compte pour réserver", "Se connecter"],
  ]) {
    const g = guest(lang);
    await g.post("/cart/add", { copyId: copy });
    const html = (await g.get("/cart")).text.replace(/<span class="nobr">|<\/span>/g, ""); // French headings keep "Connectez-vous" on one line
    assert.ok(html.includes(heading), `${lang}: heading`);
    assert.ok(html.includes(`href="/login?returnTo=%2Fcart"`) && html.includes(loginLabel), `${lang}: login link carries returnTo`);
    assert.ok(html.includes(`href="/signup?returnTo=%2Fcart"`), `${lang}: signup link carries returnTo`);
    assert.ok(!html.includes('action="/cart/reserve"'), `${lang}: no reservation form for a guest`);
  }

  const v = guest();
  const account = await createAccount(pool, { email: `form-${uniq()}@example.test`, displayName: "Form Person" });
  await login(v, account);
  await v.post("/cart/add", { copyId: copy });
  const html = (await v.get("/cart")).text;
  assert.ok(html.includes('action="/cart/reserve"'));
  assert.match(html, /<input id="name" name="name"[^>]*value="Form Person"/);
  assert.match(html, new RegExp(`<input id="accountEmail" type="email" value="${account.email.replace(/\./g, "\\.")}" readonly`));
  assert.doesNotMatch(html, /name="email"/, "the form posts no email at all");
  assert.ok(!html.includes("Log in or create an account to reserve"));
});

test("login and signup show the cart note when sent from the cart (EN/FR), and nothing for an unknown returnTo", async () => {
  for (const [lang, note] of [
    ["en", "Log in or create an account to reserve. Your cart is kept."],
    ["fr", "Connectez-vous ou créez un compte pour réserver. Votre panier est conservé."],
  ]) {
    for (const page of ["/login", "/signup"]) {
      const html = (await guest(lang).get(`${page}?returnTo=%2Fcart`)).text;
      assert.ok(html.includes(note), `${lang} ${page}: note`);
      assert.match(html, /<input type="hidden" name="returnTo" value="\/cart">/);
    }
  }
  const plain = (await guest("en").get("/login")).text;
  assert.ok(!plain.includes("Your cart is kept"));
  assert.ok(!plain.includes('name="returnTo"'));
});

// ---------- 3. the cart survives login and signup ----------

test("login regenerates the session (new session id) and keeps the cart; the person lands back on the cart", async () => {
  const v = guest();
  const copy = await makeCopy();
  await v.post("/cart/add", { copyId: copy });
  await v.get("/login?returnTo=%2Fcart");
  const before = v.sessionCookie();
  assert.ok(before, "a session existed before login");

  const account = await createAccount(pool, { email: `keep-${uniq()}@example.test` });
  const r = await login(v, account, { returnTo: "/cart" });
  assert.equal(r.res.status, 302);
  assert.equal(r.location, "/cart");
  assert.notEqual(v.sessionCookie(), before, "session id changed at login (fixation protection)");
  assert.equal(await v.count(), 1, "the cart came across the regeneration");
  const page = (await v.get("/cart")).text;
  assert.match(page, /Acct Book/);
  assert.ok(page.includes('action="/cart/reserve"'), "and now the reservation form shows");
});

test("signup -> confirm email -> choose password -> login returns to the cart with the items intact, then reserving works", async () => {
  const v = guest();
  const copy = await makeCopy(9);
  await v.post("/cart/add", { copyId: copy });
  const email = `flow-${uniq()}@example.test`;

  const signup = await v.post("/signup", { displayName: "Flow Person", email, returnTo: "/cart" });
  assert.equal(signup.res.status, 200);
  assert.match(signup.text, /emailed you a link/);
  const mail = await waitForMail(email);
  const confirmLink = mail.text.match(/https?:\/\/[^\s]+\/verify-email\/[0-9a-f]+/)[0];

  // The token row carries the destination (so a different browser works too).
  const { rows: tok } = await pool.query(
    "SELECT t.return_to FROM email_verification_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = $1", [email]);
  assert.deepEqual(tok.map((t) => t.return_to), ["/cart"]);

  const confirm = await v.post(new URL(confirmLink).pathname, { confirm: "1" });
  assert.match(confirm.location, /^\/reset-password\/[0-9a-f]+\?confirmed=1$/);
  const resetPath = confirm.location;
  const choose = await v.post(resetPath, { newPassword: "Correct-Horse-9!x" });
  assert.equal(choose.location, "/login?reset=confirmed&returnTo=%2Fcart");

  const loginPage = (await v.get(choose.location)).text;
  assert.match(loginPage, /<input type="hidden" name="returnTo" value="\/cart">/);
  assert.ok(loginPage.includes("Your cart is kept"));
  const done = await v.post("/login", { email, password: "Correct-Horse-9!x", returnTo: "/cart" });
  assert.equal(done.location, "/cart");
  assert.equal(await v.count(), 1, "cart intact after the whole flow");

  const buy = await v.post("/cart/reserve", { name: "Flow Person", acceptCgv: "on" });
  assert.equal(buy.res.status, 302);
  assert.match(buy.location, /^\/cart\/return\?order=[0-9a-f-]{36}$/);
  const [order] = await ordersFor(email);
  assert.ok(order.user_id);
  assert.equal(order.status, "reserved");
  assert.equal(await copyStatus(copy), "reserved");
});

async function waitForMail(to) {
  for (let i = 0; i < 100; i++) {
    const m = sentEmails.find((e) => e.to === to);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no email to ${to}`);
}

// ---------- 4. returnTo is local-only ----------

test("returnTo: open-redirect attempts are refused at login, signup and on the pages", async () => {
  const evil = ["//evil.example", "/\\evil.example", "https://evil.example", "/%5Cevil.example", "javascript:alert(1)", "evil.example", "/ok\nSet-Cookie: x=1"];
  const account = await createAccount(pool, { email: `redir-${uniq()}@example.test` });
  for (const target of evil) {
    const v = guest();
    const r = await login(v, account, { returnTo: target });
    assert.equal(r.res.status, 302);
    assert.equal(r.location, "/", `login with returnTo ${JSON.stringify(target)} falls back to the usual landing page`);

    const page = (await guest().get(`/login?returnTo=${encodeURIComponent(target)}`)).text;
    assert.ok(!page.includes('name="returnTo"'), `login page drops ${JSON.stringify(target)}`);

    const email = `redir-signup-${uniq()}@example.test`;
    await guest().post("/signup", { displayName: "R", email, returnTo: target });
    await waitForMail(email); // the token row is written just before the mail goes out
    const { rows } = await pool.query("SELECT t.return_to FROM email_verification_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = $1", [email]);
    assert.deepEqual(rows.map((t) => t.return_to), [null], `signup keeps nothing for ${JSON.stringify(target)}`);
  }
  // A logged-in user opening /login?returnTo=<evil> is not bounced off-site either.
  const v = guest();
  await login(v, account);
  assert.equal((await v.get("/login?returnTo=%2F%2Fevil.example")).location, "/");
  assert.equal((await v.get("/login?returnTo=%2Fcart")).location, "/cart");
});

// ---------- 5. a logged-in reservation ----------

test("logged-in reservation: order has user_id and the ACCOUNT's email; a posted email is ignored; the name is editable", async () => {
  const v = guest();
  const account = await createAccount(pool, { email: `Owner-${uniq()}@Example.TEST`, displayName: "Account Name" });
  await login(v, account);
  const copy = await makeCopy(7);
  await v.post("/cart/add", { copyId: copy });

  const r = await v.post("/cart/reserve", { name: "Edited Name", email: "victim@example.test", acceptCgv: "on", phone: "0600000000" });
  assert.equal(r.res.status, 302);
  assert.match(r.location, /^\/cart\/return\?order=[0-9a-f-]{36}$/);
  const [order] = await ordersFor(account.email);
  assert.equal(order.user_id, account.id);
  assert.equal(order.buyer_name, "Edited Name");
  assert.equal(order.buyer_email, account.email);
  assert.equal((await ordersFor("victim@example.test")).length, 0, "cannot order under another email");
  assert.equal(order.status, "reserved");
  assert.equal(await copyStatus(copy), "reserved");
  const { rows: held } = await pool.query("SELECT reserved_by_email FROM book_copies WHERE id = $1", [copy]);
  assert.equal(held[0].reserved_by_email, account.email, "the hold is under the account's email too");
  assert.ok(order.cgv_accepted_at && order.cgv_version, "terms acceptance still recorded");
});

test("the name defaults to the account's display name when the field is left empty", async () => {
  const v = guest();
  const account = await createAccount(pool, { email: `defname-${uniq()}@example.test`, displayName: "Default Name" });
  await login(v, account);
  await v.post("/cart/add", { copyId: await makeCopy() });
  await v.post("/cart/reserve", { name: "", acceptCgv: "on" });
  assert.equal((await ordersFor(account.email))[0].buyer_name, "Default Name");
});

test("an account whose email was never confirmed cannot reserve (nothing is sent to or reserved under it)", async () => {
  const v = guest();
  const account = await createAccount(pool, { email: `unconf-${uniq()}@example.test`, confirmed: false });
  // Not first_verification_pending: an old/admin-made account that never confirmed, so it can log in.
  assert.equal((await login(v, account)).res.status, 302);
  const copy = await makeCopy();
  await v.post("/cart/add", { copyId: copy });
  const page = (await v.get("/cart")).text;
  assert.ok(!page.includes('action="/cart/reserve"'));
  assert.match(page, /confirm your email address before reserving/);
  const r = await v.post("/cart/reserve", { name: "U", acceptCgv: "on" });
  assert.equal(r.res.status, 403);
  assert.equal((await ordersFor(account.email)).length, 0);
  assert.equal(await copyStatus(copy), "in_stock");
});

test("the reservation limits still apply per account: at most 3 open reservations, however many browsers it uses", async () => {
  const account = await createAccount(pool, { email: `cap-${uniq()}@example.test` });
  for (let i = 0; i < MAX_ACTIVE_RESERVATIONS; i++) {
    const v = guest();
    await login(v, account);
    await v.post("/cart/add", { copyId: await makeCopy() });
    assert.equal((await v.post("/cart/reserve", { name: "C", acceptCgv: "on" })).res.status, 302);
  }
  const v = guest();
  await login(v, account);
  const copy = await makeCopy();
  await v.post("/cart/add", { copyId: copy });
  const r = await v.post("/cart/reserve", { name: "C", acceptCgv: "on" });
  assert.equal(r.res.status, 200);
  assert.match(r.text, new RegExp(`already have ${MAX_ACTIVE_RESERVATIONS} open reservations`));
  assert.equal((await ordersFor(account.email)).length, MAX_ACTIVE_RESERVATIONS);
  assert.equal(await copyStatus(copy), "in_stock");
});

test("the per-IP limit is 10 reservations an hour (a shared wifi), while one account still stops at 3 open ones", async () => {
  const ip = nextIp();
  for (let a = 0; a < 5; a++) {
    const account = await createAccount(pool, { email: `wifi-${uniq()}-${a}@example.test` });
    for (let i = 0; i < 2; i++) {
      const v = guest(undefined, ip);
      await login(v, account);
      await v.post("/cart/add", { copyId: await makeCopy() });
      assert.equal((await v.post("/cart/reserve", { name: "W", acceptCgv: "on" })).res.status, 302, `account ${a} reservation ${i}`);
    }
  }
  const extra = await createAccount(pool, { email: `wifi-extra-${uniq()}@example.test` });
  const v = guest(undefined, ip);
  await login(v, extra);
  const copy = await makeCopy();
  await v.post("/cart/add", { copyId: copy });
  const r = await v.post("/cart/reserve", { name: "W", acceptCgv: "on" });
  assert.equal(r.res.status, 429, "the 11th reservation from one IP in an hour is refused");
  assert.equal((await ordersFor(extra.email)).length, 0);
  assert.equal(await copyStatus(copy), "in_stock");
});

// ---------- 6. preview mode keeps its own message ----------

test("preview mode: the 403 notice is never masked by the login redirect (order of checks: preview, then login)", async () => {
  process.env.PREVIEW_MODE = "true";
  const anon = guest();
  const copy = await makeCopy();
  await anon.post("/cart/add", { copyId: copy });
  const g = await anon.post("/cart/reserve", { name: "G", acceptCgv: "on" });
  assert.equal(g.res.status, 403, "a guest gets the preview refusal, not a redirect to login");
  assert.ok(g.text.includes("Online reservations open when we launch."));

  const v = guest();
  const account = await createAccount(pool, { email: `prev-${uniq()}@example.test` });
  await login(v, account);
  await v.post("/cart/add", { copyId: copy });
  const a = await v.post("/cart/reserve", { name: "A", acceptCgv: "on" });
  assert.equal(a.res.status, 403);
  assert.ok(a.text.includes("Online reservations open when we launch."));
  assert.equal((await ordersFor(account.email)).length, 0);
  assert.equal(await copyStatus(copy), "in_stock");

  assert.equal((await anon.get("/cart/checkout")).location, "/cart", "GET in preview goes to the cart, which carries the notice");
  const page = (await anon.get("/cart")).text;
  assert.ok(page.includes("Online reservations open when we launch."));
  assert.ok(!page.includes("Log in or create an account to reserve"), "the preview notice is shown instead of the login block");
});

// ---------- 7. orders from before the change ----------

test("an order created before the change (user_id NULL, still 'pending') still shows its page by token, with no session and no HelloAsso lookup", async () => {
  const copy = await makeCopy(5);
  const { rows } = await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, total_amount, status, checkout_intent_id, lang)
     VALUES ('Old Guest', $1, 5, 'pending', $2, 'en') RETURNING *`, [`old-guest-${uniq()}@example.test`, `old-intent-${uniq()}`]);
  const order = rows[0];
  assert.equal(order.user_id, null);
  await pool.query("UPDATE book_copies SET status = 'in_cart', cart_order_id = $1, cart_added_at = now() WHERE id = $2", [order.id, copy]);
  await pool.query("INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, 'Old', 5)", [order.id, copy]);

  const anon = guest(); // no login, no cart
  const r = await anon.get(`/cart/return?order=${order.access_token}`);
  assert.equal(r.res.status, 200);
  assert.match(r.text, /Reservation not completed|Reservation/, "a page, not an error");
  const { rows: after } = await pool.query("SELECT status, user_id FROM orders WHERE id = $1", [order.id]);
  assert.equal(after[0].status, "pending", "viewing it asks nobody and changes nothing");
  assert.equal(after[0].user_id, null, "still a guest-era order");
  assert.equal(await copyStatus(copy), "in_cart");
  assert.deepEqual(helloassoCalls, [], "no HelloAsso lookup");
});

// ---------- 8. the page for a rate-limited / validated post ----------

test("reservation errors are French for a French account holder", async () => {
  const v = guest("fr");
  const account = await createAccount(pool, { email: `fr-${uniq()}@example.test`, displayName: "" });
  await login(v, account);
  assert.match((await v.post("/cart/reserve", { name: "A", acceptCgv: "on" })).text, /Votre panier est vide/);
  await v.post("/cart/add", { copyId: await makeCopy() });
  assert.match((await v.post("/cart/reserve", { name: "", acceptCgv: "on" })).text, /Veuillez indiquer votre nom\./);
});

// ---------- 9. cart edits are saved before the redirect ----------

test("Add to cart / Remove: the session is saved BEFORE the redirect, so the cart is never empty right after (slow session store)", async () => {
  const jar = makeCookieJar();
  const ip = nextIp();
  const call = async (path, form) => {
    const res = await fetch(`${server.base}${path}`, {
      method: form ? "POST" : "GET", redirect: "manual",
      headers: { "x-forwarded-for": ip, "x-slow-session": "1", cookie: jar.header(), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    jar.capture(res);
    return res;
  };
  const count = async () => (await (await call("/api/cart/count")).json()).count;
  const copy = await makeCopy();
  assert.equal((await call("/cart/add", { copyId: copy })).status, 302);
  assert.equal(await count(), 1, "the line is there on the very next request");
  const lineId = Number((await (await call("/cart")).text()).match(/name="lineId" value="(\d+)"/)[1]);
  assert.equal((await call("/cart/remove", { lineId })).status, 302);
  assert.equal(await count(), 0, "and gone right after Remove");
});

test("buying never reached HelloAsso, anywhere in this file", () => {
  assert.deepEqual(helloassoCalls, []);
});
