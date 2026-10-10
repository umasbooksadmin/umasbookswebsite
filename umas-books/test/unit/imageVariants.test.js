// lib/imageVariants.js: width variants of a stored cover. No server; the image store is stubbed with a fake db.
const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { WIDTHS, VARIANT_RE, MAX_CACHE_BYTES, getVariant, variantUrl, coverSrcset, clearVariantCache, cacheStats, setCacheLimitForTests } = require("../../src/lib/imageVariants");

const HASH = "a".repeat(64);
const noisy = async (w, h) => {
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + (i >> 5)) & 255;
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
};
// A db whose images table holds one row.
const fakeDb = (rows) => ({ async query(sql, params) { const r = rows[params[0]]; return { rows: r ? [{ id: params[0], content_type: r.type, data: r.data }] : [] }; } });

test("only 300, 450 and 600 exist", () => {
  assert.deepEqual(WIDTHS, [300, 450, 600]);
  assert.ok(VARIANT_RE.test(`${HASH}-w300.jpg`));
  for (const bad of [`${HASH}-w301.jpg`, `${HASH}-w0.jpg`, `${HASH}-w3000.jpg`, `${HASH}-w300.png`, `${HASH}-w300.jpg.php`, `../${HASH}-w300.jpg`, `${HASH}-w-300.jpg`, `${HASH.slice(1)}-w300.jpg`, `${HASH.toUpperCase()}-w300.jpg`, `${HASH}-w300.jpg/x`])
    assert.equal(VARIANT_RE.test(bad), false, bad);
});

test("variantUrl and coverSrcset only touch our stored JPEG covers", () => {
  assert.equal(variantUrl(`/img/${HASH}.jpg`, 300), `/img/${HASH}-w300.jpg`);
  assert.equal(variantUrl(`/img/${HASH}.jpg`, 301), `/img/${HASH}.jpg`);
  assert.equal(variantUrl("https://covers.openlibrary.org/x.jpg", 300), "https://covers.openlibrary.org/x.jpg");
  assert.equal(variantUrl(null, 300), null);
  assert.equal(coverSrcset(`/img/${HASH}.jpg`), `/img/${HASH}-w300.jpg 300w, /img/${HASH}-w450.jpg 450w, /img/${HASH}.jpg 600w`);
  for (const other of ["", null, undefined, "https://x.example/a.jpg", `/img/${HASH}.png`, "//evil.example/a.jpg", "/img/short.jpg"]) assert.equal(coverSrcset(other), "");
});

test("a variant is the same picture, narrower, never cropped, JPEG, no metadata", async () => {
  clearVariantCache();
  const src = await noisy(600, 900);
  const db = fakeDb({ [HASH]: { type: "image/jpeg", data: src } });
  for (const w of [300, 450]) {
    const v = await getVariant(HASH, w, db);
    assert.equal(v.contentType, "image/jpeg");
    const meta = await sharp(v.data).metadata();
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.width, w);
    assert.equal(meta.height, Math.round(w * 1.5), "2:3 ratio kept: scaled, not cropped");
    assert.ok(!meta.exif && !meta.icc);
    assert.ok(v.data.length < src.length);
  }
  assert.deepEqual((await getVariant(HASH, 600, db)).data, src, "600 of a 600 px original is the stored bytes");
});

test("a narrow original is never enlarged", async () => {
  clearVariantCache();
  const src = await noisy(200, 300);
  const v = await getVariant(HASH, 300, fakeDb({ [HASH]: { type: "image/jpeg", data: src } }));
  assert.deepEqual(v.data, src);
});

test("other widths, other ids, non-JPEGs and missing images give null (nothing is rendered)", async () => {
  clearVariantCache();
  let queries = 0;
  const db = { async query() { queries++; return { rows: [] }; } };
  for (const w of [0, 1, 299, 301, 599, 601, 10000, -300, NaN, "300", null, undefined]) assert.equal(await getVariant(HASH, w, db), null, String(w));
  for (const id of ["../etc/passwd", "x", "", HASH.slice(1), `${HASH}/`, null]) assert.equal(await getVariant(id, 300, db), null, String(id));
  assert.equal(queries, 0, "no database read for an invalid request");
  assert.equal(await getVariant(HASH, 300, db), null);
  const png = await sharp({ create: { width: 800, height: 800, channels: 3, background: "#369" } }).png().toBuffer();
  assert.equal(await getVariant(HASH, 300, fakeDb({ [HASH]: { type: "image/png", data: png } })), null);
});

test("a repeat is served from memory, and the cache stays within its byte limit", async () => {
  clearVariantCache();
  let reads = 0;
  const src = await noisy(600, 900);
  const db = { async query(sql, params) { reads++; return { rows: [{ id: params[0], content_type: "image/jpeg", data: src }] }; } };
  const [a, b] = await Promise.all([getVariant(HASH, 300, db), getVariant(HASH, 300, db)]);
  assert.equal(a, b, "concurrent requests share one resize");
  await getVariant(HASH, 300, db);
  assert.equal(reads, 1);
  const one = (await getVariant(HASH, 300, db)).data.length;
  setCacheLimitForTests(one * 3 + 10);
  try {
    for (let i = 0; i < 12; i++) await getVariant(i.toString(16).padStart(64, "0"), 300, db);
    const { bytes, entries } = cacheStats();
    assert.ok(bytes <= one * 3 + 10, `cache holds ${bytes} bytes`);
    assert.ok(entries >= 1 && entries <= 3, `${entries} entries`);
    const before = reads;
    await getVariant((11).toString(16).padStart(64, "0"), 300, db);
    assert.equal(reads, before, "the newest entry is still cached");
  } finally { setCacheLimitForTests(0); }
  assert.equal(MAX_CACHE_BYTES, 24 * 1024 * 1024);
});
