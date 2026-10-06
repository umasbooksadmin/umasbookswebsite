// lib/coverStore.js: SSRF-safe cover download, re-encode, idempotent storage.
// No network and no database: fetch, DNS and the image store are injected/stubbed.

const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const {
  isAllowedCoverUrl, isPublicAddress, fetchCoverImage, reencodeCover, localCover, MAX_BYTES,
} = require("../../src/lib/coverStore");

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const png = (w, h, extra = {}) => sharp({ create: { width: w, height: h, channels: 3, background: "#336699" }, ...extra }).png().toBuffer();
const reply = (body, { status = 200, type = "image/jpeg", headers = {} } = {}) =>
  new Response(body, { status, headers: { "content-type": type, ...headers } });

test("only https URLs on the known Open Library / Internet Archive hosts are allowed", () => {
  for (const ok of [
    "https://covers.openlibrary.org/b/id/42-L.jpg", "https://openlibrary.org/x.jpg", "https://archive.org/download/a.jpg",
    "https://ia800000.us.archive.org/1/items/a/cover.jpg",
  ]) assert.equal(isAllowedCoverUrl(ok), true, ok);
  for (const bad of [
    "http://covers.openlibrary.org/b/id/42-L.jpg", // not https
    "https://covers.openlibrary.org:8443/x.jpg", // a port
    "https://user:pw@covers.openlibrary.org/x.jpg", // credentials
    "https://evil.example/covers.openlibrary.org/x.jpg", "https://covers.openlibrary.org.evil.example/x.jpg",
    "https://notarchive.org/x.jpg", "https://evilarchive.org/x.jpg",
    "https://127.0.0.1/x.jpg", "https://[::1]/x.jpg", "https://169.254.169.254/latest/meta-data",
    "file:///etc/passwd", "data:image/png;base64,AAAA", "javascript:alert(1)", "", null, undefined, "not a url",
  ]) assert.equal(isAllowedCoverUrl(bad), false, String(bad));
});

test("addresses that are not on the public internet are refused", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:2800:220:1:248:1893:25c8:1946"]) assert.equal(isPublicAddress(ip), true, ip);
});

test("fetch: a host that resolves to a private address is never contacted", async () => {
  let called = 0;
  await assert.rejects(
    fetchCoverImage("https://covers.openlibrary.org/b/id/1-L.jpg", {
      lookup: async () => [{ address: "10.0.0.5", family: 4 }],
      fetchImpl: async () => { called++; return reply("x"); },
    }),
    /public address/
  );
  assert.equal(called, 0);
});

test("fetch: a disallowed URL is refused before any DNS lookup or request", async () => {
  let touched = 0;
  const opts = { lookup: async () => { touched++; return []; }, fetchImpl: async () => { touched++; return reply("x"); } };
  await assert.rejects(fetchCoverImage("https://evil.example/x.jpg", opts), /not allowed/);
  await assert.rejects(fetchCoverImage("http://covers.openlibrary.org/x.jpg", opts), /not allowed/);
  assert.equal(touched, 0);
});

test("fetch: every redirect hop is checked (a redirect off the allowed hosts is refused), at most 3 hops", async () => {
  const seen = [];
  const redirectTo = (loc) => new Response(null, { status: 302, headers: { location: loc } });
  const bytes = await png(100, 150);

  // OK chain: covers.openlibrary.org -> a *.archive.org host, a relative hop in between.
  const ok = await fetchCoverImage("https://covers.openlibrary.org/b/id/9-L.jpg", {
    lookup: publicLookup,
    fetchImpl: async (u, init) => {
      seen.push(u);
      assert.equal(init.redirect, "manual", "redirects are followed by us, never automatically");
      if (u.endsWith("/hop2")) return redirectTo("https://ia800000.us.archive.org/9.jpg");
      if (u.startsWith("https://covers.openlibrary.org")) return redirectTo("/hop2");
      return reply(bytes);
    },
  });
  assert.ok(Buffer.isBuffer(ok) && ok.length === bytes.length);
  assert.equal(seen.length, 3);

  // Redirect to an internal address / another host.
  for (const target of ["http://169.254.169.254/latest/meta-data", "https://evil.example/x.jpg", "https://127.0.0.1/x.jpg"]) {
    await assert.rejects(
      fetchCoverImage("https://covers.openlibrary.org/b/id/1-L.jpg", { lookup: publicLookup, fetchImpl: async () => redirectTo(target) }),
      /not allowed/, target
    );
  }
  // A loop.
  await assert.rejects(
    fetchCoverImage("https://covers.openlibrary.org/b/id/1-L.jpg", { lookup: publicLookup, fetchImpl: async () => redirectTo("https://archive.org/again") }),
    /too many times/
  );
});

test("fetch: content type, status and size limits", async () => {
  const opts = (res) => ({ lookup: publicLookup, fetchImpl: async () => res() });
  const url = "https://covers.openlibrary.org/b/id/1-L.jpg";
  await assert.rejects(fetchCoverImage(url, opts(() => reply("<html>", { type: "text/html" }))), /content type/);
  await assert.rejects(fetchCoverImage(url, opts(() => reply("<svg/>", { type: "image/svg+xml" }))), /content type/);
  await assert.rejects(fetchCoverImage(url, opts(() => reply("", { status: 404 }))), /404/);
  // Declared too big: refused without reading.
  await assert.rejects(fetchCoverImage(url, opts(() => reply("x", { headers: { "content-length": String(MAX_BYTES + 1) } }))), /too large/);
  // Undeclared but too big once streamed.
  await assert.rejects(fetchCoverImage(url, { ...opts(() => reply(Buffer.alloc(2048))), maxBytes: 1024 }), /too large/);
  // Charset suffix on a good type is fine.
  const buf = await fetchCoverImage(url, opts(() => reply(Buffer.from([1, 2, 3]), { type: "image/jpeg; charset=binary" })));
  assert.equal(buf.length, 3);
});

test("fetch: a request that never answers is aborted at the time limit", async () => {
  const started = Date.now();
  await assert.rejects(
    fetchCoverImage("https://covers.openlibrary.org/b/id/1-L.jpg", {
      lookup: publicLookup, timeoutMs: 80,
      fetchImpl: (u, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
    })
  );
  assert.ok(Date.now() - started < 2000);
});

test("re-encode: always a JPEG, at most 600 px wide, never enlarged, metadata removed", async () => {
  const big = await sharp({ create: { width: 1800, height: 2700, channels: 3, background: "#aa3355" } })
    .withMetadata({ exif: { IFD0: { Copyright: "private note" } } }).jpeg().toBuffer();
  const out = await reencodeCover(big);
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, "jpeg");
  assert.equal(meta.width, 600);
  assert.equal(meta.height, 900);
  assert.equal(meta.exif, undefined, "no EXIF survives");
  assert.ok(!out.includes(Buffer.from("private note")));

  const small = await reencodeCover(await png(120, 180));
  const sm = await sharp(small).metadata();
  assert.deepEqual([sm.format, sm.width, sm.height], ["jpeg", 120, 180]);
});

test("re-encode: PNG with transparency is flattened; GIF and WebP are accepted; junk and placeholders are refused", async () => {
  const transparent = await sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const flat = await sharp(await reencodeCover(transparent)).stats();
  assert.ok(flat.channels[0].mean > 250, "transparent pixels become white");
  const webp = await sharp({ create: { width: 90, height: 90, channels: 3, background: "#000" } }).webp().toBuffer();
  assert.equal((await sharp(await reencodeCover(webp)).metadata()).format, "jpeg");
  const gif = await sharp({ create: { width: 90, height: 90, channels: 3, background: "#000" } }).gif().toBuffer();
  assert.equal((await sharp(await reencodeCover(gif)).metadata()).format, "jpeg");

  await assert.rejects(reencodeCover(Buffer.from("not an image at all")));
  await assert.rejects(reencodeCover(await png(1, 1)), /placeholder/, "Open Library's 1x1 'no cover' image");
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200"/></svg>');
  await assert.rejects(reencodeCover(svg), /not a supported image/);
});

test("localCover only passes addresses on our own origin through, never an external one", () => {
  const h = "a".repeat(64);
  assert.equal(localCover(`/img/${h}.jpg`), `/img/${h}.jpg`);
  for (const v of [null, undefined, "", "https://covers.openlibrary.org/b/id/1-L.jpg", "http://x.test/a.jpg", "//evil.test/x.jpg", "data:image/png;base64,AA", "c.png"]) {
    assert.equal(localCover(v), null, String(v));
  }
});
