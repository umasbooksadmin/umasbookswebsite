// Pictures an admin uploads for a curated collection (stored like every other admin upload: bytes in the `images` table via
// lib/imageStore.js, so they survive deploys; lib/imageCleanup.js knows the two columns that point at them).
//   icon   the round Browse button: cut to a 240 px square, circular alpha mask, PNG
//   banner an optional wide picture at the top of the collection page: 1600 x 800 JPEG (shown 3:1 on a computer, taller on a phone)
// Both are decoded and re-encoded here (so metadata such as GPS is dropped, the type is what the bytes really are, and a
// pixel bomb is refused: lib/uploadImage.js). Anything that is not a JPEG, PNG or WebP is refused.

const { saveImage } = require("./imageStore");
const { sharpFromUpload } = require("./uploadImage");

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(["jpeg", "png", "webp"]);

class ImageRefused extends Error {}

async function checked(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ImageRefused("empty");
  if (buffer.length > MAX_UPLOAD_BYTES) throw new ImageRefused("too big");
  let meta;
  try { meta = await sharpFromUpload(buffer).metadata(); } catch { throw new ImageRefused("unreadable"); }
  if (!ALLOWED.has(meta.format)) throw new ImageRefused(`type ${meta.format}`);
  return meta;
}

async function processIcon(buffer) {
  await checked(buffer);
  const size = 240;
  const square = await sharpFromUpload(buffer).rotate().resize(size, size, { fit: "cover" }).ensureAlpha().png().toBuffer();
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 1.5}" fill="#fff"/></svg>`);
  const png = await sharpFromUpload(square).composite([{ input: mask, blend: "dest-in" }]).png({ compressionLevel: 9 }).toBuffer();
  return saveImage(png, "image/png");
}

async function processBanner(buffer) {
  await checked(buffer);
  const jpg = await sharpFromUpload(buffer).rotate().resize(1600, 800, { fit: "cover" }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
  return saveImage(jpg, "image/jpeg");
}

module.exports = { processIcon, processBanner, ImageRefused, MAX_UPLOAD_BYTES };
