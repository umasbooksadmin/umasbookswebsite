// Every input, select and textarea on the admin pages has an accessible name (aria-label, a
// <label for>, or a wrapping <label>): a screen reader, and voice control ("tap Search"), find
// a field by its name. A durable scan of the rendered HTML of ~30 admin pages (with enough sample
// data that rows, edit panels and filters appear). A new unlabelled field fails here.
//
// ALLOWED lists the controls that are knowingly left without a name, each with its reason. Keep it empty
// unless there really is no better answer.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");
const { findUnnamedControls } = require("../helpers/accessibleNames");

const PORT = 4961;
const PASSWORD = "Labels-Test-1!";
const ALLOWED = []; // [{ page: "/admin/x", match: /regex of the tag/, why: "reason" }]

let app, pool, jar;
const ids = {};

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const email = `labels-${Date.now()}@example.test`;
  const hash = await bcrypt.hash(PASSWORD, 4);
  const { rows: [admin] } = await pool.query("INSERT INTO users (email, password_hash, display_name, is_admin, is_member, email_verified_at) VALUES ($1,$2,'Labels Admin',true,true,now()) RETURNING id", [email, hash]);
  ids.admin = admin.id;
  const { rows: [other] } = await pool.query("INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1,$2,'Labels Person',now()) RETURNING id", [`p-${email}`, hash]);
  ids.user = other.id;
  const { rows: [book] } = await pool.query("INSERT INTO books (isbn, title, authors, categories, binding) VALUES ('9780141036144','Labels Sample','An Author','Fiction','trade') RETURNING id");
  ids.book = book.id;
  await pool.query("INSERT INTO book_copies (book_id, condition, price, status, location) VALUES ($1,'good',5,'in_stock','Shelf A')", [book.id]);
  const { rows: [ann] } = await pool.query("INSERT INTO announcements (title, body, status, published_at, excerpt) VALUES ('Labels announcement','<p>b</p>','published', now(), 'x') RETURNING id");
  ids.ann = ann.id;
  const { rows: [post] } = await pool.query("INSERT INTO blog_posts (title, body, slug, excerpt, status) VALUES ('Labels post','<p>b</p>','labels-post','x','published') RETURNING id");
  ids.post = post.id;
  const { rows: [round] } = await pool.query("INSERT INTO charity_rounds (title, is_active) VALUES ('Labels vote', TRUE) RETURNING id");
  await pool.query("INSERT INTO charity_options (round_id, name, description) VALUES ($1,'Labels charity','d')", [round.id]);
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString();
  await pool.query("INSERT INTO events (title, description, location, starts_at, ends_at, capacity) VALUES ('Labels event','d','Albi',$1,$2,10)", [day(2), day(2.1)]);
  await pool.query("INSERT INTO classes (title, description, location, starts_at, ends_at, capacity, dropin_price, program_type) VALUES ('Labels class','d','Albi',$1,$2,6,8,'dropin')", [day(2), day(2.1)]);
  await pool.query("INSERT INTO meetings (title, scheduled_at, location, agenda) VALUES ('Labels meeting',$1,'Albi','a')", [day(4)]);
  await pool.query("INSERT INTO volunteer_shifts (role, starts_at, ends_at, capacity) VALUES ('Labels shift',$1,$2,1)", [day(2), day(2.1)]);
  await pool.query("INSERT INTO book_requests (title, email, name, status) VALUES ('Wanted','w@example.test','W P','open')");
  jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header(), "x-forwarded-for": "10.79.4.1" }, body: new URLSearchParams({ email, password: PASSWORD, _csrf: token }).toString() });
  jar.capture(res);
  assert.equal(res.status, 302);
});

after(async () => {
  await pool.end();
  app.stop();
});

const PAGES = () => [
  "/admin", "/admin/inventory", "/admin/inventory?q=Labels", "/admin/inventory/new", "/admin/inventory/scan", "/admin/inventory/move", `/admin/inventory/${ids.book}`,
  "/admin/orders", "/admin/members", `/admin/members?view=${ids.user}&panel=edit`, "/admin/requests", "/admin/sessions", "/admin/events", "/admin/volunteer-shifts", "/admin/meetings",
  "/admin/reports", "/admin/reports/accounting/mapping", "/admin/till", "/admin/till/items", "/admin/till/day",
  "/admin/announcements", `/admin/announcements?edit=${ids.ann}`, "/admin/blog", `/admin/blog?edit=${ids.post}`,
  "/admin/charity", "/admin/charity?tab=library", "/admin/pricing", "/admin/pricing/review", "/admin/audit", "/admin/email-outbox", "/admin/privacy",
];

test("every control on the admin pages has an accessible name", async () => {
  const failures = [];
  let controls = 0;
  for (const p of PAGES()) {
    const res = await fetch(`${app.base}${p}`, { headers: { cookie: jar.header() }, redirect: "manual" });
    assert.equal(res.status, 200, `${p} answered ${res.status}`);
    const html = await res.text();
    controls += (html.match(/<(input|select|textarea)\b/gi) || []).length;
    for (const tag of findUnnamedControls(html)) {
      if (ALLOWED.some((a) => a.page === p && a.match.test(tag))) continue;
      failures.push(`${p}: ${tag}`);
    }
  }
  assert.ok(controls > 300, `the scan looked at ${controls} controls: the sample data should make the pages show their fields`);
  assert.deepEqual(failures, [], "controls without an accessible name (add aria-label or a <label for>)");
});

test("the checker itself: named and unnamed controls", () => {
  assert.equal(findUnnamedControls('<input name="q">').length, 1);
  assert.equal(findUnnamedControls('<input name="q" placeholder="Search">').length, 1, "a placeholder is not a name");
  assert.equal(findUnnamedControls('<input name="q" aria-label="Search">').length, 0);
  assert.equal(findUnnamedControls('<input name="q" aria-label=" ">').length, 1);
  assert.equal(findUnnamedControls('<label for="a">Name</label><input id="a">').length, 0);
  assert.equal(findUnnamedControls('<label for="a"></label><input id="a">').length, 1);
  assert.equal(findUnnamedControls('<label><input type="checkbox"> <span>Mark</span></label>').length, 0);
  assert.equal(findUnnamedControls('<label>Name</label><input name="x">').length, 1, "a label that is only next to the field does not name it");
  assert.equal(findUnnamedControls('<input type="hidden" name="x"><input type="submit"><select><option>a</option></select>').length, 1);
});
