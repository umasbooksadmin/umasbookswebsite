// Smaller copies of a stored image, made on the fly.
//
// A cover is stored once, at most 600 px wide (lib/coverStore.js). A phone shows it in a 150-170 px
// slot, so sending the 600 px file to every grid wastes most of the bytes. The image route
// (routes/img.js) therefore also answers /img/<sha256>-w300.jpg: the same picture scaled to 300, 450 or
// 600 px wide (a 150-170 px slot needs 300 px on a 1.75x screen, 450 px on 2x and 3x phones), same height ratio
// (no cropping), no metadata, always a JPEG.
//
//   WIDTHS            the only widths that exist (300, 450 and 600); anything else is a 404, so nobody can make
//                     the server render arbitrary sizes. 600 returns the stored bytes when the original
//                     is not wider than that, which is every cover.
//   variantUrl(url, w) "/img/<hash>.jpg" -> "/img/<hash>-w<w>.jpg" (anything else comes back unchanged)
//   getVariant(id, w)  -> { data, contentType } or null (no such image / not a JPEG)
//
// No table and no migration: a variant is computed from the stored original the first time it is asked
// for and kept in a small in-memory LRU (MAX_CACHE_BYTES), so a restart only costs a recompute. Browsers and
// any CDN keep it for a year (the URL names the content hash, so the bytes can never change). At most
// MAX_CONCURRENT resizes run at once, and requests for the same variant share one resize.

const sharp = require("sharp");
const { getImage } = require("./imageStore");
const { createInflight } = require("./inflight");

const WIDTHS = [300, 450, 600];
const MAX_CACHE_BYTES = 24 * 1024 * 1024;
let cacheLimit = MAX_CACHE_BYTES; // lowered by tests only
const MAX_CONCURRENT = 2;
const MAX_INPUT_PIXELS = 25_000_000;
const QUALITY = 74;

const VARIANT_RE = /^([0-9a-f]{64})-w(300|450|600)\.jpg$/;
const PLAIN_COVER_RE = /^\/img\/([0-9a-f]{64})\.jpg$/;

// Insertion-ordered Map used as an LRU: a hit is re-inserted at the end, the oldest is dropped first.
const cache = new Map(); // "<id>-<w>" -> { data, contentType }
let cacheBytes = 0;

function remember(key, value) {
  const old = cache.get(key);
  if (old) { cacheBytes -= old.data.length; cache.delete(key); }
  if (value.data.length > cacheLimit) return;
  cache.set(key, value);
  cacheBytes += value.data.length;
  while (cacheBytes > cacheLimit) {
    const oldest = cache.keys().next().value;
    cacheBytes -= cache.get(oldest).data.length;
    cache.delete(oldest);
  }
}

let active = 0;
const waiting = [];
async function withSlot(fn) {
  if (active >= MAX_CONCURRENT) await new Promise((resolve) => waiting.push(resolve));
  active++;
  try { return await fn(); } finally {
    active--;
    const next = waiting.shift();
    if (next) next();
  }
}

const inflight = createInflight(200);

async function build(id, width, db) {
  const image = await getImage(id, db);
  if (!image || image.contentType !== "image/jpeg") return null;
  const meta = await sharp(image.data, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  // Never enlarge, never re-encode when the original already fits.
  if (!meta.width || meta.width <= width) return { data: image.data, contentType: image.contentType };
  const data = await withSlot(() =>
    sharp(image.data, { limitInputPixels: MAX_INPUT_PIXELS })
      .resize({ width, withoutEnlargement: true }) // height follows the ratio: no crop
      .jpeg({ quality: QUALITY, mozjpeg: true })
      .toBuffer()
  );
  return { data, contentType: "image/jpeg" };
}

async function getVariant(id, width, db) {
  if (!/^[0-9a-f]{64}$/.test(id) || !WIDTHS.includes(width)) return null;
  const key = `${id}-${width}`;
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  const made = await inflight.run(key, () => build(id, width, db));
  if (made) remember(key, made);
  return made;
}

// The address of a variant of a stored cover; any other value is returned as it is.
function variantUrl(url, width) {
  const m = typeof url === "string" ? PLAIN_COVER_RE.exec(url) : null;
  return m && WIDTHS.includes(width) ? `/img/${m[1]}-w${width}.jpg` : url;
}

// srcset/sizes attributes for a cover slot. `sizes` is the CSS width the slot is shown at.
// Anything that is not one of our stored covers gets no srcset.
function coverSrcset(url) {
  return PLAIN_COVER_RE.test(url || "") ? `${variantUrl(url, 300)} 300w, ${variantUrl(url, 450)} 450w, ${url} 600w` : "";
}

function setCacheLimitForTests(bytes) { cacheLimit = bytes || MAX_CACHE_BYTES; }
function clearVariantCache() { cache.clear(); cacheBytes = 0; }
function cacheStats() { return { entries: cache.size, bytes: cacheBytes }; }

module.exports = { WIDTHS, VARIANT_RE, MAX_CACHE_BYTES, getVariant, variantUrl, coverSrcset, clearVariantCache, cacheStats, setCacheLimitForTests };
