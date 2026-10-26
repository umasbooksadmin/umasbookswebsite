// lib/coverEdit.js without a server: the crop values a script or a form can send, and what a repeated field does.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { parseCrop, cropCover, rotateCover, coverFromPhoto, loadStoredCover, CoverEditError, COVER_ERRORS, COVER_NOTICES } = require("../../src/lib/coverEdit");

const ok = { x: "0.1", y: "0.2", w: "0.5", h: "0.4" };
const code = (fn) => { try { fn(); } catch (e) { return e instanceof CoverEditError ? e.code : `other:${e.message}`; } return null; };

test("parseCrop accepts plain decimals (strings or numbers) and nothing else", () => {
  assert.deepEqual(parseCrop(ok), { x: 0.1, y: 0.2, w: 0.5, h: 0.4 });
  assert.deepEqual(parseCrop({ x: 0.25, y: 0, w: 0.75, h: 1 }), { x: 0.25, y: 0, w: 0.75, h: 1 });
  assert.deepEqual(parseCrop({ x: ".5", y: "0", w: ".5", h: "1" }), { x: 0.5, y: 0, w: 0.5, h: 1 });
  for (const bad of [
    "-0.1", -0.1, "1.5", 1.5, "NaN", NaN, Infinity, "Infinity", "1e-1", "0x1", "", " ", null, undefined, true, {}, [], ["0.1"], "0,5", "0.1.2", "--1", "+0.5", "٠.٥",
  ]) {
    assert.equal(code(() => parseCrop({ ...ok, x: bad })), "bad-crop", `x = ${JSON.stringify(bad)}`);
  }
  for (const body of [undefined, null, "x=1", 5, []]) assert.equal(code(() => parseCrop(body)), "bad-crop");
});

test("parseCrop clamps a box a hair past the edge, refuses one further out, and refuses a box that is too small", () => {
  assert.deepEqual(parseCrop({ x: "0.5", y: "0", w: "0.5004", h: "1" }), { x: 0.5, y: 0, w: 0.5, h: 1 });
  assert.equal(code(() => parseCrop({ x: "0.5", y: "0", w: "0.51", h: "1" })), "bad-crop");
  assert.equal(code(() => parseCrop({ ...ok, w: "0" })), "crop-small");
  assert.equal(code(() => parseCrop({ ...ok, h: "0.049" })), "crop-small");
  assert.equal(code(() => parseCrop({ x: "0.98", y: "0", w: "0.0205", h: "1" })), "crop-small", "after clamping to the edge");
  assert.deepEqual(parseCrop({ ...ok, w: "0.05" }).w, 0.05);
});

test("every error code has a sentence an admin can read, and the notices exist", () => {
  for (const [c, e] of Object.entries(COVER_ERRORS)) {
    assert.ok(e.status >= 400 && e.status < 600, c);
    assert.match(e.message, /^[A-Z].*[.)]$/, c);
    assert.doesNotMatch(e.message, /undefined|\bErr|stack/i, c);
  }
  for (const n of ["rotated", "cropped", "replaced", "removed", "no-change"]) assert.ok(COVER_NOTICES[n], n);
  assert.equal(new CoverEditError("nonsense").code, "failed");
});

test("rotateCover and cropCover keep the size rules: never enlarged, a long side stays as it was up to 900", async () => {
  const tall = await sharp({ create: { width: 600, height: 900, channels: 3, background: "#468" } }).jpeg().toBuffer();
  const turned = await sharp(await rotateCover(tall, "left")).metadata();
  assert.deepEqual([turned.width, turned.height], [900, 600]);
  const small = await sharp({ create: { width: 100, height: 150, channels: 3, background: "#468" } }).jpeg().toBuffer();
  const cut = await cropCover(small, { x: 0, y: 0, w: 0.5, h: 0.5 });
  assert.equal(cut.changed, true);
  const meta = await sharp(cut.data).metadata();
  assert.deepEqual([meta.width, meta.height], [50, 75]);
  assert.equal((await cropCover(small, { x: 0, y: 0, w: 1, h: 1 })).changed, false);
  await assert.rejects(() => cropCover(small, { x: 0, y: 0, w: 0.2, h: 0.1 }), (e) => e.code === "crop-small", "under 30 px");
  await assert.rejects(() => rotateCover(small, "sideways"), (e) => e.code === "bad-direction");
  await assert.rejects(() => rotateCover(Buffer.from("not an image"), "left"), (e) => e.code === "failed");
});

test("a transparent PNG photo becomes a JPEG on white", async () => {
  const png = await sharp({ create: { width: 120, height: 160, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const out = await coverFromPhoto(png);
  const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0] > 240 && data[1] > 240 && data[2] > 240, "transparent pixels are white");
});

test("loadStoredCover reads only our own stored pictures and never makes a network call", async () => {
  for (const [value, c] of [[null, "no-cover"], ["", "no-cover"], ["https://covers.openlibrary.org/b/id/1-L.jpg", "not-stored"], ["//evil.example/a.jpg", "not-stored"], ["data:image/png;base64,AA", "not-stored"], ["/img/../etc/passwd", "not-stored"]]) {
    await assert.rejects(() => loadStoredCover(value, { query: async () => { throw new Error("must not touch the database"); } }), (e) => e.code === c, String(value));
  }
  await assert.rejects(() => loadStoredCover(`/img/${"a".repeat(64)}.jpg`, { query: async () => ({ rows: [] }) }), (e) => e.code === "not-stored", "a stored-looking address with no image behind it");
});
