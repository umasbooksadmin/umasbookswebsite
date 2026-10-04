// Uploaded images live in the `images` table and are served from a cacheable,
// content-addressed URL (/img/<sha256>.jpg) instead of base64 inside rows.
// End to end against the real app: admin uploads through all four screens,
// the column holds the short URL, the bytes round-trip, caching headers and
// 304s work, junk keys 404, no cookie is ever set, and the public book API
// returns the short URL instead of megabytes of base64.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const sharp = require("sharp");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3590;
const PASSWORD = "Image-Store-Pass1!";
const TAG = `imgstore${Date.now()}`;

let app;
let pool;
let jar;
let sourceJpeg;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));

  // Noisy pixels so the JPEG is realistically big (a flat colour would be tiny).
  const raw = crypto.randomBytes(900 * 1200 * 3);
  sourceJpeg = await sharp(raw, { raw: { width: 900, height: 1200, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();

  const email = `${TAG}@example.test`;
  await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, email_verified_at)
     VALUES ($1, $2, 'Image Admin', TRUE, now())`,
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

after(async () => {
  await pool.end();
  await app.stop();
});

async function upload(path, fields, fileField) {
  const token = await fetchCsrfToken(app.base, jar);
  const form = new FormData();
  form.append("_csrf", token);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append(fileField, new Blob([sourceJpeg], { type: "image/jpeg" }), "photo.jpg");
  const res = await fetch(`${app.base}${path}`, { method: "POST", redirect: "manual", headers: { cookie: jar.header() }, body: form });
  await res.text();
  assert.equal(res.status, 302, `${path} should redirect after saving`);
}

const SHORT_URL = /^\/img\/[0-9a-f]{64}\.jpg$/;

async function assertServedImage(url) {
  assert.match(url, SHORT_URL);
  const hash = url.slice(5, 69);
  const res = await fetch(`${app.base}${url}`);
  assert.equal(res.status, 200);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), hash, "served bytes hash to the URL key");
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(res.headers.get("etag"), `"${hash}"`);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.getSetCookie().length, 0, "image responses must not set cookies");
  const meta = await sharp(bytes).metadata();
  assert.equal(meta.format, "jpeg");
  return { hash, bytes };
}

test("inventory cover upload stores /img/<hash>.jpg, served with immutable caching", async () => {
  const isbn = `97812345${String(Date.now()).slice(-5)}`;
  await upload("/admin/inventory", {
    title: `${TAG} cover book`, isbn, price: "5", condition: "very_good",
    description: "d", descriptionFr: "d", genre: "Fiction",
  }, "coverPhoto");
  const { rows } = await pool.query("SELECT cover_url FROM books WHERE title = $1", [`${TAG} cover book`]);
  assert.equal(rows.length, 1);
  const { hash, bytes } = await assertServedImage(rows[0].cover_url);

  const stored = await pool.query("SELECT data, byte_size, content_type FROM images WHERE id = $1", [hash]);
  assert.equal(stored.rows.length, 1);
  assert.ok(stored.rows[0].data.equals(bytes));
  assert.equal(stored.rows[0].byte_size, bytes.length);

  // Revalidation: the browser already has it -> 304, no body.
  const again = await fetch(`${app.base}${rows[0].cover_url}`, { headers: { "if-none-match": `"${hash}"` } });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get("etag"), `"${hash}"`);
  assert.equal((await again.arrayBuffer()).byteLength, 0);
  const weak = await fetch(`${app.base}${rows[0].cover_url}`, { headers: { "if-none-match": `W/"${hash}"` } });
  assert.equal(weak.status, 304);
  const other = await fetch(`${app.base}${rows[0].cover_url}`, { headers: { "if-none-match": `"${"0".repeat(64)}"` } });
  assert.equal(other.status, 200);
});

test("announcement, blog and charity uploads store short URLs", async () => {
  await upload("/admin/announcements", { title: `${TAG} ann`, body: "<p>hello</p>", statusAction: "publish" }, "image");
  await upload("/admin/blog", { title: `${TAG} post`, body: "<p>hello</p>" }, "image");
  await upload("/admin/charities", { name: `${TAG} charity` }, "image");
  const urls = [
    (await pool.query("SELECT image_url FROM announcements WHERE title = $1", [`${TAG} ann`])).rows[0].image_url,
    (await pool.query("SELECT image_url FROM blog_posts WHERE title = $1", [`${TAG} post`])).rows[0].image_url,
    (await pool.query("SELECT image_url FROM charities WHERE name = $1", [`${TAG} charity`])).rows[0].image_url,
  ];
  for (const url of urls) await assertServedImage(url);
});

test("identical uploads dedupe to one stored image", async () => {
  // The pipeline is deterministic, so re-uploading the same photo reuses the row.
  await upload("/admin/charities", { name: `${TAG} charity again` }, "image");
  const urls = (await pool.query("SELECT image_url FROM charities WHERE name = ANY($1)", [[`${TAG} charity`, `${TAG} charity again`]])).rows;
  assert.equal(urls.length, 2);
  assert.equal(urls[0].image_url, urls[1].image_url);
  const n = (await pool.query("SELECT count(*)::int AS n FROM images WHERE id = $1", [urls[0].image_url.slice(5, 69)])).rows[0].n;
  assert.equal(n, 1);
});

test("bad keys and unknown hashes are 404", async () => {
  const unknown = `/img/${"ab".repeat(32)}.jpg`;
  for (const p of [
    unknown,
    `/img/${"AB".repeat(32)}.jpg`, // uppercase
    `/img/${"ab".repeat(31)}.jpg`, // too short
    `/img/${"ab".repeat(32)}.gif`, // unsupported extension
    `/img/${"ab".repeat(32)}`, // no extension
    "/img/not-a-hash.jpg",
    "/img/..%2f..%2fetc%2fpasswd",
  ]) {
    const res = await fetch(`${app.base}${p}`);
    assert.equal(res.status, 404, p);
    assert.equal(res.headers.getSetCookie().length, 0);
  }
  // A real hash under the wrong extension is also a 404.
  const { rows } = await pool.query("SELECT cover_url FROM books WHERE title = $1", [`${TAG} cover book`]);
  const wrongExt = rows[0].cover_url.replace(/\.jpg$/, ".png");
  assert.equal((await fetch(`${app.base}${wrongExt}`)).status, 404);
});

test("the public book API returns the short URL, not base64", async () => {
  const q = encodeURIComponent(`${TAG} cover book`);
  // Only books with an in-stock copy are listed; the upload above made one.
  const res = await fetch(`${app.base}/api/books/search?q=${q}`);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.length, 1);
  assert.match(body[0].coverUrl, SHORT_URL);
  assert.ok(!text.includes("base64"));
  // Before this change the same response carried the whole image inline.
  const inlineSize = `data:image/jpeg;base64,`.length + Math.ceil((await (await fetch(`${app.base}${body[0].coverUrl}`)).arrayBuffer()).byteLength / 3) * 4;
  assert.ok(text.length < 400 && inlineSize > 20 * text.length, `response ${text.length} B vs ~${inlineSize} B inline`);
  console.log(`# search response: ${text.length} bytes now vs ~${inlineSize} bytes with the cover inline`);

  const arrivals = await (await fetch(`${app.base}/api/books/latest-arrivals?limit=50`)).text();
  assert.ok(!arrivals.includes("base64"));
});
