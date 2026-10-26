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
// metadata and always produces a JPEG. Smaller copies (300/450 px wide, for phone grids) are made
// from that stored JPEG on request by lib/imageVariants.js; nothing else is stored.
//
//   isAllowedCoverUrl(url)             the host/protocol check alone
//   fetchCoverImage(url, opts)         -> Buffer (the raw bytes), or throws
//   reencodeCover(buffer)              -> Buffer (JPEG, <= 600 px wide, no metadata), or throws
//   localizeCover(url, opts)           -> "/img/<hash>.jpg" (idempotent: same bytes, same hash), or throws
//   prepareCover(url, opts)            -> { cover, source } for the admin save paths, never throws
//   backfillCovers(pool, opts)         one gentle batch for the background job

const dns = require("node:dns");
const config = require("./config");
const { CONTACT_EMAIL } = require("./legal");
const https = require("node:https");
const { Readable } = require("node:stream");
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

// Open Library asks API clients to say who they are and how to reach them.
const USER_AGENT = `UmasBooksInventory/1.0 (+https://umasbooks.org; ${CONTACT_EMAIL})`;

const BATCH_SIZE = 20;
const MAX_CONSECUTIVE_TRANSIENT = 3; // a batch stops after this many network-type errors in a row
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

// Every address range a cover host must never resolve to. A node:net BlockList
// (parsed once) instead of hand-written string tests, so each family is covered
// by prefix: a missed edge case there is how "::ffff:7f00:1" gets past a regex.
const BLOCKED = new net.BlockList();
for (const [net4, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata lives here)
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["198.51.100.0", 24], ["203.0.113.0", 24], // IETF / documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. 255.255.255.255
]) BLOCKED.addSubnet(net4, prefix, "ipv4");
for (const [net6, prefix] of [
  ["::", 96], // unspecified, loopback and the deprecated IPv4-compatible range
  ["64:ff9b::", 96], // NAT64: reaches any IPv4 host through a gateway
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo tunnelling
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4: embeds any IPv4 address
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
]) BLOCKED.addSubnet(net6, prefix, "ipv6");

// True for an address on the public internet (not loopback, private, link-local,
// multicast, reserved, or a tunnel/translation form of any of those).
function isPublicAddress(ip) {
  if (typeof ip !== "string") return false;
  const bare = ip.replace(/^\[|\]$/g, "");
  if (net.isIPv4(bare)) return !BLOCKED.check(bare, "ipv4");
  if (!net.isIPv6(bare)) return false; // includes "fe80::1%eth0" (zone ids)
  // Canonical form (compressed, lowercase, ::ffff:a.b.c.d turned into hex), so
  // the dotted and hex spellings of an IPv4-mapped address are handled alike.
  let canon;
  try { canon = new URL(`http://[${bare}]/`).hostname.slice(1, -1); } catch { return false; }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canon);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return !BLOCKED.check(canon, "ipv6");
}

let lookupImpl = (hostname) => dns.promises.lookup(hostname, { all: true });
const defaultLookup = (hostname) => lookupImpl(hostname);
// For tests that run the whole admin flow with a stubbed fetch and no DNS.
function setLookupForTests(fn) { lookupImpl = fn || ((hostname) => dns.promises.lookup(hostname, { all: true })); }

// Resolves the name ONCE and returns the validated address to connect to. The
// connection below goes to exactly that address, so a DNS answer that changes
// between "check" and "connect" (DNS rebinding) cannot reach an internal host.
async function resolvePublicAddress(hostname, lookup) {
  const addrs = await lookup(hostname);
  const list = Array.isArray(addrs) ? addrs : [addrs];
  if (!list.length || !list.every((a) => isPublicAddress(a.address))) throw new Error("cover host does not resolve to a public address");
  return list[0].address;
}

// fetch() replacement that connects to `init.pinnedAddress` (already validated)
// instead of resolving the name again. The URL, the Host header and the TLS
// server name (SNI + certificate check) stay the real host name. Returns a
// standard Response, redirects are not followed (the caller checks each hop).
function pinnedFetch(href, init = {}) {
  const u = new URL(href);
  return new Promise((resolve, reject) => {
    const req = https.request({
      protocol: "https:",
      host: init.pinnedAddress || u.hostname,
      servername: u.hostname,
      port: 443,
      method: "GET",
      path: u.pathname + u.search,
      headers: { ...(init.headers || {}), Host: u.host },
      signal: init.signal,
    }, (res) => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
      const bodyless = [101, 204, 205, 304].includes(res.statusCode);
      if (bodyless) res.resume();
      resolve(new Response(bodyless ? null : Readable.toWeb(res), { status: res.statusCode, headers }));
    });
    req.on("error", reject);
    req.end();
  });
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
// A failure that says nothing about THIS cover: the other side was down or slow
// or the network broke (5xx, 429, timeout, DNS/connection error). Such a failure
// is not counted as a failed attempt (only a 404, a placeholder or an invalid image
// is), and a run of them stops the batch. See backfillCovers.
function transientError(message, cause) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.transient = true;
  return err;
}
const isTransient = (err) => Boolean(err && err.transient);

// The default transport. Normally pinnedFetch; a test that has replaced
// global.fetch with its own function (the admin tests stub every outside call
// there) keeps getting its stub, so no test can reach the network by accident.
const defaultFetch = (href, init) =>
  /\[native code\]/.test(Function.prototype.toString.call(globalThis.fetch)) ? pinnedFetch(href, init) : globalThis.fetch(href, init);

async function fetchCoverImage(rawUrl, { fetchImpl = defaultFetch, lookup = defaultLookup, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  // One budget for all redirects and the body. A normal (referenced) timer, not
  // AbortSignal.timeout(), whose timer is unref'd: a stalled request must keep the
  // process alive until the abort fires, and the timer is cleared when we are done.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("cover download timed out")), timeoutMs);
  try {
    return await fetchWithin(rawUrl, controller.signal, { fetchImpl, lookup, maxBytes });
  } catch (err) {
    if (!isTransient(err) && controller.signal.aborted) throw transientError("cover download timed out", err);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithin(rawUrl, deadline, { fetchImpl, lookup, maxBytes }) {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = parseAllowed(current);
    if (!u) throw new Error("cover URL is not allowed");
    let pinnedAddress;
    try {
      pinnedAddress = await resolvePublicAddress(u.hostname, lookup);
    } catch (err) {
      // The name did not resolve at all (DNS down): transient. "Resolves to a
      // private address" is a refusal, not a network problem.
      if (/public address/.test(err.message)) throw err;
      throw transientError(`cover host lookup failed (${err.code || err.message})`, err);
    }
    let res;
    try {
      res = await fetchImpl(u.href, {
        pinnedAddress,
        redirect: "manual",
        signal: deadline,
        headers: { "User-Agent": USER_AGENT, Accept: "image/jpeg,image/png,image/webp,image/gif" },
      });
    } catch (err) {
      throw transientError(`cover request failed (${(err.cause && err.cause.code) || err.message})`, err);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error("cover redirect without a location");
      current = new URL(location, u).href;
      continue;
    }
    if (!res.ok) {
      const message = `cover request failed (${res.status})`;
      throw res.status >= 500 || res.status === 429 ? transientError(message) : new Error(message);
    }
    const type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!ACCEPTED_TYPES.includes(type)) throw new Error(`cover has an unexpected content type (${type || "none"})`);
    try {
      return await readLimited(res, maxBytes);
    } catch (err) {
      if (/too large/.test(err.message)) throw err;
      throw transientError(`cover download interrupted (${err.message})`, err);
    }
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
async function prepareCoverNow(rawUrl, opts = {}) {
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

// The same address is asked for twice in a row on the scan page (the lookup shows the
// cover, the save looks again), and a lookup that gave up waiting leaves its download
// running: calls for one address share one download while it runs, and a download that
// worked is remembered for 10 minutes (SCAN_CACHE_TTL_MS, 0 = off). Failures are not
// remembered. Calls with options (tests) are never shared.
const coverMemo = new Map(); // address -> { promise, expires }
const MEMO_MAX = 100;
async function prepareCover(rawUrl, opts = {}) {
  // Unlike the lookup cache (lib/bookLookup.js) this reader never validated the value: NaN or negative just means "no sharing".
  const ttl = config.get("SCAN_CACHE_TTL_MS", process.env, { lenient: true });
  const url = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!url || Object.keys(opts).length || !(ttl > 0) || isStoredImageUrl(url)) return prepareCoverNow(rawUrl, opts);
  const hit = coverMemo.get(url);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const entry = { promise: null, expires: Date.now() + ttl };
  entry.promise = prepareCoverNow(url).then((r) => {
    if (!r.cover) coverMemo.delete(url); // a failure may be tried again at once
    return r;
  });
  coverMemo.delete(url);
  coverMemo.set(url, entry);
  while (coverMemo.size > MEMO_MAX) coverMemo.delete(coverMemo.keys().next().value);
  return entry.promise;
}
function clearCoverMemo() { coverMemo.clear(); }

// A cover address that is safe to print in a page: one on our own origin (a stored
// /img/<hash>.jpg, or any other path starting with a single slash), or nothing.
// A leftover http(s) or protocol-relative address is never printed.
function localCover(value) {
  return typeof value === "string" && /^\/(?!\/)/.test(value) ? value : null;
}

const pause = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// One gentle batch for the background job (src/index.js): books that still lack a
// stored cover and have a source address, books on the shelves first. A book whose
// cover is really bad (404, a placeholder image, not an image) counts a failed
// attempt: left alone for an hour, and after MAX_FAILURES failures for a week
// (then it gets a fresh count). A server error (5xx), a timeout or a network error
// is NOT the book's fault: it is not counted as a failed attempt (the book is just
// retried after an hour), and after MAX_CONSECUTIVE_TRANSIENT of them in a row the
// batch stops so a down Open Library is not hammered. (Migration 059 lesson: a
// run of outages must not permanently mark covers as failed.)
// -> { processed, stored, failed, transient, stopped }
async function backfillCovers(pool, { limit = BATCH_SIZE, delayMs = 500, ...fetchOpts } = {}) {
  const { rows } = await pool.query(
    `SELECT b.id, b.cover_source_url
       FROM books b
      WHERE b.cover_url IS NULL
        AND b.cover_removed_at IS NULL
        AND b.cover_source_url IS NOT NULL
        AND (b.cover_fetch_attempted_at IS NULL
             OR (b.cover_fetch_attempted_at < now() - interval '${RETRY_SPACING}'
                 AND (b.cover_fetch_failures < ${MAX_FAILURES} OR b.cover_fetch_attempted_at < now() - interval '7 days')))
      ORDER BY EXISTS (SELECT 1 FROM book_copies c WHERE c.book_id = b.id AND c.status = 'in_stock') DESC,
               b.cover_fetch_attempted_at NULLS FIRST, b.id
      LIMIT $1`,
    [limit]
  );
  let stored = 0, failed = 0, transient = 0, consecutiveTransient = 0, stopped = false;
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
      consecutiveTransient = 0;
    } catch (err) {
      if (isTransient(err)) {
        transient++;
        consecutiveTransient++;
        console.warn(`Cover backfill: book ${book.id} not fetched (will retry, not counted as a failure): ${err.message}`);
        // Only the timestamp moves (so the same book is not first in line on every tick).
        await pool.query("UPDATE books SET cover_fetch_attempted_at = now() WHERE id = $1", [book.id]);
        if (consecutiveTransient >= MAX_CONSECUTIVE_TRANSIENT) {
          console.warn(`Cover backfill: ${consecutiveTransient} network errors in a row - stopping this batch.`);
          stopped = true;
          break;
        }
        continue;
      }
      consecutiveTransient = 0;
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
  return { processed: rows.length, stored, failed, transient, stopped };
}

module.exports = {
  pinnedFetch,
  ALLOWED_HOSTS, MAX_BYTES, BATCH_SIZE, MAX_FAILURES,
  isAllowedCoverUrl, isPublicAddress, setLookupForTests, fetchCoverImage, reencodeCover, localizeCover, prepareCover, clearCoverMemo, localCover, backfillCovers, USER_AGENT,
};
