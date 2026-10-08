// Blog posts while the site is in preview mode (PREVIEW_MODE=true). Preview
// mode switches off reservations and membership payment and shows the
// coming-soon banner; it must NOT get in the way of the admin blog: an admin
// creates (with a featured image), edits, drafts, publishes and deletes posts,
// and visitors see published posts on the public blog feed and pages exactly
// as after launch. Runs the REAL app (real login, real CSRF, real multipart
// upload). Port 4360 is reserved for this file.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const sharp = require("sharp");
const { Client } = require("pg");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PASSWORD = "BlogPreview1!Test";
let app, db, jar;
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

before(async () => {
  app = await startTestApp({ port: 4360, isolated: true, env: { PREVIEW_MODE: "true" } });
  db = new Client({ connectionString: app.databaseUrl });
  await db.connect();
  const email = `blog-preview-${uniq()}@example.test`;
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
  assert.equal(res.status, 302, "admin logs in");
});

after(async () => {
  await db.end();
  await app.stop();
});

const adminGet = (p) => fetch(`${app.base}${p}`, { redirect: "manual", headers: { cookie: jar.header() } });
const postByTitle = async (title) => (await db.query("SELECT * FROM blog_posts WHERE title = $1", [title])).rows[0];

// A browser's multipart form post (the admin form uses enctype=multipart/form-data).
async function adminPost(p, fields, image) {
  const token = await fetchCsrfToken(app.base, jar);
  const form = new FormData();
  form.append("_csrf", token);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (image) form.append("image", new Blob([image], { type: "image/png" }), "photo.png");
  const res = await fetch(`${app.base}${p}`, { method: "POST", redirect: "manual", headers: { cookie: jar.header() }, body: form });
  jar.capture(res);
  return res;
}
const publicFeed = async () => (await (await fetch(`${app.base}/api/blog/posts`)).json());

test("preview mode is really on for this app", async () => {
  const html = await (await fetch(`${app.base}/`)).text();
  assert.ok(html.includes("preview-banner"));
  const admin = await (await adminGet("/admin")).text();
  assert.ok(admin.includes("admin-preview-note"));
});

test("admin blog screen opens in preview mode and says posts are not affected", async () => {
  const res = await adminGet("/admin/blog");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Write a New Post"));
  assert.ok(html.includes("Blog posts are not affected by preview mode"));
});

test("admin creates a published post with an image; it shows to visitors; edit, draft, republish, delete all redirect back (PRG)", async () => {
  const title = `Preview post ${uniq()}`;
  const png = await sharp({ create: { width: 60, height: 40, channels: 3, background: "#369" } }).png().toBuffer();

  let res = await adminPost("/admin/blog", { title, body: "<p>Hello from preview</p>", status: "published", publishDate: "2020-01-02", category: "News" }, png);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/admin/blog");
  const row = await postByTitle(title);
  assert.ok(row, "row created");
  assert.equal(row.status, "published");
  assert.match(row.image_url, /^\/img\//, "image stored and resized");
  const img = await fetch(`${app.base}${row.image_url}`);
  assert.equal(img.status, 200, "uploaded image is served to a visitor");

  // Visitors (no session) see it in the public feed and the blog page loads the feed.
  let feed = await publicFeed();
  const entry = feed.find((p) => p.slug === row.slug);
  assert.ok(entry, "published post is in the public feed");
  assert.equal(entry.image, row.image_url);
  const blogPage = await fetch(`${app.base}/blog.html?post=${row.slug}`);
  assert.equal(blogPage.status, 200);
  const html = await blogPage.text();
  assert.ok(html.includes("assets/blog-live.js"), "the page loads the live feed");
  assert.ok(html.includes("preview-banner"), "preview banner is still shown");

  // Edit.
  res = await adminPost(`/admin/blog/${row.id}`, { title: `${title} edited`, body: "<p>Changed</p>", status: "published", publishDate: "2020-01-02" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/admin/blog");
  assert.equal((await postByTitle(`${title} edited`)).body, "<p>Changed</p>");
  assert.equal((await postByTitle(`${title} edited`)).image_url, row.image_url, "image kept when not replaced");

  // Back to draft: disappears from the public feed.
  await adminPost(`/admin/blog/${row.id}`, { title: `${title} edited`, body: "<p>Changed</p>", status: "draft" });
  assert.ok(!(await publicFeed()).some((p) => p.slug === row.slug), "draft is not public");

  // Bulk publish, then delete.
  res = await adminPost("/admin/blog/bulk", { ids: String(row.id), bulkAction: "publish" });
  assert.equal(res.status, 302);
  assert.ok((await publicFeed()).some((p) => p.slug === row.slug), "published again");
  res = await adminPost(`/admin/blog/${row.id}/delete`, {});
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/admin/blog");
  assert.equal(await postByTitle(`${title} edited`), undefined, "deleted");
  assert.ok(!(await publicFeed()).some((p) => p.slug === row.slug));
});

test("an admin can preview a draft and a scheduled post on the real blog page feed; nobody else can", async () => {
  const u = uniq();
  const mk = async (status, at) => (await db.query(
    "INSERT INTO blog_posts (slug, title, body, status, published_at) VALUES ($1, $2, '<p>x</p>', $3, $4) RETURNING slug",
    [`pv-${status}-${u}`, `Unlisted ${status} ${u}`, status, at]
  )).rows[0].slug;
  const draft = await mk("draft", null);
  const sched = await mk("scheduled", new Date(Date.now() + 5 * 86400000));
  const asAdmin = await (await adminGet("/api/blog/posts?preview=1")).json();
  const d = asAdmin.find((p) => p.slug === draft);
  const sc = asAdmin.find((p) => p.slug === sched);
  assert.ok(d && sc, "admin sees draft and scheduled");
  assert.equal(d.live, false);
  assert.equal(d.status, "draft");
  assert.equal(sc.live, false);
  // Without ?preview=1 the admin gets the public list; an anonymous visitor never gets more.
  assert.ok(!(await (await adminGet("/api/blog/posts")).json()).some((p) => p.slug === draft));
  const anon = await fetch(`${app.base}/api/blog/posts?preview=1`);
  assert.equal(anon.headers.get("cache-control"), "public, max-age=300");
  assert.ok(!(await anon.json()).some((p) => p.slug === draft || p.slug === sched));
  // The admin list offers the preview link for posts that are not public.
  const list = await (await adminGet(`/admin/blog?q=${encodeURIComponent(u)}`)).text();
  assert.ok(list.includes(`/blog.html?post=${draft}&amp;preview=1`) || list.includes(`/blog.html?post=${draft}&preview=1`));
});

test("preview mode still switches off reservations (the blog change loosens nothing else)", async () => {
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/cart/reserve`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: new URLSearchParams({ name: "X", email: "x@example.test", acceptCgv: "on", _csrf: token }).toString(),
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/cart");
});
