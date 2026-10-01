// Tier 3B: admin bulk routes actually run, garbage :id values 404 instead
// of 500, charity website URLs are http(s)-only, forum/charity writes are
// capped and rate-limited, password-change guessing is throttled, and the
// auth limiters no longer share one bucket that successful logins drain.
//
// Isolated database: the charity render check needs the only active round,
// and the limiter tests are per-IP, so every group below uses its own
// X-Forwarded-For address (the app sets `trust proxy`) to get a fresh bucket.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3470;
const PASSWORD = "Tier3b-Test-Pass1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let app;
let pool;

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
let ipCounter = 0;
const newIp = () => `10.70.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

async function createUser(email, { isAdmin = false, isMember = true } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, is_member)
     VALUES ($1, $2, 'Tier3B Test', $3, $4) RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 10), isAdmin, isMember]
  );
  return rows[0].id;
}

async function post(path, fields, { jar = makeCookieJar(), ip = newIp() } = {}) {
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { ...FORM, cookie: jar.header(), "x-forwarded-for": ip },
    body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
  });
  jar.capture(res);
  return res;
}

async function get(path, { jar = makeCookieJar(), ip = newIp() } = {}) {
  const res = await fetch(`${app.base}${path}`, {
    redirect: "manual",
    headers: { cookie: jar.header(), "x-forwarded-for": ip },
  });
  jar.capture(res);
  return res;
}

async function loggedIn(email, ip = newIp()) {
  const jar = makeCookieJar();
  const res = await post("/login", { email, password: PASSWORD }, { jar, ip });
  assert.equal(res.status, 302, "login should have succeeded");
  return jar;
}

async function memberJar() {
  const email = `member-${uniq()}@example.test`;
  const id = await createUser(email);
  return { jar: await loggedIn(email), id, email };
}

async function adminJar() {
  const email = `admin-${uniq()}@example.test`;
  const id = await createUser(email, { isAdmin: true });
  return { jar: await loggedIn(email), id };
}

// ---------- 1. bulk routes ----------

test("admin bulk actions on announcements change rows (not swallowed by /:id)", async () => {
  const { jar, id: adminId } = await adminJar();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const { rows } = await pool.query(
      "INSERT INTO announcements (title, body, status, created_by) VALUES ($1, 'b', 'published', $2) RETURNING id",
      [`Bulk ann ${uniq()}`, adminId]
    );
    ids.push(rows[0].id);
  }
  const token = await fetchCsrfToken(app.base, jar);
  const body = new URLSearchParams();
  body.append("_csrf", token);
  body.append("bulkAction", "archive");
  ids.slice(0, 2).forEach((i) => body.append("ids", String(i)));
  const res2 = await fetch(`${app.base}/admin/announcements/bulk`, {
    method: "POST", redirect: "manual", headers: { ...FORM, cookie: jar.header() }, body: body.toString(),
  });
  assert.equal(res2.status, 302);
  const { rows } = await pool.query("SELECT id, status FROM announcements WHERE id = ANY($1) ORDER BY id", [ids]);
  assert.deepEqual(rows.map((r) => r.status), ["archived", "archived", "published"]);

  const delBody = new URLSearchParams({ _csrf: await fetchCsrfToken(app.base, jar), bulkAction: "delete" });
  delBody.append("ids", String(ids[0]));
  await fetch(`${app.base}/admin/announcements/bulk`, {
    method: "POST", redirect: "manual", headers: { ...FORM, cookie: jar.header() }, body: delBody.toString(),
  });
  const { rows: left } = await pool.query("SELECT id FROM announcements WHERE id = ANY($1)", [ids]);
  assert.equal(left.length, 2);
});

test("admin bulk actions on blog posts change rows (not swallowed by /:id)", async () => {
  const { jar, id: adminId } = await adminJar();
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const { rows } = await pool.query(
      "INSERT INTO blog_posts (slug, title, body, status, created_by) VALUES ($1, 'T', 'b', 'published', $2) RETURNING id",
      [`bulk-${uniq()}`, adminId]
    );
    ids.push(rows[0].id);
  }
  const token = await fetchCsrfToken(app.base, jar);
  const body = new URLSearchParams({ _csrf: token, bulkAction: "draft" });
  ids.forEach((i) => body.append("ids", String(i)));
  const res = await fetch(`${app.base}/admin/blog/bulk`, {
    method: "POST", redirect: "manual", headers: { ...FORM, cookie: jar.header() }, body: body.toString(),
  });
  assert.equal(res.status, 302);
  const { rows } = await pool.query("SELECT status FROM blog_posts WHERE id = ANY($1)", [ids]);
  assert.deepEqual(rows.map((r) => r.status), ["draft", "draft"]);
});

// ---------- 2. garbage ids ----------

test("garbage :id values on public routes are 404s, not 500s", async () => {
  const { jar } = await memberJar();
  for (const path of ["/books/abc", "/books/1x", "/books/99999999999", "/books/-1", "/events/abc/ics", "/forum/abc"]) {
    const res = await get(path, { jar });
    assert.equal(res.status, 404, path);
  }
  for (const path of ["/events/abc/signup", "/books/abc/reserve", "/forum/abc/replies", "/volunteer/abc/signup", "/meetings/abc/rsvp"]) {
    const res = await post(path, { name: "x", email: "x@example.test", body: "hi" }, { jar });
    assert.equal(res.status, 404, path);
  }
  const { jar: adminJ } = await adminJar();
  assert.equal((await post("/admin/blog/abc", { title: "t", body: "b" }, { jar: adminJ })).status, 404);
  assert.equal((await post("/admin/members/abc/toggle-member", {}, { jar: adminJ })).status, 404);
});

test("a well-formed id for a missing thread is a 404 on reply, not a foreign-key 500", async () => {
  const { jar } = await memberJar();
  const res = await post("/forum/987654/replies", { body: "hello" }, { jar });
  assert.equal(res.status, 404);
});

// ---------- 3. charity website_url ----------

test("charity idea website_url keeps only absolute http(s) URLs", async () => {
  const { jar, id } = await memberJar();
  const cases = [
    ["javascript:alert(1)", null],
    ["data:text/html,hi", null],
    ["example.com", null],
    ["https://example.org/x", "https://example.org/x"],
    ["http://example.org", "http://example.org"],
    [`https://example.org/${"a".repeat(400)}`, null],
  ];
  for (const [i, [url, expected]] of cases.entries()) {
    const res = await post("/charity/ideas", { name: `Idea ${i}`, websiteUrl: url }, { jar });
    assert.equal(res.status, 302);
    const { rows } = await pool.query("SELECT website_url FROM charity_ideas WHERE submitted_by = $1 AND name = $2", [id, `Idea ${i}`]);
    assert.equal(rows.length, 1, `idea ${i} should still be saved`);
    assert.equal(rows[0].website_url, expected, JSON.stringify(url));
  }
});

test("admin charity create/update drops non-http(s) website_url", async () => {
  const { jar } = await adminJar();
  const name = `Charity ${uniq()}`;
  await post("/admin/charities", { name, websiteUrl: "javascript:alert(1)" }, { jar });
  const { rows } = await pool.query("SELECT id, website_url FROM charities WHERE name = $1", [name]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].website_url, null);

  await post(`/admin/charities/${rows[0].id}`, { name, websiteUrl: "https://good.example.org" }, { jar });
  assert.equal((await pool.query("SELECT website_url FROM charities WHERE id = $1", [rows[0].id])).rows[0].website_url, "https://good.example.org");
  await post(`/admin/charities/${rows[0].id}`, { name, websiteUrl: "javascript:alert(2)" }, { jar });
  assert.equal((await pool.query("SELECT website_url FROM charities WHERE id = $1", [rows[0].id])).rows[0].website_url, null);
});

test("a stored non-http(s) website_url is not rendered as a link", async () => {
  const { rows: round } = await pool.query(
    "INSERT INTO charity_rounds (title, is_active, visible_to) VALUES ('Render round', TRUE, 'everyone') RETURNING id"
  );
  const { rows: ch } = await pool.query(
    "INSERT INTO charities (name, website_url) VALUES ('Render charity', 'javascript:alert(1337)') RETURNING id"
  );
  await pool.query("INSERT INTO charity_options (round_id, charity_id, name) VALUES ($1, $2, 'Render charity')", [round[0].id, ch[0].id]);
  const { jar } = await memberJar();
  const res = await get("/charity", { jar });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Render charity"));
  assert.ok(!html.includes("alert(1337)"), "javascript: URL must not be rendered");
  await pool.query("UPDATE charity_rounds SET is_active = FALSE WHERE id = $1", [round[0].id]);
});

// ---------- 4. forum / charity idea caps and limits ----------

test("forum thread, reply and charity idea fields are length-capped", async () => {
  const { jar, id } = await memberJar();
  const res = await post("/forum/new", { title: "T".repeat(500), body: "B".repeat(9000) }, { jar });
  assert.equal(res.status, 302);
  const { rows } = await pool.query("SELECT id, title, body FROM forum_threads WHERE author_id = $1", [id]);
  assert.equal(rows[0].title.length, 200);
  assert.equal(rows[0].body.length, 5000);

  await post(`/forum/${rows[0].id}/replies`, { body: "R".repeat(9000) }, { jar });
  const { rows: replies } = await pool.query("SELECT body FROM forum_replies WHERE thread_id = $1", [rows[0].id]);
  assert.equal(replies[0].body.length, 5000);

  await post("/charity/ideas", { name: "N".repeat(500), description: "D".repeat(5000) }, { jar });
  const { rows: ideas } = await pool.query("SELECT name, description FROM charity_ideas WHERE submitted_by = $1 AND name LIKE 'NNN%'", [id]);
  assert.equal(ideas[0].name.length, 150);
  assert.equal(ideas[0].description.length, 1000);
});

async function statusesUntil429(path, fields, jar, ip, attempts) {
  const statuses = [];
  for (let i = 0; i < attempts; i++) {
    statuses.push((await post(path, fields(i), { jar, ip })).status);
  }
  return statuses;
}

test("forum thread creation is rate limited per IP", async () => {
  const { jar } = await memberJar();
  const statuses = await statusesUntil429("/forum/new", (i) => ({ title: `t${i}`, body: "b" }), jar, newIp(), 13);
  assert.ok(statuses.slice(0, 10).every((s) => s === 302), `first 10 should pass: ${statuses}`);
  assert.ok(statuses.includes(429), `expected a 429, got ${statuses}`);
});

test("forum replies are rate limited per IP", async () => {
  const { jar, id } = await memberJar();
  const { rows } = await pool.query("INSERT INTO forum_threads (title, body, author_id) VALUES ('t', 'b', $1) RETURNING id", [id]);
  const statuses = await statusesUntil429(`/forum/${rows[0].id}/replies`, (i) => ({ body: `r${i}` }), jar, newIp(), 33);
  assert.ok(statuses.slice(0, 30).every((s) => s === 302), `first 30 should pass: ${statuses}`);
  assert.ok(statuses.includes(429), "expected a 429");
});

test("charity idea submission is rate limited per IP", async () => {
  const { jar } = await memberJar();
  const statuses = await statusesUntil429("/charity/ideas", (i) => ({ name: `idea ${i}` }), jar, newIp(), 13);
  assert.ok(statuses.slice(0, 10).every((s) => s === 302), `first 10 should pass: ${statuses}`);
  assert.ok(statuses.includes(429), `expected a 429, got ${statuses}`);
});

// ---------- 4b. password change throttle ----------

test("wrong current-password attempts on /account/password are throttled per account", async () => {
  const { jar } = await memberJar();
  const ip = newIp();
  const statuses = [];
  for (let i = 0; i < 7; i++) {
    statuses.push((await post("/account/password", { currentPassword: "nope-nope-1", newPassword: "Another-Good-Pass2!" }, { jar, ip })).status);
  }
  assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.equal(statuses[5], 429);
  // The correct password no longer gets a guess either while throttled.
  const right = await post("/account/password", { currentPassword: PASSWORD, newPassword: "Another-Good-Pass2!" }, { jar, ip });
  assert.equal(right.status, 429);

  // Another account (even from the same IP) is unaffected.
  const other = await memberJar();
  const ok = await post("/account/password", { currentPassword: PASSWORD, newPassword: "Another-Good-Pass2!" }, { jar: other.jar, ip });
  assert.equal(ok.status, 200);
});

// ---------- 5. separate auth buckets ----------

test("successful logins do not exhaust the login bucket", async () => {
  const email = `shared-nat-${uniq()}@example.test`;
  await createUser(email);
  const ip = newIp();
  // The old shared limiter counted successes: the 21st request from one IP got a 429.
  for (let i = 0; i < 24; i++) {
    const res = await post("/login", { email, password: PASSWORD }, { ip });
    assert.equal(res.status, 302, `login #${i + 1} should succeed`);
  }
});

test("repeated login failures from one IP are still limited, without touching signup/forgot buckets", async () => {
  const ip = newIp();
  const statuses = [];
  for (let i = 0; i < 23; i++) {
    statuses.push((await post("/login", { email: `ghost-${uniq()}@example.test`, password: "Wrong-Password-1" }, { ip })).status);
  }
  assert.ok(statuses.slice(0, 20).every((s) => s === 401), `first 20 should be plain failures: ${statuses}`);
  assert.equal(statuses[20], 429);

  // Same IP, other flows: their own buckets, still open.
  const forgot = await post("/forgot-password", { email: "nobody@example.test" }, { ip });
  assert.equal(forgot.status, 200);
  const signup = await post("/signup", { email: `s-${uniq()}@example.test`, password: "Correct-Horse-1", displayName: "S" }, { ip });
  assert.equal(signup.status, 200);
});

test("forgot-password is still limited per IP", async () => {
  const ip = newIp();
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    statuses.push((await post("/forgot-password", { email: `f-${uniq()}@example.test` }, { ip })).status);
  }
  assert.ok(statuses.slice(0, 10).every((s) => s === 200), `first 10 should pass: ${statuses}`);
  assert.ok(statuses.includes(429), `expected a 429, got ${statuses}`);
});
