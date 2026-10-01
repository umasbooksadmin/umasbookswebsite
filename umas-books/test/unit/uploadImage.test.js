// Upload decoding hardening: a pixel-bomb image is refused by the pixel cap,
// and the vision-scan path re-encodes instead of trusting the client's
// mimetype.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { sharpFromUpload, reencodeForVision, MAX_INPUT_PIXELS } = require("../../src/lib/uploadImage");

async function solidPng(width, height) {
  return sharp({ create: { width, height, channels: 3, background: "#336699" } }).png().toBuffer();
}

test("sharpFromUpload refuses an image over the pixel cap", async () => {
  assert.equal(MAX_INPUT_PIXELS, 40_000_000);
  const bomb = await solidPng(7000, 6000); // 42 MP, tiny on disk
  assert.ok(bomb.length < 1_000_000);
  await assert.rejects(sharpFromUpload(bomb).resize(10, 10).toBuffer(), /pixel limit/i);
  const ok = await solidPng(200, 200);
  assert.ok((await sharpFromUpload(ok).resize(10, 10).toBuffer()).length > 0);
});

test("reencodeForVision always yields a JPEG with a matching type", async () => {
  const png = await solidPng(3000, 2000);
  const { buffer, mimeType } = await reencodeForVision(png);
  assert.equal(mimeType, "image/jpeg");
  const meta = await sharp(buffer).metadata();
  assert.equal(meta.format, "jpeg");
  assert.ok(Math.max(meta.width, meta.height) <= 1568);
});

test("reencodeForVision rejects bytes that are not an image", async () => {
  await assert.rejects(reencodeForVision(Buffer.from("<html>not an image</html>")));
});

test("reencodeForVision enforces the pixel cap", async () => {
  await assert.rejects(reencodeForVision(await solidPng(7000, 6000)), /pixel limit/i);
});
