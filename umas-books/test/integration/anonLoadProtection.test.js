// Anonymous load protection against the real app (child process):
//  - guest sessions are short (2 h; 24 h with a cart), logged-in ones keep 30 days
//  - a flood of cookie-less GETs of form pages is capped per IP: bounded rows,
//    then 429 with no new row, no cookie
//  - no-JS forms still post, CSRF is still enforced, a logged-in reservation works
//  - stale guest rows are pruned, logged-in rows never
//  - NUL bytes: no 500s; token pages are private, no-store
//  - catalogue search: per-IP limit, minimum length, same results
// Own database: it counts rows of the shared `session` table.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar } = require("../helpers/httpClient");
const { createAccount, loginOverHttp } = require("../helpers/accounts");
const { pruneStaleGuestSessions } = require("../../src/lib/sessionPrune");

const PORT = 4903;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const FORM = { "content-type": "application/x-www-form-urlencoded" };
let app;
let pool;
let n = 0;
const ip = () => `10.${Math.floor(++n / 250) % 250}.${n % 250}.${(Date.now() % 200) + 1}`;
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  // connect-pg-simple creates the `session` table lazily, after the first response: wait for it.
  await (await fetch(`${app.base}/api/csrf-token`, { headers: { "x-forwarded-for": "10.250.250.250" } })).text();
  await waitFor(async () => (await pool.query("SELECT to_regclass('public.session') AS t")).rows[0].t !== null);
});
after(async () => {
  await pool.end();
  await app.stop();
});

const sessionRows = async () => Number((await pool.query("SELECT count(*) FROM session")).rows[0].count);
const sidOf = (jar) => decodeURIComponent(jar.header().match(/umasbooks\.sid=s%3A([^.;]+)/)[1]);
async function waitFor(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition never became true");
    await new Promise((r) => setTimeout(r, 25));
  }
}
async function expiresInMs(jar) {
  // the row is written just after the response is sent
  await waitFor(async () => Number((await pool.query("SELECT count(*) FROM session WHERE sid = $1", [sidOf(jar)])).rows[0].count) > 0);
  const { rows } = await pool.query("SELECT (extract(epoch FROM (expire::timestamptz - now())) * 1000)::float8 AS ms FROM session WHERE sid = $1", [sidOf(jar)]);
  return rows[0].ms;
}
const near = (actual, expected, slack = 5 * 60 * 1000) => Math.abs(actual - expected) < slack;
const get = (path, { jar, ip: addr, headers = {} } = {}) =>
  fetch(`${app.base}${path}`, { redirect: "manual", headers: { ...(jar ? { cookie: jar.header() } : {}), ...(addr ? { "x-forwarded-for": addr } : {}), ...headers } });
const tokenOf = (html) => html.match(/name="_csrf" value="([0-9a-f]+)"/)[1];

test("a guest session lasts 2 hours: cookie and stored row", async () => {
  const jar = makeCookieJar();
  const res = await get("/login", { jar, ip: ip() });
  assert.equal(res.status, 200);
  jar.capture(res);
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("umasbooks.sid="));
  assert.ok(setCookie, "the login form still gets a session cookie");
  const expires = new Date(/Expires=([^;]+)/i.exec(setCookie)[1]).getTime();
  assert.ok(near(expires - Date.now(), 2 * HOUR), `cookie expires in ~2 h (was ${(expires - Date.now()) / HOUR} h)`);
  assert.ok(near(await expiresInMs(jar), 2 * HOUR), "the stored row expires in ~2 h");
});

test("a guest with a cart gets 24 hours", async () => {
  const jar = makeCookieJar();
  const addr = ip();
  const page = await get("/login", { jar, ip: addr });
  jar.capture(page);
  const token = tokenOf(await page.text());
  const { rows: [book] } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'A') RETURNING id", [`Cart book ${uniq()}`]);
  const { rows: [copy] } = await pool.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 5, 'very_good') RETURNING id", [book.id]);
  const add = await fetch(`${app.base}/cart/add`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie: jar.header(), "x-forwarded-for": addr }, body: new URLSearchParams({ copyId: String(copy.id), _csrf: token }).toString() });
  assert.equal(add.status, 302);
  jar.capture(add);
  for (let i = 0; i < 50; i++) {
    const r = await (await get("/api/cart/count", { jar, ip: addr })).json();
    if (r.count === 1) break;
    await new Promise((r2) => setTimeout(r2, 20));
  }
  assert.ok(near(await expiresInMs(jar), DAY), "stored row expires in ~24 h");
});

test("logging in gives the normal 30 days; an admin login too (admin idle/absolute limits are enforced separately)", async () => {
  for (const admin of [false, true]) {
    const acc = await createAccount(pool, { email: `anon-lp-${admin ? "adm" : "usr"}-${uniq()}@example.test` });
    if (admin) await pool.query("UPDATE users SET is_admin = true WHERE id = $1", [acc.id]);
    const jar = makeCookieJar();
    const addr = ip();
    const res = await loginOverHttp(app.base, jar, acc, { "x-forwarded-for": addr });
    assert.equal(res.status, 302);
    assert.ok(near(await expiresInMs(jar), 30 * DAY), `${admin ? "admin" : "user"} row expires in ~30 days`);
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("umasbooks.sid="));
    const expires = new Date(/Expires=([^;]+)/i.exec(setCookie)[1]).getTime();
    assert.ok(near(expires - Date.now(), 30 * DAY), "cookie ~30 days");
    // still logged in on the next request
    const me = await (await get("/api/session", { jar, ip: addr })).json();
    assert.equal(me.loggedIn, true);
    assert.equal(me.isAdmin, admin);
  }
});

test("a cookie-less GET flood of form pages is capped: bounded rows, then 429 with no row and no cookie", async () => {
  const addr = ip();
  const before = await sessionRows();
  const statuses = [];
  for (let i = 0; i < 70; i++) {
    const res = await get(i % 2 ? "/login" : "/signup", { ip: addr });
    statuses.push(res.status);
    await res.text();
  }
  assert.equal(statuses.filter((s) => s === 200).length, 60);
  assert.equal(statuses.filter((s) => s === 429).length, 10);
  assert.equal(await sessionRows() - before, 60, "exactly 60 rows were created, never 70");

  const blocked = await get("/login", { ip: addr });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("set-cookie"), null, "no session cookie");
  assert.ok(blocked.headers.get("retry-after"));
  assert.match(await blocked.text(), /Too many requests/);
  const fr = await get("/contact", { ip: addr, headers: { cookie: "umasbooks.lang=fr" } });
  assert.equal(fr.status, 429);
  const csrf = await get("/api/csrf-token", { ip: addr });
  assert.equal(csrf.status, 429);
  assert.deepEqual(await csrf.json(), { error: "rate_limited" });
  assert.equal(await sessionRows() - before, 60, "still 60");

  // somebody else, and a visitor who already has a session, are unaffected
  const other = await get("/login", { ip: ip() });
  assert.equal(other.status, 200);
  await other.text();
  const jar = makeCookieJar();
  const first = await get("/login", { jar, ip: ip() });
  jar.capture(first);
  await first.text();
  for (let i = 0; i < 100; i++) { // the store write finishes just after the response
    if (Number((await pool.query("SELECT count(*) FROM session WHERE sid = $1", [sidOf(jar)])).rows[0].count)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal((await get("/login", { jar, ip: addr })).status, 200, "a valid session cookie still works from the blocked address");
});

test("pages that do not store anything (marketing pages) never count and never create rows", async () => {
  const addr = ip();
  const before = await sessionRows();
  for (let i = 0; i < 80; i++) {
    const res = await get(i % 2 ? "/books.html" : "/", { ip: addr });
    assert.notEqual(res.status, 429);
    assert.equal(res.headers.get("set-cookie"), null);
    await res.text();
  }
  assert.equal(await sessionRows(), before);
});

test("no-JS forms still post, and CSRF is still enforced", async () => {
  const jar = makeCookieJar();
  const addr = ip();
  const page = await get("/contact", { jar, ip: addr });
  assert.equal(page.status, 200);
  jar.capture(page);
  const token = tokenOf(await page.text());

  const noToken = await fetch(`${app.base}/contact`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie: jar.header(), "x-forwarded-for": addr }, body: new URLSearchParams({ name: "A", email: "a@example.test", message: "hello there" }).toString() });
  assert.equal(noToken.status, 403);
  const wrong = await fetch(`${app.base}/contact`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie: jar.header(), "x-forwarded-for": addr }, body: new URLSearchParams({ name: "A", email: "a@example.test", message: "hello there", _csrf: "0".repeat(64) }).toString() });
  assert.equal(wrong.status, 403);
  const ok = await fetch(`${app.base}/contact`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie: jar.header(), "x-forwarded-for": addr }, body: new URLSearchParams({ name: "A", email: "a@example.test", message: "hello there", website: "", _csrf: token }).toString() });
  assert.notEqual(ok.status, 403, "a form with the rendered token is accepted");
  assert.ok([200, 302, 303].includes(ok.status), `contact post answered ${ok.status}`);
});

test("a logged-in person can still add to the cart and reserve", async () => {
  const acc = await createAccount(pool, { email: `anon-lp-res-${uniq()}@example.test` });
  const { rows: [book] } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'A') RETURNING id", [`Reserve book ${uniq()}`]);
  const { rows: [copy] } = await pool.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 5, 'very_good') RETURNING id", [book.id]);
  const jar = makeCookieJar();
  const addr = ip();
  assert.equal((await loginOverHttp(app.base, jar, acc, { "x-forwarded-for": addr })).status, 302);
  const csrf = (await (await get("/api/csrf-token", { jar, ip: addr })).json()).token;
  const post = (path, fields) => fetch(`${app.base}${path}`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie: jar.header(), "x-forwarded-for": addr }, body: new URLSearchParams({ ...fields, _csrf: csrf }).toString() });
  assert.equal((await post("/cart/add", { copyId: String(copy.id) })).status, 302);
  for (let i = 0; i < 50; i++) {
    if ((await (await get("/api/cart/count", { jar, ip: addr })).json()).count === 1) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const reserve = await post("/cart/reserve", { name: "Ada Lovelace", phone: "0102030405", acceptCgv: "on" });
  assert.equal(reserve.status, 302);
  assert.match(reserve.headers.get("location"), /^\/cart\/return\?order=/);
  assert.ok(near(await expiresInMs(jar), 30 * DAY), "still a 30-day session");
  const page = await get(reserve.headers.get("location"), { jar, ip: addr });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store", "a logged-in response is no-store");
});

test("token pages are private, no-store for anonymous holders too", async () => {
  const { rows: [o] } = await pool.query(
    `INSERT INTO orders (status, buyer_name, buyer_email, total_amount) VALUES ('reserved', 'Tok Holder', $1, 5) RETURNING access_token`,
    [`tok-${uniq()}@example.test`]
  ).catch(() => ({ rows: [{}] }));
  const addr = ip();
  const paths = ["/cart/return?order=00000000-0000-0000-0000-000000000000", "/my-requests/abcdef", "/my-requests/list/abcdef", "/request-a-book/confirm/abcdef", "/reset-password/abcdef", "/verify-email/abcdef"];
  if (o && o.access_token) paths.push(`/cart/return?order=${o.access_token}`);
  for (const p of paths) {
    const res = await get(p, { ip: addr });
    await res.text();
    // some routes send their own (stricter or equal) no-store; the reservation page and the rest get private, no-store
    assert.match(res.headers.get("cache-control") || "", /no-store/, p);
    if (p.startsWith("/cart/return") || p.startsWith("/reset-password")) assert.equal(res.headers.get("cache-control"), "private, no-store", p);
  }
});

test("NUL bytes never 500", async () => {
  const addr = ip();
  for (const p of ["/api/books/search?q=a%00b", "/api/books/search?genre=a%00b", "/api/books/search?topic=a%00b,c", "/api/books/search?q=%00", "/api/books/by-ids?ids=1%002", "/login?returnTo=a%00b"]) {
    const res = await get(p, { ip: addr });
    await res.text();
    assert.ok(res.status < 500, `${p} answered ${res.status}`);
  }
  for (const p of ["/books/1%00", "/my-requests/a%00b", "/reset-password/a%00b"]) {
    const res = await get(p, { ip: addr });
    await res.text();
    assert.equal(res.status, 400, p);
  }
  const jar = makeCookieJar();
  const page = await get("/request-a-book", { jar, ip: addr });
  jar.capture(page);
  const token = tokenOf(await page.text());
  const res = await fetch(`${app.base}/request-a-book`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie: jar.header(), "x-forwarded-for": addr }, body: `title=a%00b&author=x%00&email=nul-${uniq()}%40example.test&_csrf=${token}` });
  assert.ok(res.status < 500, `request-a-book answered ${res.status}`);
  const { rows } = await pool.query("SELECT title FROM book_requests ORDER BY id DESC LIMIT 1");
  if (rows[0]) assert.ok(!rows[0].title.includes("\u0000"));
});

test("pruning removes guest rows that outlive 24 h, never a logged-in row, never a short guest row", async () => {
  const mk = async (sid, sess, interval) => pool.query("INSERT INTO session (sid, sess, expire) VALUES ($1, $2, now() + $3::interval)", [sid, JSON.stringify({ cookie: { originalMaxAge: 1 }, ...sess }), interval]);
  const tag = uniq();
  await mk(`legacy-guest-${tag}`, { csrfToken: "x" }, "29 days");
  await mk(`legacy-null-user-${tag}`, { user: null }, "29 days");
  await mk(`short-guest-${tag}`, { csrfToken: "x" }, "90 minutes");
  await mk(`cart-guest-${tag}`, { cart: [{ copyId: 1 }] }, "23 hours");
  await mk(`user-${tag}`, { user: { id: 1 } }, "29 days");
  const removed = await pruneStaleGuestSessions(pool);
  assert.ok(removed >= 2);
  const left = (await pool.query("SELECT sid FROM session WHERE sid LIKE $1", [`%-${tag}`])).rows.map((r) => r.sid).sort();
  assert.deepEqual(left, [`cart-guest-${tag}`, `short-guest-${tag}`, `user-${tag}`].sort());
});

test("book search: same results with and without the new rules; 1 character is empty; q is capped; descriptions need 3 characters", async () => {
  const tag = `Zq${Date.now().toString(36)}`;
  const mk = async (title, authors, description, categories) => {
    const { rows: [b] } = await pool.query("INSERT INTO books (title, authors, description, categories) VALUES ($1,$2,$3,$4) RETURNING id", [title, authors, description, categories]);
    await pool.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1,'in_stock',5,'very_good')", [b.id]);
    return b.id;
  };
  const byTitle = await mk(`${tag} Moonlight`, "Ann Author", "plain", "Fiction");
  const byAuthor = await mk(`Other ${tag}x`, `${tag} Writer`, "plain", "Fiction");
  const byDesc = await mk("Gamma", "Bee", `a story about ${tag}desc things`, "Fiction");
  const byCat = await mk("Delta", "Cee", "plain", `${tag}cat, Fiction`);
  const addr = ip();
  const search = async (q) => (await (await get(`/api/books/search?q=${encodeURIComponent(q)}`, { ip: addr })).json()).map((b) => b.id);
  assert.deepEqual((await search(tag)).sort((a, b) => a - b), [byTitle, byAuthor, byDesc, byCat].sort((a, b) => a - b));
  assert.deepEqual(await search(`${tag}desc`), [byDesc]);
  assert.deepEqual(await search(`${tag}cat`), [byCat]);
  assert.deepEqual(await search("a"), [], "one character: empty list");
  assert.deepEqual(await search(" a "), [], "trimmed first");
  assert.deepEqual(await search(`${"x".repeat(150)}`), []);
  assert.deepEqual(await search(`${tag} Moonlight ${"y".repeat(200)}`), [], "capped at 100 characters, then nothing matches");
  // ordering unchanged: by title_sort (the leading "The" is ignored)
  const t1 = await mk(`The ${tag}ord Beta`, "A", "p", "x");
  const t2 = await mk(`${tag}ord Alpha`, "A", "p", "x");
  const t3 = await mk(`${tag}ord Gamma`, "A", "p", "x");
  assert.deepEqual(await search(`${tag}ord`), [t2, t1, t3]);
  const res = await get("/api/books/search?q=" + tag, { ip: addr });
  assert.equal(res.headers.get("cache-control"), "public, max-age=60");
  await res.text();
});

test("book search is limited to 60 a minute per IP with a JSON 429; the Books page says so in both languages", async () => {
  const addr = ip();
  const other = ip();
  let ok = 0;
  let limited = 0;
  for (let i = 0; i < 65; i++) {
    const res = await get(`/api/books/search?q=nomatch${i}`, { ip: addr });
    if (res.status === 200) ok += 1;
    if (res.status === 429) {
      limited += 1;
      assert.deepEqual(await res.json(), { error: "rate_limited" });
      assert.equal(res.headers.get("cache-control"), "no-store");
    } else await res.text();
  }
  assert.equal(ok, 60);
  assert.equal(limited, 5);
  assert.equal((await get("/api/books/search?q=nomatch", { ip: other })).status, 200);
  const page = await (await get("/books.html", { ip: other })).text();
  assert.match(page, /Too many searches/);
  assert.match(page, /Trop de recherches/);
});

test("an existing guest session is not rewritten on every request (no per-request write)", async () => {
  const jar = makeCookieJar();
  const addr = ip();
  const first = await get("/login", { jar, ip: addr });
  jar.capture(first);
  await first.text();
  const sid = sidOf(jar);
  const read = async () => (await pool.query("SELECT expire, sess FROM session WHERE sid = $1", [sid])).rows[0];
  await waitFor(async () => (await read()) !== undefined);
  const a = await read();
  for (let i = 0; i < 5; i++) await (await get("/login", { jar, ip: addr })).text();
  const b = await read();
  assert.equal(String(b.expire), String(a.expire), "expiry untouched by repeat visits");
  assert.equal(b.sess.refreshedAt, undefined);
});

test("migration 088 is re-runnable and (when pg_trgm exists) creates the four search indexes", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const sql = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "088_books_search_trigram.sql"), "utf8");
  await pool.query(sql);
  await pool.query(sql);
  const { rows: ext } = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'");
  const { rows: idx } = await pool.query("SELECT indexname FROM pg_indexes WHERE tablename = 'books' AND indexname LIKE 'idx_books_%_trgm'");
  assert.equal(idx.length, ext.length ? 4 : 0);
});
