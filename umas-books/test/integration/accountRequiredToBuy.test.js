// Buying (books and drop-in seats) requires an account.
//
//  - A guest can browse and fill the cart, but POST/GET /cart/checkout sends
//    them to the login page (with a safe returnTo=/cart) and creates nothing.
//  - The cart survives the login's session regeneration, and the whole
//    signup -> confirm email -> choose password -> login path (the returnTo
//    travels inside the single-use tokens), and every open-redirect attempt
//    is refused.
//  - A logged-in account checks out under its OWN confirmed email (a posted
//    email is ignored), the order carries user_id, and the old rules (CGV,
//    waiver, price guard, caps) are untouched (their own test files).
//  - Preview mode keeps its 403 notice: the login redirect never masks it.
//  - Orders created before this change (user_id NULL) still work by token.
//
// In-process (test/helpers/inProcessApp.js): HelloAsso and the mailer are
// stubbed, and the REAL auth + cart routes run, including the real login with
// its session regeneration. Every request carries its own client IP (trusted
// X-Forwarded-For) so no pending order is ever left on 127.0.0.1 for other
// files sharing the CI database.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");
const { makeCookieJar } = require("../helpers/httpClient");
const { createAccount } = require("../helpers/accounts");

const db = prepareDatabase("account_to_buy", { isolated: true });

const mailer = require("../../src/mailer");
const sentEmails = [];
mailer.sendMail = async (opts) => { sentEmails.push(opts); };

const helloasso = require("../../src/lib/helloasso");
helloasso.isConfigured = () => true;
const createdIntents = [];
let seqIntent = 0;
helloasso.createCheckoutIntent = async (args) => {
  createdIntents.push(args);
  const n = ++seqIntent;
  return { id: `acct-intent-${Date.now()}-${n}`, redirectUrl: `https://pay.example.test/acct/${n}` };
};
const intents = new Map();
helloasso.getCheckoutIntent = async (id) => {
  if (!intents.has(String(id))) throw new Error(`unknown intent ${id}`);
  return intents.get(String(id));
};
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
  createdIntents.length = 0;
  intents.clear();
  delete process.env.PREVIEW_MODE;
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let ipSeq = Math.floor(Math.random() * 200) * 250;
const nextIp = () => { ipSeq += 1; return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`; };

function visitor(lang) {
  const jar = makeCookieJar();
  const ip = nextIp();
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

// ---------- 1. a guest is stopped at checkout ----------

test("guest POST /cart/checkout creates nothing and redirects to login with returnTo=/cart; the cart is kept", async () => {
  const v = visitor();
  const copy = await makeCopy();
  await v.post("/cart/add", { copyId: copy });
  const before = (await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n;

  const r = await v.post("/cart/checkout", { name: "Guest", email: "guest@example.test", acceptCgv: "on" });
  assert.equal(r.res.status, 302);
  assert.equal(r.location, "/login?returnTo=%2Fcart");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n, before, "no order row");
  assert.equal(await copyStatus(copy), "in_stock", "nothing locked");
  assert.equal(createdIntents.length, 0, "no payment started");
  assert.equal(await v.count(), 1, "the cart is still there");
  assert.equal((await ordersFor("guest@example.test")).length, 0);
});

test("guest GET /cart/checkout redirects to login too; a logged-in GET just goes back to the cart", async () => {
  const guest = visitor();
  assert.equal((await guest.get("/cart/checkout")).location, "/login?returnTo=%2Fcart");
  const v = visitor();
  const account = await createAccount(pool, { email: `getco-${uniq()}@example.test` });
  assert.equal((await login(v, account)).res.status, 302);
  assert.equal((await v.get("/cart/checkout")).location, "/cart");
});

test("a drop-in seat needs the account too (same checkout)", async () => {
  const { rows } = await pool.query("INSERT INTO classes (title, starts_at, capacity, dropin_price) VALUES ('Acct Session', $1, 5, 8) RETURNING id", [new Date(Date.now() + 7 * 86400000)]);
  const v = visitor();
  await v.post("/cart/add-dropin", { classId: rows[0].id });
  const r = await v.post("/cart/checkout", { name: "G", acceptCgv: "on", waiveWithdrawal: "on" });
  assert.equal(r.location, "/login?returnTo=%2Fcart");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM class_dropin_seats WHERE class_id = $1", [rows[0].id])).rows[0].n, 0);
});

// ---------- 2. what the cart page shows ----------

test("the cart page: a guest sees the log-in-or-create-account block and no checkout form; an account holder the form with a read-only email", async () => {
  const copy = await makeCopy();
  for (const [lang, heading, loginLabel] of [
    ["en", "Log in or create an account to check out", "Log in"],
    ["fr", "Connectez-vous ou créez un compte pour commander", "Se connecter"],
  ]) {
    const g = visitor(lang);
    await g.post("/cart/add", { copyId: copy });
    const html = (await g.get("/cart")).text;
    assert.ok(html.includes(heading), `${lang}: heading`);
    assert.ok(html.includes(`href="/login?returnTo=%2Fcart"`) && html.includes(loginLabel), `${lang}: login link carries returnTo`);
    assert.ok(html.includes(`href="/signup?returnTo=%2Fcart"`), `${lang}: signup link carries returnTo`);
    assert.ok(!html.includes('action="/cart/checkout"'), `${lang}: no checkout form for a guest`);
  }

  const v = visitor();
  const account = await createAccount(pool, { email: `form-${uniq()}@example.test`, displayName: "Form Person" });
  await login(v, account);
  await v.post("/cart/add", { copyId: copy });
  const html = (await v.get("/cart")).text;
  assert.ok(html.includes('action="/cart/checkout"'));
  assert.match(html, /<input id="name" name="name"[^>]*value="Form Person"/);
  assert.match(html, new RegExp(`<input id="accountEmail" type="email" value="${account.email.replace(/\./g, "\\.")}" readonly`));
  assert.doesNotMatch(html, /name="email"/, "the form posts no email at all");
  assert.ok(!html.includes("Log in or create an account to check out"));
});

test("login and signup show the checkout note when sent from the cart (EN/FR), and nothing for an unknown returnTo", async () => {
  for (const [lang, note] of [
    ["en", "Log in or create an account to place your order. Your cart is kept."],
    ["fr", "Connectez-vous ou créez un compte pour passer votre commande. Votre panier est conservé."],
  ]) {
    for (const page of ["/login", "/signup"]) {
      const html = (await visitor(lang).get(`${page}?returnTo=%2Fcart`)).text;
      assert.ok(html.includes(note), `${lang} ${page}: note`);
      assert.match(html, /<input type="hidden" name="returnTo" value="\/cart">/);
    }
  }
  const plain = (await visitor("en").get("/login")).text;
  assert.ok(!plain.includes("Your cart is kept"));
  assert.ok(!plain.includes('name="returnTo"'));
});

// ---------- 3. the cart survives login and signup ----------

test("login regenerates the session (new session id) and keeps the cart; the person lands back on the cart", async () => {
  const v = visitor();
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
  assert.ok(page.includes('action="/cart/checkout"'), "and now the checkout form shows");
});

test("signup -> confirm email -> choose password -> login returns to the cart with the items intact, then checkout works", async () => {
  const v = visitor();
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

  const confirm = await v.get(new URL(confirmLink).pathname);
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

  const buy = await v.post("/cart/checkout", { name: "Flow Person", acceptCgv: "on" });
  assert.equal(buy.res.status, 302);
  assert.match(buy.location, /^https:\/\/pay\.example\.test\/acct\/\d+$/);
  const [order] = await ordersFor(email);
  assert.ok(order.user_id);
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
    const v = visitor();
    const r = await login(v, account, { returnTo: target });
    assert.equal(r.res.status, 302);
    assert.equal(r.location, "/", `login with returnTo ${JSON.stringify(target)} falls back to the usual landing page`);

    const page = (await visitor().get(`/login?returnTo=${encodeURIComponent(target)}`)).text;
    assert.ok(!page.includes('name="returnTo"'), `login page drops ${JSON.stringify(target)}`);

    const email = `redir-signup-${uniq()}@example.test`;
    await visitor().post("/signup", { displayName: "R", email, returnTo: target });
    await waitForMail(email); // the token row is written just before the mail goes out
    const { rows } = await pool.query("SELECT t.return_to FROM email_verification_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = $1", [email]);
    assert.deepEqual(rows.map((t) => t.return_to), [null], `signup keeps nothing for ${JSON.stringify(target)}`);
  }
  // A logged-in visitor opening /login?returnTo=<evil> is not bounced off-site either.
  const v = visitor();
  await login(v, account);
  assert.equal((await v.get("/login?returnTo=%2F%2Fevil.example")).location, "/");
  assert.equal((await v.get("/login?returnTo=%2Fcart")).location, "/cart");
});

// ---------- 5. a logged-in checkout ----------

test("logged-in checkout: order has user_id and the ACCOUNT's email; a posted email is ignored; the name is editable", async () => {
  const v = visitor();
  const account = await createAccount(pool, { email: `Owner-${uniq()}@Example.TEST`, displayName: "Account Name" });
  await login(v, account);
  const copy = await makeCopy(7);
  await v.post("/cart/add", { copyId: copy });

  const r = await v.post("/cart/checkout", { name: "Edited Name", email: "victim@example.test", acceptCgv: "on", phone: "0600000000" });
  assert.equal(r.res.status, 302);
  assert.match(r.location, /^https:\/\/pay\.example\.test\/acct\/\d+$/);
  const [order] = await ordersFor(account.email);
  assert.equal(order.user_id, account.id);
  assert.equal(order.buyer_name, "Edited Name");
  assert.equal(order.buyer_email, account.email);
  assert.equal((await ordersFor("victim@example.test")).length, 0, "cannot order under another email");
  assert.equal(createdIntents[0].payer.email, account.email);
  assert.equal(await copyStatus(copy), "in_cart");
  assert.ok(order.cgv_accepted_at && order.cgv_version, "terms acceptance still recorded");
});

test("the name defaults to the account's display name when the field is left empty", async () => {
  const v = visitor();
  const account = await createAccount(pool, { email: `defname-${uniq()}@example.test`, displayName: "Default Name" });
  await login(v, account);
  await v.post("/cart/add", { copyId: await makeCopy() });
  await v.post("/cart/checkout", { name: "", acceptCgv: "on" });
  assert.equal((await ordersFor(account.email))[0].buyer_name, "Default Name");
});

test("an account whose email was never confirmed cannot order (nothing is sent to or ordered under it)", async () => {
  const v = visitor();
  const account = await createAccount(pool, { email: `unconf-${uniq()}@example.test`, confirmed: false });
  // Not first_verification_pending: an old/admin-made account that never confirmed, so it can log in.
  assert.equal((await login(v, account)).res.status, 302);
  const copy = await makeCopy();
  await v.post("/cart/add", { copyId: copy });
  const page = (await v.get("/cart")).text;
  assert.ok(!page.includes('action="/cart/checkout"'));
  assert.match(page, /confirm your email address before ordering/);
  const r = await v.post("/cart/checkout", { name: "U", acceptCgv: "on" });
  assert.equal(r.res.status, 403);
  assert.equal((await ordersFor(account.email)).length, 0);
  assert.equal(await copyStatus(copy), "in_stock");
});

test("the checkout caps still apply per account email", async () => {
  const account = await createAccount(pool, { email: `cap-${uniq()}@example.test` });
  for (let i = 0; i < 2; i++) {
    const v = visitor();
    await login(v, account);
    await v.post("/cart/add", { copyId: await makeCopy() });
    assert.equal((await v.post("/cart/checkout", { name: "C", acceptCgv: "on" })).res.status, 302);
  }
  const v = visitor();
  await login(v, account);
  await v.post("/cart/add", { copyId: await makeCopy() });
  const r = await v.post("/cart/checkout", { name: "C", acceptCgv: "on" });
  assert.equal(r.res.status, 200);
  assert.match(r.text, /already have unpaid orders/);
  assert.equal((await ordersFor(account.email)).length, 2);
});

// ---------- 6. preview mode keeps its own message ----------

test("preview mode: the 403 notice is never masked by the login redirect (order of checks: preview, then login)", async () => {
  process.env.PREVIEW_MODE = "true";
  const guest = visitor();
  const copy = await makeCopy();
  await guest.post("/cart/add", { copyId: copy });
  const g = await guest.post("/cart/checkout", { name: "G", acceptCgv: "on" });
  assert.equal(g.res.status, 403, "a guest gets the preview refusal, not a redirect to login");
  assert.ok(g.text.includes("Online ordering opens when we launch."));

  const v = visitor();
  const account = await createAccount(pool, { email: `prev-${uniq()}@example.test` });
  await login(v, account);
  await v.post("/cart/add", { copyId: copy });
  const a = await v.post("/cart/checkout", { name: "A", acceptCgv: "on" });
  assert.equal(a.res.status, 403);
  assert.ok(a.text.includes("Online ordering opens when we launch."));
  assert.equal((await ordersFor(account.email)).length, 0);
  assert.equal(await copyStatus(copy), "in_stock");

  assert.equal((await guest.get("/cart/checkout")).location, "/cart", "GET in preview goes to the cart, which carries the notice");
  const page = (await guest.get("/cart")).text;
  assert.ok(page.includes("Online ordering opens when we launch."));
  assert.ok(!page.includes("Log in or create an account to check out"), "the preview notice is shown instead of the login block");
});

// ---------- 7. orders from before this change ----------

test("an order created before this change (user_id NULL) still works by token: return page, reconcile, no session needed", async () => {
  const copy = await makeCopy(5);
  const { rows } = await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, total_amount, status, checkout_intent_id, lang)
     VALUES ('Old Guest', $1, 5, 'pending', $2, 'en') RETURNING *`, [`old-guest-${uniq()}@example.test`, `old-intent-${uniq()}`]);
  const order = rows[0];
  assert.equal(order.user_id, null);
  await pool.query("UPDATE book_copies SET status = 'in_cart', cart_order_id = $1, cart_added_at = now() WHERE id = $2", [order.id, copy]);
  await pool.query("INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, 'Old', 5)", [order.id, copy]);
  intents.set(String(order.checkout_intent_id), { id: order.checkout_intent_id, order: { id: 4242, payments: [{ state: "Authorized" }] } });

  const anon = visitor(); // no login, no cart
  const r = await anon.get(`/cart/return?order=${order.access_token}`);
  assert.equal(r.res.status, 200);
  const { rows: after } = await pool.query("SELECT status, user_id FROM orders WHERE id = $1", [order.id]);
  assert.equal(after[0].status, "paid");
  assert.equal(after[0].user_id, null, "still a guest-era order");
  assert.equal(await copyStatus(copy), "sold");
});

// ---------- 8. the page for a rate-limited / validated post ----------

test("checkout errors are French for a French account holder", async () => {
  const v = visitor("fr");
  const account = await createAccount(pool, { email: `fr-${uniq()}@example.test`, displayName: "" });
  await login(v, account);
  assert.match((await v.post("/cart/checkout", { name: "A", acceptCgv: "on" })).text, /Votre panier est vide/);
  await v.post("/cart/add", { copyId: await makeCopy() });
  assert.match((await v.post("/cart/checkout", { name: "", acceptCgv: "on" })).text, /Veuillez indiquer votre nom\./);
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
