// The admin multipart forms (blog, announcements, charities, collections, inventory) are parsed by multer into
// memory. Their limits (src/app.js, lib/multiValueFields.js): at most 200 fields and 210 parts, 64 KB per text field,
// 256 KB for the rich-text blog/announcement bodies. A refusal is a friendly 413/400 (or the blog's flash sentence),
// never a 500 + alert; a repeated or bracketed field does not throw in the handler. Port 7860 is reserved.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { Client } = require("pg");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PASSWORD = "MultipartLimits1!Test";
let app, db, jar;

before(async () => {
  app = await startTestApp({ port: 7860, isolated: true });
  db = new Client({ connectionString: app.databaseUrl });
  await db.connect();
  const email = `multipart-${Date.now()}@example.test`;
  await db.query(
    "INSERT INTO users (email, password_hash, display_name, is_admin, email_verified_at) VALUES ($1, $2, 'Admin', true, now())",
    [email, await bcrypt.hash(PASSWORD, 10)]
  );
  jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: new URLSearchParams({ email, password: PASSWORD, _csrf: token }).toString(),
  });
  jar.capture(res);
  assert.equal(res.status, 302);
});
after(async () => { await db.end(); await app.stop(); });

// entries: [name, value] pairs (a name may repeat)
async function post(path, entries) {
  const form = new FormData();
  form.append("_csrf", await fetchCsrfToken(app.base, jar));
  for (const [k, v] of entries) form.append(k, v);
  const res = await fetch(`${app.base}${path}`, { method: "POST", redirect: "manual", headers: { cookie: jar.header() }, body: form });
  jar.capture(res);
  await res.text();
  return res;
}
const postCount = async (title) => (await db.query("SELECT count(*)::int AS n FROM blog_posts WHERE title = $1", [title])).rows[0].n;

test("a legitimately long blog body (200 KB) is still saved", async () => {
  const res = await post("/admin/blog", [["title", "Long legit post"], ["body", `<p>${"word ".repeat(40000)}</p>`], ["status", "published"]]);
  assert.ok([302, 303].includes(res.status), String(res.status));
  assert.equal(await postCount("Long legit post"), 1);
});

test("a blog text field over 256 KB is refused with the blog's own sentence, nothing saved", async () => {
  const res = await post("/admin/blog", [["title", "Too long post"], ["body", "x".repeat(300 * 1024)]]);
  assert.ok([302, 303].includes(res.status), String(res.status));
  assert.equal(await postCount("Too long post"), 0);
  const page = await fetch(`${app.base}${res.headers.get("location")}`, { headers: { cookie: jar.header() } });
  assert.match(await page.text(), /longer than 256 KB/);
});

test("a repeated or bracketed title field does not crash the blog handler", async () => {
  const res = await post("/admin/blog", [["title", "First title"], ["title", "Second title"], ["body", "<p>hi</p>"]]);
  assert.ok(res.status < 500, String(res.status));
  assert.equal(await postCount("First title"), 1);
  const nested = await post("/admin/blog", [["title[a]", "x"], ["excerpt[b][c]", "y"], ["body", "<p>hi</p>"]]);
  assert.ok(nested.status < 500, String(nested.status));
  assert.equal(await postCount("x"), 0);
});

test("too many fields: 400 on announcements and charities, the blog redirects; no 5xx", async () => {
  const many = Array.from({ length: 250 }, (_, i) => [`f${i}`, "v"]);
  const ann = await post("/admin/announcements", [["title", "T"], ...many]);
  assert.equal(ann.status, 400);
  const cha = await post("/admin/charities", [["title", "T"], ...many]);
  assert.equal(cha.status, 400);
  const blog = await post("/admin/blog", [["title", "Many fields"], ...many]);
  assert.ok([302, 303].includes(blog.status), String(blog.status));
  assert.equal(await postCount("Many fields"), 0);
});

test("an oversized text field is 413 on announcements (over 256 KB) and charities (over 64 KB)", async () => {
  const ann = await post("/admin/announcements", [["title", "T"], ["body", "x".repeat(300 * 1024)]]);
  assert.equal(ann.status, 413);
  const cha = await post("/admin/charities", [["title", "T"], ["description", "x".repeat(70 * 1024)]]);
  assert.equal(cha.status, 413);
});

test("collections and inventory refuse an oversized field without a 5xx", async () => {
  const col = await post("/admin/collections", [["name", "x".repeat(70 * 1024)]]);
  assert.ok(col.status < 500, String(col.status));
  const inv = await post("/admin/inventory", [["title", "x".repeat(70 * 1024)]]);
  assert.ok(inv.status < 500 && inv.status >= 400 || [302, 303].includes(inv.status), String(inv.status));
});
