// Book covers on OUR server.
//
// Open Library / the Internet Archive give us a cover address when a book is
// looked up (lib/bookLookup.js). Showing that address in a page would make every
// visitor's browser call a US operator (their IP address goes with it), would
// shift the page layout while it loads, and would show a broken frame when the
// image is gone. Instead the cover is downloaded ONCE, re-encoded and stored in
// the `images` table (lib/imageStore.js); pages only ever use /img/<hash>.jpg
// (routes/img.js, cached for a year). So:
//
//   books.cover_url         the stored copy ("/img/<sha256>.jpg") or NULL. Never an external URL.
//   books.cover_source_url  where the copy comes from (an allowed external address), kept only to
//                           (re)try the download. Never printed in a page.
//   books.cover_fetch_*     failure counter + last attempt, so a missing cover is not retried
//                           more than 3 times a week.
//
// Fetching is SSRF-safe: https only, no credentials, no port, a short list of host
// names (ALLOWED_HOSTS, also checked on every redirect), the name must resolve to a
// public address, a size and time limit, and a content-type check; the bytes must
// then decode as a real image. The re-encode caps the width at 600 px, drops all
// metadata and always produces a JPEG.
//
//   isAllowedCoverUrl(url)             the host/protocol check alone
//   fetchCoverImage(url, opts)         -> Buffer (the raw bytes), or throws
//   reencodeCover(buffer)              -> Buffer (JPEG, <= 600 px wide, no metadata), or throws
//   localizeCover(url, opts)           -> "/img/<hash>.jpg" (idempotent: same bytes, same hash), or throws
//   prepareCover(url, opts)            -> { cover, source } for the admin save paths, never throws
//   backfillCovers(pool, opts)         one gentle batch for the background job

const dns = require("node:dns");
const net = require("node:net");
const sharp = require("sharp");
const { saveImage, isStoredImageUrl } = require("./imageStore");

const ALLOWED_HOSTS = ["covers.openlibrary.org", "openlibrary.org", "archive.org"]; // plus any *.archive.org
const MAX_BYTES = 3 * 1024 * 1024; // download cap
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 8000;
const MAX_WIDTH = 600;
const MIN_SIDE = 50; // Open Library answers "no cover" with a 1x1 GIF
const MAX_INPUT_PIXELS = 25_000_000;
const OUTPUT_MAX_BYTES = 350 * 1024;
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const ACCEPTED_FORMATS = new Set(["jpeg", "png", "webp", "gif"]);

const BATCH_SIZE = 20;
const MAX_FAILURES = 3; // per week
const RETRY_SPACING = "1 hour";

function hostAllowed(hostname) {
  const h = String(hostname || "").toLowerCase();
  return ALLOWED_HOSTS.includes(h) || h.endsWith(".archive.org");
}

function parseAllowed(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  if (net.isIP(u.hostname) || !hostAllowed(u.hostname)) return null;
  return u;
}

function isAllowedCoverUrl(raw) {
  return parseAllowed(raw) !== null;
}

// True for an address on the public internet (not loopback, private, link-local, ...).
function isPublicAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPublicAddress(mapped[1]);
    if (v === "::" || v === "::1") return false;
    if (/^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff")) return false;
    return true;
  }
  return false;
}

let lookupImpl = (hostname) => dns.promises.lookup(hostname, { all: true });
const defaultLookup = (hostname) => lookupImpl(hostname);
// For tests that run the whole admin flow with a stubbed fetch and no DNS.
function setLookupForTests(fn) { lookupImpl = fn || ((hostname) => dns.promises.lookup(hostname, { all: true })); }

async function assertPublicHost(hostname, lookup) {
  const addrs = await lookup(hostname);
  const list = Array.isArray(addrs) ? addrs : [addrs];
  if (!list.length || !list.every((a) => isPublicAddress(a.address))) throw new Error("cover host does not resolve to a public address");
}

// Reads at most maxBytes from a fetch Response body.
async function readLimited(res, maxBytes) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("cover too large");
  if (!res.body) throw new Error("cover has no body");
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("cover too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// opts: fetchImpl (tests), lookup (tests), timeoutMs, maxBytes.
async function fetchCoverImage(rawUrl, { fetchImpl = fetch, lookup = defaultLookup, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  // One budget for all redirects and the body. A normal (referenced) timer, not
  // AbortSignal.timeout(), whose timer is unref'd: a stalled request must keep the
  // process alive until the abort fires, and the timer is cleared when we are done.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("cover download timed out")), timeoutMs);
  try {
    return await fetchWithin(rawUrl, controller.signal, { fetchImpl, lookup, maxBytes });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithin(rawUrl, deadline, { fetchImpl, lookup, maxBytes }) {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = parseAllowed(current);
    if (!u) throw new Error("cover URL is not allowed");
    await assertPublicHost(u.hostname, lookup);
    const res = await fetchImpl(u.href, {
      redirect: "manual",
      signal: deadline,
      headers: { "User-Agent": "UmasBooksInventory/1.0", Accept: "image/jpeg,image/png,image/webp,image/gif" },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error("cover redirect without a location");
      current = new URL(location, u).href;
      continue;
    }
    if (!res.ok) throw new Error(`cover request failed (${res.status})`);
    const type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!ACCEPTED_TYPES.includes(type)) throw new Error(`cover has an unexpected content type (${type || "none"})`);
    return readLimited(res, maxBytes);
  }
  throw new Error("cover redirected too many times");
}

// Whatever was downloaded must decode as a real image of a sensible size; the
// result is always a JPEG at most 600 px wide with no EXIF/ICC/XMP metadata.
async function reencodeCover(buffer) {
  const input = () => sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
  const meta = await input().metadata();
  if (!ACCEPTED_FORMATS.has(meta.format)) throw new Error("cover is not a supported image");
  if (!meta.width || !meta.height || meta.width < MIN_SIDE || meta.height < MIN_SIDE) throw new Error("cover is a placeholder");
  let out;
  for (const quality of [80, 62, 45]) {
    out = await input()
      .rotate()
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (out.length <= OUTPUT_MAX_BYTES) break;
  }
  if (out.length > MAX_BYTES) throw new Error("cover still too large after re-encoding");
  return out;
}

async function localizeCover(rawUrl, opts = {}) {
  const raw = await fetchCoverImage(rawUrl, opts);
  const jpeg = await reencodeCover(raw);
  return saveImage(jpeg, "image/jpeg", opts.db);
}

// The admin save paths: given whatever cover address they have (a stored /img
// URL, an external address from a lookup, or nothing), returns the pair to write:
//   cover   the /img URL to show, or null
//   source  an allowed external address to retry later (the backfill), or null
// Never throws: a failed download leaves cover null and the backfill tries again.
async function prepareCover(rawUrl, opts = {}) {
  const url = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!url) return { cover: null, source: null };
  if (isStoredImageUrl(url)) return { cover: url, source: null };
  if (!isAllowedCoverUrl(url)) return { cover: null, source: null };
  try {
    return { cover: await localizeCover(url, opts), source: url };
  } catch (err) {
    console.warn("Cover download failed:", err.message);
    return { cover: null, source: url };
  }
}

// A cover address that is safe to print in a page: one on our own origin (a stored
// /img/<hash>.jpg, or any other path starting with a single slash), or nothing.
// A leftover http(s) or protocol-relative address is never printed.
function localCover(value) {
  return typeof value === "string" && /^\/(?!\/)/.test(value) ? value : null;
}

const pause = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// One gentle batch for the background job (src/index.js): books that still lack a
// stored cover and have a source address, books on the shelves first. A book that
// failed is left alone for an hour; after MAX_FAILURES failures it is left alone
// for a week (then it gets a fresh count).
// -> { processed, stored, failed }
async function backfillCovers(pool, { limit = BATCH_SIZE, delayMs = 500, ...fetchOpts } = {}) {
  const { rows } = await pool.query(
    `SELECT b.id, b.cover_source_url
       FROM books b
      WHERE b.cover_url IS NULL
        AND b.cover_source_url IS NOT NULL
        AND (b.cover_fetch_attempted_at IS NULL
             OR (b.cover_fetch_attempted_at < now() - interval '${RETRY_SPACING}'
                 AND (b.cover_fetch_failures < ${MAX_FAILURES} OR b.cover_fetch_attempted_at < now() - interval '7 days')))
      ORDER BY EXISTS (SELECT 1 FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock') DESC,
               b.cover_fetch_attempted_at NULLS FIRST, b.id
      LIMIT $1`,
    [limit]
  );
  let stored = 0, failed = 0;
  for (const [i, book] of rows.entries()) {
    if (!isAllowedCoverUrl(book.cover_source_url)) {
      // Not a host we may fetch from (e.g. a pasted address): never retry it.
      await pool.query("UPDATE books SET cover_source_url = NULL WHERE id = $1 AND cover_url IS NULL", [book.id]);
      continue;
    }
    if (i > 0) await pause(delayMs);
    try {
      const url = await localizeCover(book.cover_source_url, { ...fetchOpts, db: pool });
      // `cover_url IS NULL`: an admin may have set a cover while we were downloading.
      await pool.query(
        `UPDATE books SET cover_url = $1, cover_fetch_failures = 0, cover_fetch_attempted_at = now()
          WHERE id = $2 AND cover_url IS NULL`,
        [url, book.id]
      );
      stored++;
    } catch (err) {
      failed++;
      console.warn(`Cover backfill: book ${book.id} failed: ${err.message}`);
      await pool.query(
        `UPDATE books SET cover_fetch_attempted_at = now(),
                cover_fetch_failures = CASE WHEN cover_fetch_attempted_at IS NULL OR cover_fetch_attempted_at < now() - interval '7 days'
                                            THEN 1 ELSE cover_fetch_failures + 1 END
          WHERE id = $1`,
        [book.id]
      );
    }
  }
  return { processed: rows.length, stored, failed };
}

module.exports = {
  ALLOWED_HOSTS, MAX_BYTES, BATCH_SIZE, MAX_FAILURES,
  isAllowedCoverUrl, isPublicAddress, setLookupForTests, fetchCoverImage, reencodeCover, localizeCover, prepareCover, localCover, backfillCovers,
};
