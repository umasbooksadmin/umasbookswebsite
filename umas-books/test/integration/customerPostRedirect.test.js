// Customer forms redirect after submitting (Post/Redirect/Get). A POST that renders a page
// itself leaves a POST in the browser history, and Back then shows "Confirm form
// resubmission". This file checks that
//   1. (static) no customer POST/PUT/DELETE handler renders a page or sends a body itself,
//      except the allow-listed ones below (a download, JSON, 404 for forged ids, one-time secrets);
//   2. (HTTP, the real app) refused AND finished submissions answer 303 to a fixed GET path that
//      shows the message once, in the right language, keeping typed values but never a password
//      or a token; the limiters still count refusals; no open redirect.
// Own database and server: it creates users.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

// ---------- 1. static scan of every customer POST route ----------

const ROUTES_DIR = path.join(__dirname, "..", "..", "src", "routes");

// Handlers that may answer a POST with a body, and why.
const MAY_SEND = new Set([
  "/account/privacy/export", // the JSON data download (a refusal redirects)
  "/webhooks/helloasso", // server-to-server JSON for HelloAsso, not a browser form
  "/api/favorites/toggle", // fetch() from public/favorites.js: 204 / 400 / 404, no body
  "/api/favorites/merge", // fetch() from public/favorites.js at sign-in: JSON list of the account's favourites
  "/cart/add", // JSON only to fetch() from public/cart-add.js (Accept: application/json); a form post still redirects
  "/events/:id/signup", // plain-text 404 for a forged event id only
  "/volunteer/:id/signup", // plain-text 404 for a forged shift id only
]);
// Pages a POST may still render: the 404 page (a forged id), and the one-time recovery codes,
// which are stored only as hashes and must not travel through the session.
const MAY_RENDER = new Set(["404", "two_factor_codes"]);

function postHandlers(file) {
  const src = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
  // Chunks start at a route registration or a top-level function, so a helper that renders
  // pages for GET routes is not blamed on the POST before it.
  const parts = src.split(/^[ \t]*(?=router\.(?:get|post|put|patch|delete|use)\(|(?:async )?function |const \w+ = (?:async )?\()/m);
  const out = [];
  for (const part of parts) {
    const m = part.match(/^router\.(post|put|patch|delete)\(\s*([^,]+),/) || part.match(/^\s*router\.(post|put|patch|delete)\(\s*([^,]+),/);
    if (m) out.push({ file, route: m[2].trim().replace(/^"|"$/g, ""), code: part.replace(/^\s*\/\/.*$/gm, "") });
  }
  return out;
}

const customerFiles = () => fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".js"));

test("no customer POST/PUT/DELETE handler renders a page itself (every one redirects)", () => {
  const handlers = customerFiles().flatMap(postHandlers);
  assert.ok(handlers.length > 35, `found ${handlers.length} customer write routes`);
  const offenders = [];
  for (const { file, route, code } of handlers) {
    const renders = [...code.matchAll(/\.render\(\s*"([^"]+)"|\b(render[A-Z]\w*|sentPage|showForm)\(/g)]
      .filter((m) => !(m[1] && MAY_RENDER.has(m[1])))
      .map((m) => m[0]);
    const sends = MAY_SEND.has(route) ? null : code.match(/res\.(?:send|json|type)\(/g);
    if (renders.length || sends) offenders.push(`${file} ${route}: ${[...renders, ...(sends || [])].join(" ")}`);
  }
  assert.deepEqual(offenders, [], "these POST handlers answer with a page instead of a redirect");
});

test("no rate-limit handler renders a page either (it redirects to the form with its message)", () => {
  const offenders = [];
  for (const file of customerFiles()) {
    const src = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
    for (const m of src.matchAll(/handler:\s*\([^)]*\)\s*=>[\s\S]*?\n\s*\}\),?\n/g)) {
      if (/\.render\(|\brender[A-Z]\w*\(|showForm\(/.test(m[0])) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the allow-lists are not stale: every allowed route still exists", () => {
  const known = new Set(customerFiles().flatMap(postHandlers).map((h) => h.route));
  for (const r of MAY_SEND) assert.ok(known.has(r), `${r} is in MAY_SEND but is not a customer POST route any more`);
});

// ---------- 2. over HTTP ----------

const PORT = 4901;
const PASSWORD = "Redirect-Test-1!";
let app, pool;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
});
after(async () => {
  await pool.end();
  app.stop();
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function createUser({ member = false, verified = true } = {}) {
  const email = `pgr-${uniq()}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_member, email_verified_at)
     VALUES ($1, $2, 'Redirect Tester', $3, ${verified ? "now()" : "NULL"}) RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 10), member]
  );
  return { id: rows[0].id, email };
}

// One person's browser: cookies kept between requests, an optional language cookie.
function browser({ lang } = {}) {
  const jar = makeCookieJar();
  const cookie = () => [jar.header(), lang ? `umasbooks_lang=${lang}` : ""].filter(Boolean).join("; ");
  const send = async (method, p, fields) => {
    let body;
    const headers = { cookie: cookie() };
    if (fields) {
      const token = await fetchCsrfToken(app.base, { header: cookie, capture: (r) => jar.capture(r) });
      body = new URLSearchParams({ _csrf: token });
      for (const [k, v] of Object.entries(fields)) body.append(k, String(v));
      body = body.toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
      headers.cookie = cookie();
    }
    const res = await fetch(`${app.base}${p}`, { method, redirect: "manual", headers, body });
    jar.capture(res);
    return { res, status: res.status, location: res.headers.get("location"), text: await res.text() };
  };
  const b = {
    jar,
    get: (p) => send("GET", p),
    post: (p, f = {}) => send("POST", p, f),
    // POST, expect 303, follow it as the browser does; returns the page and where it was.
    async submit(p, f = {}) {
      const first = await send("POST", p, f);
      assert.equal(first.status, 303, `POST ${p} answers a redirect, not a page (got ${first.status})`);
      const page = await send("GET", first.location);
      return { ...page, target: first.location };
    },
    async login(user) {
      const r = await send("POST", "/login", { email: user.email, password: PASSWORD });
      assert.equal(r.status, 302, "login works");
      return b;
    },
  };
  return b;
}

const sessionRows = async () => (await pool.query("SELECT sess::text AS s FROM session")).rows.map((r) => r.s).join("\n");

test("login: refused attempts redirect to /login, say the same thing for every reason, and keep the e-mail but never the password", async () => {
  const user = await createUser();
  const secret = "Wr0ng-Secret-Pw-9!";
  const wrong = await browser().submit("/login", { email: user.email, password: secret });
  const unknown = await browser().submit("/login", { email: `nobody-${uniq()}@example.test`, password: secret });
  assert.equal(wrong.target, "/login");
  assert.equal(wrong.status, 200);
  assert.match(wrong.text, /Incorrect email or password\./);
  assert.ok(wrong.text.includes(`value="${user.email}"`), "the typed e-mail is back in the form");
  assert.ok(!wrong.text.includes(secret), "the password never comes back");
  assert.equal(unknown.target, wrong.target, "an unknown e-mail redirects to the same place");
  assert.match(unknown.text, /Incorrect email or password\./);
  assert.ok(!(await sessionRows()).includes(secret), "the password is not kept in the session store");

  // The message shows once: a reload of /login is clean.
  const b = browser();
  await b.submit("/login", { email: user.email, password: secret });
  assert.doesNotMatch((await b.get("/login")).text, /Incorrect email or password/);
});

test("login: French cookie gives the French message; returnTo is kept; an off-site returnTo is dropped", async () => {
  const user = await createUser();
  const fr = await browser({ lang: "fr" }).submit("/login", { email: user.email, password: "nope-Nope-1!" });
  assert.match(fr.text, /E-mail ou mot de passe incorrect\./);

  const kept = await browser().post("/login", { email: user.email, password: "nope-Nope-1!", returnTo: "/cart" });
  assert.equal(kept.status, 303);
  assert.equal(kept.location, "/login?returnTo=%2Fcart");
  for (const evil of ["//evil.example/x", "https://evil.example", "/\\evil.example"]) {
    const r = await browser().post("/login", { email: user.email, password: "nope-Nope-1!", returnTo: evil });
    assert.equal(r.location, "/login", `off-site returnTo ${evil} is not carried`);
  }
});

test("login: a disabled or unconfirmed account is told only after the right password (still a redirect)", async () => {
  const unconfirmed = await createUser({ verified: false });
  await pool.query("UPDATE users SET first_verification_pending = TRUE WHERE id = $1", [unconfirmed.id]);
  const wrong = await browser().submit("/login", { email: unconfirmed.email, password: "nope-Nope-1!" });
  assert.match(wrong.text, /Incorrect email or password\./);
  assert.doesNotMatch(wrong.text, /confirm your email first/i);
  const right = await browser().submit("/login", { email: unconfirmed.email, password: PASSWORD });
  assert.match(right.text, /Please confirm your email first/);
  assert.ok(right.text.includes(`value="${unconfirmed.email}"`), "the resend form has the address");
});

test("forgot-password and resend-verification: the same neutral redirect for known and unknown addresses", async () => {
  const user = await createUser();
  const a = await browser().submit("/forgot-password", { email: user.email });
  const b = await browser().submit("/forgot-password", { email: `nobody-${uniq()}@example.test` });
  assert.equal(a.target, "/forgot-password");
  assert.equal(a.target, b.target);
  assert.match(a.text, /If an account exists for that email/);
  assert.equal(a.text.replace(/value="[^"]*"/g, ""), b.text.replace(/value="[^"]*"/g, ""));
  const br = browser();
  await br.submit("/forgot-password", { email: user.email });
  assert.doesNotMatch((await br.get("/forgot-password")).text, /If an account exists/);

  const r = await browser().submit("/resend-verification", { email: user.email, returnTo: "/cart" });
  assert.equal(r.target, "/login?returnTo=%2Fcart");
  assert.match(r.text, /If that account is waiting for confirmation/);
});

test("signup: a refused form redirects and keeps the name and e-mail; a good one shows the neutral notice", async () => {
  const bad = await browser().submit("/signup", { displayName: "", email: "kept@example.test" });
  assert.equal(bad.target, "/signup");
  assert.match(bad.text, /All fields are required\./);
  assert.ok(bad.text.includes('value="kept@example.test"'));
  const ok = await browser().submit("/signup", { displayName: "New Person", email: `new-${uniq()}@example.test` });
  assert.match(ok.text, /Check your inbox/);
});

test("reset-password: a weak password goes back to the link's page with the message; the token is not kept", async () => {
  const user = await createUser();
  const raw = `${uniq()}-reset-token-${Math.random().toString(16).slice(2)}`;
  const { hashToken } = require("../../src/lib/resetTokens");
  await pool.query("INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [user.id, hashToken(raw)]);
  const b = browser();
  const weak = "short1";
  const r = await b.submit(`/reset-password/${raw}`, { newPassword: weak });
  assert.equal(r.target, `/reset-password/${raw}`);
  assert.match(r.text, /class="error-box"/);
  assert.ok(!r.text.includes(weak), "the typed password never comes back");
  const stored = await sessionRows();
  assert.ok(!stored.includes(raw) && !stored.includes(weak), "neither the token nor the password is in the session store");
  assert.doesNotMatch((await b.get(`/reset-password/${raw}`)).text, /class="error-box"/, "the message shows once");
  // A dead link goes back to its own page, which says so (the same 'invalid' page as before).
  const dead = await browser().post("/reset-password/not-a-real-token", { newPassword: "Str0ng-Enough-Pw!" });
  assert.equal(dead.status, 303);
  assert.equal(dead.location, "/reset-password/not-a-real-token");
  const page = await browser().get(dead.location);
  assert.equal(page.status, 400);
  assert.match(page.text, /invalid or has expired/);
});

test("account password change: wrong current password and success both redirect; wrong ones still count toward the limit", async () => {
  const user = await createUser();
  const b = await browser().login(user);
  const wrong = await b.submit("/account/password", { currentPassword: "nope-Nope-1!", newPassword: "Another-Good-1!" });
  assert.equal(wrong.target, "/account/password");
  assert.match(wrong.text, /Current password is incorrect\./);
  const weak = await b.submit("/account/password", { currentPassword: PASSWORD, newPassword: "weak" });
  assert.match(weak.text, /class="error-box"/);
  const ok = await b.submit("/account/password", { currentPassword: PASSWORD, newPassword: "Another-Good-1!" });
  assert.match(ok.text, /Password updated\./);
  assert.ok(ok.text.includes("/logout"), "the session that made the change is still logged in");
  // 5 wrong current passwords per account per 15 minutes: the 6th is refused whatever it holds.
  const c = await createUser();
  const bc = await browser().login(c);
  for (let i = 0; i < 5; i++) assert.equal((await bc.post("/account/password", { currentPassword: "nope-Nope-1!", newPassword: "Another-Good-1!" })).status, 303);
  assert.equal((await bc.post("/account/password", { currentPassword: PASSWORD, newPassword: "Another-Good-1!" })).status, 429);
});

test("contact: a refused form redirects, keeps what was typed, shows once; French is French; a sent message survives a reload", async () => {
  const b = browser();
  const r = await b.submit("/contact", { name: "Ada", email: "not-an-address", topic: "Events", message: "Hello there" });
  assert.equal(r.target, "/contact");
  assert.match(r.text, /Please fill in your name, a valid email address and your message\./);
  assert.ok(r.text.includes('value="Ada"') && r.text.includes("Hello there") && r.text.includes('value="not-an-address"'));
  assert.doesNotMatch((await b.get("/contact")).text, /Please fill in your name/);

  const fr = await browser({ lang: "fr" }).submit("/contact", { name: "", email: "", message: "" });
  assert.match(fr.text, /Veuillez indiquer votre nom/);

  const sent = await b.post("/contact", { name: "Ada", email: "ada@example.test", topic: "Events", message: "A real message" });
  assert.equal(sent.status, 302);
  assert.equal(sent.location, "/contact?sent=1");
  assert.match((await b.get("/contact?sent=1")).text, /Thank you/);
  assert.match((await b.get("/contact?sent=1")).text, /Thank you/, "reloading the confirmation works");
});

test("book requests: refusal and thank-you pages are GETs; the per-day limit is a redirect with its message; find-my-requests", async () => {
  const b = browser();
  const bad = await b.submit("/request-a-book", { title: "A Title", email: "nope", author: "Kept Author" });
  assert.equal(bad.target, "/request-a-book");
  assert.match(bad.text, /Please enter one valid email address/);
  assert.ok(bad.text.includes('value="A Title"') && bad.text.includes('value="Kept Author"'));

  const ok = await b.post("/request-a-book", { title: "Another Title", email: `br-${uniq()}@example.test` });
  assert.equal(ok.status, 303);
  assert.equal(ok.location, "/request-a-book/sent");
  for (let i = 0; i < 2; i++) assert.match((await b.get("/request-a-book/sent")).text, /Check your inbox/, "thank-you page works on reload");
  const honeypot = await browser().post("/request-a-book", { title: "Spam", email: "s@example.test", website: "http://spam.example" });
  assert.equal(honeypot.location, "/request-a-book/sent", "a bot sees the same answer");

  const find = await browser().post("/my-requests", { email: `nobody-${uniq()}@example.test` });
  assert.equal(find.status, 303);
  assert.equal(find.location, "/my-requests?sent=1");
  assert.match((await b.get("/my-requests?sent=1")).text, /If requests exist for that address/);
  const badFind = await browser().submit("/my-requests", { email: "nope" });
  assert.equal(badFind.target, "/my-requests");
  assert.match(badFind.text, /Please enter one valid email address/);

  const dead = "a".repeat(64);
  assert.equal((await browser().post(`/request-a-book/confirm/${dead}`)).location, `/request-a-book/confirm/${dead}`);
  assert.equal((await browser().get(`/request-a-book/confirm/${dead}`)).status, 400);
  assert.equal((await browser().post(`/my-requests/list/${dead}/cancel-all`)).location, `/my-requests/list/${dead}`);
  assert.equal((await browser().post(`/my-requests/${dead}/cancel`)).location, `/my-requests/${dead}`);

  // 5 requests a day per connection: the 6th is refused with its message (a redirect, nothing stored).
  const before6 = (await pool.query("SELECT count(*)::int AS n FROM book_requests")).rows[0].n;
  let last;
  for (let i = 0; i < 4; i++) last = await b.post("/request-a-book", { title: `Limit ${i}`, email: `lim-${i}-${uniq()}@example.test` });
  assert.equal(last.status, 303);
  const limited = await b.submit("/request-a-book", { title: "Too many", email: `lim-x-${uniq()}@example.test` });
  assert.equal(limited.target, "/request-a-book");
  assert.match(limited.text, /several requests today/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM book_requests WHERE title = 'Too many'")).rows[0].n, 0);
  assert.ok(before6 >= 0);
});

test("cart: a refused reservation redirects to /cart with its message and the typed name; shows once", async () => {
  const user = await createUser();
  const b = await browser().login(user);
  const r = await b.submit("/cart/reserve", { name: "Typed Name", phone: "0612345678", acceptCgv: "on" });
  assert.equal(r.target, "/cart");
  assert.match(r.text, /Your cart is empty\./);
  assert.doesNotMatch((await b.get("/cart")).text, /class="error-box"/, "the message shows once");

  const unconfirmed = await createUser({ verified: false });
  const bu = await browser().login(unconfirmed);
  const u = await bu.submit("/cart/reserve", { name: "X", acceptCgv: "on" });
  assert.equal(u.target, "/cart");
  assert.match(u.text, /confirm your email address before reserving/);

  const fr = await (await browser({ lang: "fr" }).login(user)).submit("/cart/reserve", { name: "N", acceptCgv: "on" });
  assert.match(fr.text, /Votre panier est vide\./);
  // A guest is still sent to the login page, as before.
  const guest = await browser().post("/cart/reserve", { name: "G", acceptCgv: "on" });
  assert.equal(guest.status, 302);
  assert.match(guest.location, /^\/login\?returnTo=/);
});

test("forum: a refused thread keeps the typed text; a report without a reason answers on the thread's page", async () => {
  const member = await createUser({ member: true });
  const b = await browser().login(member);
  const r = await b.submit("/forum/new", { title: "Only a title", body: "" });
  assert.equal(r.target, "/forum/new");
  assert.match(r.text, /Title and message are both required\./);
  assert.ok(r.text.includes('value="Only a title"'));
  const made = await b.post("/forum/new", { title: "T", body: "Body" });
  assert.equal(made.status, 302);
  const threadPath = made.location;
  const [, , threadId] = threadPath.split("/");
  const rep = await b.submit("/forum/report", { kind: "thread", id: threadId, reason: "", comment: "x" });
  assert.equal(rep.target, threadPath);
  assert.match(rep.text, /Please choose a reason for the report\./);
  assert.doesNotMatch((await b.get(threadPath)).text, /Please choose a reason/);
});

test("two-step: a wrong password or code goes back to /account/2fa with the message and still counts toward the limit", async () => {
  const user = await createUser();
  const b = await browser().login(user);
  await b.get("/account/2fa"); // opens the setup page, which creates the pending secret
  const wrong = await b.submit("/account/2fa/enable", { password: "nope-Nope-1!", code: "123456" });
  assert.equal(wrong.target, "/account/2fa");
  assert.match(wrong.text, /Your password didn&#39;t match/);
  assert.ok(!wrong.text.includes("nope-Nope-1!"));
  // 10 wrong tries per account per 15 minutes (one is spent above).
  let status;
  for (let i = 0; i < 9; i++) status = (await b.post("/account/2fa/enable", { password: "nope-Nope-1!", code: "123456" })).status;
  assert.equal(status, 303);
  assert.equal((await b.post("/account/2fa/enable", { password: PASSWORD, code: "123456" })).status, 429);
});

test("pre-registration and volunteer forms: a refusal redirects to the page, keeps the typed values, shows once", async () => {
  const b = browser();
  const r = await b.submit("/volunteer-signup", { name: "Kept Name", email: "nope", availability: "Saturdays" });
  assert.equal(r.target, "/volunteer.html");
  assert.ok(r.text.includes("Kept Name"));
  assert.match(r.text, /role="alert"/);
  assert.doesNotMatch((await b.get("/volunteer.html")).text, /Kept Name/, "a reload shows the blank form");
  const ok = await b.post("/volunteer-signup", { name: "Sam", email: "sam@example.test", consent: "1" });
  assert.equal(ok.location, "/volunteer.html?sent=1");
});

test("login throttling: refused logins (now 303) still count; the 21st failure from one address is a 429", async () => {
  const user = await createUser();
  const b = browser();
  const statuses = [];
  for (let i = 0; i < 30; i++) statuses.push((await b.post("/login", { email: user.email, password: `nope-${i}-Nope!` })).status);
  assert.ok(statuses.includes(429), "the per-address limit still engages");
  assert.ok(statuses.indexOf(429) <= 20, `limit reached after ${statuses.indexOf(429)} failures`);
  // The lock on the account itself is unchanged: after the throttle the right password from this address is refused too.
  assert.equal((await b.post("/login", { email: user.email, password: PASSWORD })).status, 429);
});
