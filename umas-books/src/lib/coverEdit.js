// Editing a book's cover picture in the admin: replace it with a new photo, rotate it, crop it, remove it
// (routes/admin/inventoryCover.js). This file is the image work and the wording; it knows no request.
//
// One pipeline for every edit, the same rules as the other cover paths (lib/uploadImage.js, lib/coverStore.js):
//   - a decoded upload is capped at 40 megapixels (sharpFromUpload) and must be a JPEG, PNG or WebP (GIF, SVG, HEIC,
//     "a web page called .jpg" are refused: the type is read from the bytes, never from the file name or the browser);
//   - a phone photo is stood upright from its EXIF orientation first (`.rotate()` with no angle), then ALL metadata is
//     dropped (sharp keeps none unless asked), a transparent PNG goes onto white, and the result is always a JPEG;
//   - the picture is never enlarged and never longer than MAX_SIDE on its longest side (a 600 x 900 cover turned on its
//     side is 900 x 600 and must not be shrunk by a rotation);
//   - the bytes are stored by lib/imageStore.js (SHA-256 id, `images` table) and the caller writes the new /img/<id>.jpg
//     address in books.cover_url. Every edit makes a NEW image: the old one stays until lib/imageCleanup.js finds nothing
//     refers to it and it is older than the grace period (an image saved just now is never removed, saveImage refreshes
//     created_at even when identical bytes are saved again). Nothing here deletes a row.
//
//   rotateCover(buffer, "left"|"right")  -> Buffer (JPEG)
//   parseCrop(body)                      -> { x, y, w, h } as fractions of the CURRENT picture, or throws CoverEditError
//   cropCover(buffer, crop)              -> { data: Buffer, changed: boolean } (changed false when the box is the whole picture)
//   coverFromPhoto(buffer)               -> Buffer (JPEG), or throws CoverEditError
//   loadStoredCover(coverUrl, db)        -> Buffer of the stored picture, or throws CoverEditError("no-cover" | "not-stored")

const { sharpFromUpload, MAX_INPUT_PIXELS } = require("./uploadImage");
const { getImage, isStoredImageUrl, FILE_RE } = require("./imageStore");

const MAX_SIDE = 900;
const MIN_SIDE = 50; // a photo smaller than this is not a cover (Open Library's "no cover" placeholder is 1 px)
const MIN_CROP_FRACTION = 0.05; // the selection is at least 5% of the picture in each direction ...
const MIN_CROP_PIXELS = 30; // ... and at least this many pixels
const QUALITIES = [85, 75, 62, 50];
const SOFT_MAX_BYTES = 400 * 1024;
const HARD_MAX_BYTES = 1024 * 1024;
const ACCEPTED_FORMATS = new Set(["jpeg", "png", "webp"]);
const UPLOAD_LIMIT_MB = 8; // multer's limit in src/app.js

// What an admin reads. `status` is the HTTP status a script (Accept: application/json) gets; a page gets a redirect back to
// the book with the same sentence under the Cover card.
const COVER_ERRORS = {
  "bad-direction": { status: 400, message: "Choose Rotate left or Rotate right. Nothing was changed." },
  "bad-crop": { status: 400, message: "Those crop values are not valid, so nothing was changed. Drag the box again and press Apply crop." },
  "crop-small": { status: 400, message: "The selected area is too small. Make it bigger and try again. Nothing was changed." },
  "no-file": { status: 400, message: "Choose or take a photo first. Nothing was changed." },
  "not-image": { status: 400, message: "That file is not a picture we can use. Please choose a JPEG, PNG or WebP photo. Nothing was changed." },
  "image-small": { status: 400, message: "That picture is too small to be a cover. Please choose a bigger photo. Nothing was changed." },
  "too-many-pixels": { status: 400, message: "That photo is too large (over 40 megapixels). Please choose a smaller one. Nothing was changed." },
  "too-big": { status: 413, message: `That photo is larger than ${UPLOAD_LIMIT_MB} MB. Please choose a smaller one. Nothing was changed.` },
  "no-cover": { status: 409, message: "This book has no cover to change. Use Add cover photo first." },
  "not-stored": { status: 409, message: "This cover is an old web address that is not saved on our server, so it cannot be rotated or cropped. Use Replace cover photo, or Remove cover." },
  changed: { status: 409, message: "The cover was changed a moment ago, so nothing was done. Check the picture below and try again." },
  busy: { status: 429, message: "Too many cover changes in a short time. Please wait a minute and try again. Nothing was changed." },
  failed: { status: 500, message: "The picture could not be processed. Nothing was changed. Please try again or choose another photo." },
};
const COVER_NOTICES = {
  rotated: "Cover rotated.",
  cropped: "Cover cropped.",
  replaced: "Cover photo replaced.",
  removed: "Cover removed. The book now shows “No cover”.",
  "no-change": "The selection was the whole picture, so nothing was changed.",
};

class CoverEditError extends Error {
  constructor(code) {
    super((COVER_ERRORS[code] || COVER_ERRORS.failed).message);
    this.name = "CoverEditError";
    this.code = COVER_ERRORS[code] ? code : "failed";
  }
}

// Last stage of every edit: a JPEG small enough to store.
async function encodeJpeg(pipeline) {
  const flat = pipeline.flatten({ background: "#ffffff" });
  let out;
  for (const quality of QUALITIES) {
    out = await flat.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
    if (out.length <= SOFT_MAX_BYTES) break;
  }
  if (out.length > HARD_MAX_BYTES) throw new CoverEditError("failed");
  return out;
}

const fitInside = (pipeline) => pipeline.resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true });

// A picture that still carries an EXIF orientation is stood upright once, so every later step works on the pixels as seen.
async function upright(buffer) {
  const meta = await sharpFromUpload(buffer).metadata();
  if (meta.orientation && meta.orientation > 1) return sharpFromUpload(buffer).rotate().toBuffer();
  return buffer;
}

function asProcessingError(err) {
  if (err instanceof CoverEditError) return err;
  if (/pixel limit|exceeds/i.test(String((err && err.message) || ""))) return new CoverEditError("too-many-pixels");
  return new CoverEditError("failed");
}

async function rotateCover(buffer, direction) {
  if (direction !== "left" && direction !== "right") throw new CoverEditError("bad-direction");
  try {
    const base = await upright(buffer);
    return await encodeJpeg(fitInside(sharpFromUpload(base).rotate(direction === "left" ? 270 : 90)));
  } catch (err) {
    throw asProcessingError(err);
  }
}

// x, y, w, h arrive from a form (strings) or a script (JSON numbers). Only plain decimal numbers count: "NaN", "1e2", "",
// arrays, objects and booleans are all refused, so nothing odd ever reaches the arithmetic below.
const DECIMAL = /^(?:\d(?:\.\d{1,17})?|\.\d{1,17})$/;
function fraction(value) {
  if (typeof value === "number") value = Number.isFinite(value) ? String(value) : "";
  if (typeof value !== "string") throw new CoverEditError("bad-crop");
  const t = value.trim();
  const n = DECIMAL.test(t) ? Number(t) : NaN;
  if (!(n >= 0 && n <= 1)) throw new CoverEditError("bad-crop");
  return n;
}

// Each value must be between 0 and 1. A box that runs a hair past the edge (a rounding error of the page script) is pulled
// back to the edge; one that runs further is refused rather than guessed at.
function parseCrop(body) {
  const b = body && typeof body === "object" ? body : {};
  const x = fraction(b.x);
  const y = fraction(b.y);
  let w = fraction(b.w);
  let h = fraction(b.h);
  const slack = 0.001;
  if (x + w > 1 + slack || y + h > 1 + slack) throw new CoverEditError("bad-crop");
  w = Math.min(w, 1 - x);
  h = Math.min(h, 1 - y);
  if (w < MIN_CROP_FRACTION || h < MIN_CROP_FRACTION) throw new CoverEditError("crop-small");
  return { x, y, w, h };
}

async function cropCover(buffer, crop) {
  try {
    const base = await upright(buffer);
    const meta = await sharpFromUpload(base).metadata();
    const W = meta.width;
    const H = meta.height;
    const left = Math.min(Math.round(crop.x * W), W - 1);
    const top = Math.min(Math.round(crop.y * H), H - 1);
    const width = Math.max(1, Math.min(Math.round(crop.w * W), W - left));
    const height = Math.max(1, Math.min(Math.round(crop.h * H), H - top));
    if (width < MIN_CROP_PIXELS || height < MIN_CROP_PIXELS) throw new CoverEditError("crop-small");
    if (width === W && height === H) return { data: buffer, changed: false };
    const data = await encodeJpeg(fitInside(sharpFromUpload(base).extract({ left, top, width, height })));
    return { data, changed: true };
  } catch (err) {
    throw asProcessingError(err);
  }
}

// A new photo from the camera or the files (multer's buffer). Throws a CoverEditError the admin can read.
async function coverFromPhoto(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new CoverEditError("no-file");
  let meta;
  try {
    meta = await sharpFromUpload(buffer).metadata();
  } catch (err) {
    throw /pixel limit|exceeds/i.test(String(err && err.message)) ? new CoverEditError("too-many-pixels") : new CoverEditError("not-image");
  }
  if (!ACCEPTED_FORMATS.has(meta.format)) throw new CoverEditError("not-image");
  if (meta.width * meta.height > MAX_INPUT_PIXELS) throw new CoverEditError("too-many-pixels");
  const oriented = meta.orientation && meta.orientation >= 5 ? [meta.height, meta.width] : [meta.width, meta.height];
  if (Math.min(...oriented) < MIN_SIDE) throw new CoverEditError("image-small");
  try {
    return await encodeJpeg(fitInside(sharpFromUpload(buffer).rotate()));
  } catch (err) {
    // A damaged file (cut off, garbage after a valid header) is "not a picture"; only a real limit gets its own words.
    const e = asProcessingError(err);
    throw e.code === "failed" ? new CoverEditError("not-image") : e;
  }
}

// The bytes behind books.cover_url. A cover that is not one of OUR stored pictures (an old http(s) address, a data: URI,
// anything else) is REFUSED, never fetched here: the editor makes no network call, so there is nothing to forge a request
// with. The Replace button takes a new photo for such a book; lib/coverStore.js and the background job still import the
// allowed Open Library addresses the safe way.
async function loadStoredCover(coverUrl, db) {
  if (!coverUrl) throw new CoverEditError("no-cover");
  if (!isStoredImageUrl(coverUrl)) throw new CoverEditError("not-stored");
  const id = FILE_RE.exec(coverUrl.slice("/img/".length))[1];
  const image = await getImage(id, db);
  if (!image) throw new CoverEditError("not-stored");
  return image.data;
}

module.exports = {
  CoverEditError, COVER_ERRORS, COVER_NOTICES, MAX_SIDE, MIN_CROP_FRACTION, UPLOAD_LIMIT_MB,
  rotateCover, parseCrop, cropCover, coverFromPhoto, loadStoredCover,
};
