const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { prepareDatabase } = require("../helpers/inProcessApp");

const database = prepareDatabase("imagestore", { isolated: true });
let store;
let pool;

before(() => {
  database.create();
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  store = require("../../src/lib/imageStore");
});

after(async () => {
  await pool.end();
  database.drop();
});

const bytes = (tag) => Buffer.from(`${tag}-${Date.now()}-${Math.random()}`);

test("saveImage returns /img/<sha256>.jpg and stores the bytes", async () => {
  const buf = bytes("a");
  const url = await store.saveImage(buf);
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  assert.equal(url, `/img/${hash}.jpg`);
  assert.ok(store.isStoredImageUrl(url));
  const got = await store.getImage(hash);
  assert.equal(got.contentType, "image/jpeg");
  assert.ok(got.data.equals(buf));
});

test("identical bytes dedupe to one row; different bytes do not", async () => {
  const buf = bytes("dup");
  const u1 = await store.saveImage(buf);
  const u2 = await store.saveImage(Buffer.from(buf));
  assert.equal(u1, u2);
  const hash = u1.slice(5, 69);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM images WHERE id = $1", [hash])).rows[0].n, 1);
  assert.notEqual(await store.saveImage(bytes("other")), u1);
});

test("png and webp get their own extension; other types are refused", async () => {
  assert.match(await store.saveImage(bytes("p"), "image/png"), /^\/img\/[0-9a-f]{64}\.png$/);
  assert.match(await store.saveImage(bytes("w"), "image/webp"), /^\/img\/[0-9a-f]{64}\.webp$/);
  await assert.rejects(store.saveImage(bytes("g"), "image/gif"));
  await assert.rejects(store.saveImage(Buffer.alloc(0)));
});

test("isStoredImageUrl only accepts our own URLs", () => {
  const h = "a".repeat(64);
  assert.ok(store.isStoredImageUrl(`/img/${h}.webp`));
  for (const v of [null, "", "https://covers.openlibrary.org/b/id/1-L.jpg", "data:image/jpeg;base64,AAAA", `/img/${h}.gif`, `/img/${"A".repeat(64)}.jpg`, `//evil.test/img/${h}.jpg`]) {
    assert.ok(!store.isStoredImageUrl(v), String(v));
  }
});

test("getImage returns null for unknown or malformed ids", async () => {
  assert.equal(await store.getImage("0".repeat(64)), null);
  assert.equal(await store.getImage("nope"), null);
});
