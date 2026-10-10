// GET /img/<sha256>-w300.jpg (and -w450, -w600): the width variants served by routes/img.js.
// Whitelist, cache headers, no cropping, conditional requests, and names that must not work.
// Port 4931 is reserved for this file.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const sharp = require("sharp");
const { startTestApp } = require("../helpers/testApp");

const PORT = 4931;
let app;
let pool;
let hash;
let pngHash;
let bytes;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const { saveImage, sha256Hex } = require("../../src/lib/imageStore");
  bytes = await sharp(crypto.randomBytes(600 * 900 * 3), { raw: { width: 600, height: 900, channels: 3 } }).jpeg({ quality: 80 }).toBuffer();
  hash = sha256Hex(bytes);
  await saveImage(bytes, "image/jpeg");
  const png = await sharp({ create: { width: 800, height: 400, channels: 3, background: "#336699" } }).png().toBuffer();
  pngHash = sha256Hex(png);
  await saveImage(png, "image/png");
});

after(async () => {
  await pool.query("DELETE FROM images WHERE id = ANY($1)", [[hash, pngHash]]);
  await pool.end();
  app.stop();
});

const get = (p, headers = {}) => fetch(`${app.base}${p}`, { headers, redirect: "manual" });

test("300 and 450 are the same picture scaled by width only (2:3 kept, no crop), a JPEG, cached for a year", async () => {
  for (const w of [300, 450]) {
    const res = await get(`/img/${hash}-w${w}.jpg`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(res.headers.get("etag"), `"${hash}-w${w}"`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("set-cookie"), null, "no session cookie on an image");
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(Number(res.headers.get("content-length")), buf.length);
    const meta = await sharp(buf).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ["jpeg", w, w * 1.5]);
    assert.ok(buf.length < bytes.length, `${w} px is smaller than the original`);
  }
});

test("600 is the stored picture (it is already 600 px wide), under its own validator", async () => {
  const res = await get(`/img/${hash}-w600.jpg`);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  assert.equal(res.headers.get("etag"), `"${hash}-w600"`);
});

test("the plain name still serves the stored bytes unchanged", async () => {
  const res = await get(`/img/${hash}.jpg`);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  assert.equal(res.headers.get("etag"), `"${hash}"`);
});

test("If-None-Match gets a 304 with the cache headers", async () => {
  const res = await get(`/img/${hash}-w300.jpg`, { "if-none-match": `"${hash}-w300"` });
  assert.equal(res.status, 304);
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const other = await get(`/img/${hash}-w300.jpg`, { "if-none-match": `"${hash}-w450"` });
  assert.equal(other.status, 200, "the validator of another width does not match");
});

test("any other width, extension or shape is a plain 404, never a resize", async () => {
  for (const name of [
    `${hash}-w200.jpg`, `${hash}-w301.jpg`, `${hash}-w1200.jpg`, `${hash}-w0.jpg`, `${hash}-w.jpg`, `${hash}-w-300.jpg`, `${hash}-w300.png`,
    `${hash}-w300.webp`, `${hash}-w300.jpg.php`, `${hash}-300.jpg`, `${hash}_w300.jpg`, `${hash.toUpperCase()}-w300.jpg`, `${hash.slice(1)}-w300.jpg`,
    `${hash}-w300.jpg%00.png`, `${hash}-w3e2.jpg`, `${hash}-w+300.jpg`, `%2e%2e%2f${hash}-w300.jpg`, `${hash}-w300%2fx.jpg`,
  ]) {
    const res = await get(`/img/${name}`);
    assert.equal(res.status, 404, name);
    assert.equal(res.headers.get("cache-control") === "public, max-age=31536000, immutable", false, `${name}: an error is not cached forever`);
  }
});

test("the width is not read from the query string, and a query changes nothing", async () => {
  const a = await get(`/img/${hash}.jpg?w=300`);
  assert.equal(a.status, 200);
  assert.deepEqual(Buffer.from(await a.arrayBuffer()), bytes, "?w=300 is ignored: the plain name is always the stored picture");
  const b = await get(`/img/${hash}-w300.jpg?w=9000`);
  const meta = await sharp(Buffer.from(await b.arrayBuffer())).metadata();
  assert.equal(meta.width, 300);
});

test("an unknown image, a non-JPEG and path tricks are 404; the route cannot reach other files or URLs", async () => {
  const none = "0".repeat(64);
  assert.equal((await get(`/img/${none}-w300.jpg`)).status, 404);
  assert.equal((await get(`/img/${pngHash}-w300.jpg`)).status, 404, "a variant of a PNG is not made");
  for (const p of [`/img/..%2f..%2fpackage.json`, `/img/${hash}-w300.jpg/../../x`, `/img/http://127.0.0.1/${hash}-w300.jpg`, `/img/-w300.jpg`, `/img/`, `/img/${hash}-w300.jpg%0d%0aSet-Cookie:x=1`]) {
    const res = await get(p);
    assert.ok([301, 302, 400, 404].includes(res.status) && !res.headers.get("set-cookie"), `${p} -> ${res.status}`);
    assert.notEqual(res.status, 200, p);
  }
});
