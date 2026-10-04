// Customer book requests against the REAL app (src/index.js as a child
// process): CSRF on the public forms, the no-login flow end to end, the
// "My book requests" section for a logged-in customer who is not a member,
// the link from the Books page, and the admin page's access rules.
// The in-process files (bookRequestsPublic / bookRequestsAdmin) cover the
// details with a stubbed mailer.
//
// Port 3800 is reserved for this file.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3800;
const PASSWORD = "BookRequests1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let app, pool;

before(async () => {
  app = await startTestApp({ port: PORT });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
});
after(async () => {
  await pool.end();
  app.stop();
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function createUser() {
  const email = `bookreq-${uniq()}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at)
     VALUES ($1, $2, 'Reader One', now()) RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 10)]
  );
  return { id: rows[0].id, email };
}

async function loginJar(user) {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ email: user.email, password: PASSWORD, _csrf: token }).toString(),
  });
  jar.capture(res);
  assert.equal(res.status, 302, "test login should succeed");
  return jar;
}

async function post(jar, path, fields, { token = true } = {}) {
  const csrf = token ? await fetchCsrfToken(app.base, jar) : undefined;
  const res = await fetch(`${app.base}${path}`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ ...fields, ...(csrf ? { _csrf: csrf } : {}) }).toString(),
  });
  jar.capture(res);
  return { res, text: await res.text() };
}

test("the form is CSRF protected, and a visitor with no account gets the neutral page and a stored, unconfirmed request", async () => {
  const jar = makeCookieJar();
  const email = `visitor-${uniq()}@example.test`;
  const title = `Visitor Book ${uniq()}`;
  const noToken = await post(jar, "/request-a-book", { title, email }, { token: false });
  assert.equal(noToken.res.status, 403);
  assert.equal((await pool.query("SELECT 1 FROM book_requests WHERE lower(email) = $1", [email])).rowCount, 0);

  const ok = await post(jar, "/request-a-book", { title, email, author: "Someone", isbn: "978-0-14-143951-8" });
  assert.equal(ok.res.status, 200);
  assert.match(ok.text, /Check your inbox/);
  const { rows } = await pool.query("SELECT status, isbn, user_id, lang FROM book_requests WHERE lower(email) = $1", [email]);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].status, rows[0].isbn, rows[0].user_id, rows[0].lang], ["unconfirmed", "9780141439518", null, "en"]);
});

test("the public pages are reachable by anyone and the confirm GET never confirms", async () => {
  for (const path of ["/request-a-book", "/my-requests"]) {
    const res = await fetch(`${app.base}${path}`);
    assert.equal(res.status, 200, path);
  }
  const bad = await fetch(`${app.base}/request-a-book/confirm/${"a".repeat(64)}`);
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${app.base}/my-requests/${"b".repeat(64)}`)).status, 404);
});

test("the Books page links to the form in English and French", async () => {
  const en = await (await fetch(`${app.base}/books.html`, { headers: { cookie: "umasbooks_lang=en" } })).text();
  assert.match(en, /href="\/request-a-book"/);
  assert.match(en, /"bk\.band\.ask\.t":"Can't find a book\? Ask us"/);
  assert.match(en, /"bk\.empty\.ask"/);
  assert.match(en, /\/request-a-book">' \+ esc\(t\('bk\.empty\.ask'\)\)/, "the empty search result links to the form");
  assert.match(en, /"bk\.band\.ask\.t":"Vous ne trouvez pas un livre \? Demandez-nous"/);
});

test("My Account shows a non-member's book requests and lets them cancel one", async () => {
  const user = await createUser();
  const jar = await loginJar(user);
  const { rows } = await pool.query(
    "INSERT INTO book_requests (title, email, status, user_id) VALUES ($1, $2, 'open', $3) RETURNING id",
    [`Account Book ${uniq()}`, `elsewhere-${uniq()}@example.test`, user.id]
  );
  const page = await fetch(`${app.base}/account`, { headers: { cookie: jar.header() } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /My book requests/);
  assert.match(html, /Account Book /);

  const cancel = await post(jar, `/account/book-requests/${rows[0].id}/cancel`, {});
  assert.equal(cancel.res.status, 302);
  assert.equal(cancel.res.headers.get("location"), "/account");
  const after_ = (await pool.query("SELECT status, email, user_id FROM book_requests WHERE id = $1", [rows[0].id])).rows[0];
  assert.deepEqual([after_.status, after_.email, after_.user_id], ["cancelled", null, null]);

  // the form pre-fills a logged-in customer
  const form = await (await fetch(`${app.base}/request-a-book`, { headers: { cookie: jar.header() } })).text();
  assert.ok(form.includes(`value="${user.email}"`));
  const sent = await post(jar, "/request-a-book", { title: `Logged In ${uniq()}`, email: user.email });
  assert.match(sent.text, /Check your inbox/);
  assert.equal((await pool.query("SELECT user_id FROM book_requests WHERE lower(email) = $1 AND status = 'unconfirmed'", [user.email])).rows[0].user_id, user.id);
});

test("the admin Requests page is for admins only", async () => {
  const anon = await fetch(`${app.base}/admin/requests`, { redirect: "manual" });
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get("location"), "/login");
  const user = await createUser();
  const jar = await loginJar(user);
  const res = await fetch(`${app.base}/admin/requests`, { redirect: "manual", headers: { cookie: jar.header() } });
  assert.equal(res.status, 403);
  const notify = await post(jar, "/admin/requests/1/notify", {});
  assert.equal(notify.res.status, 403);
});
