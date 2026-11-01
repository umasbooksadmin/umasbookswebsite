// Find a cover candidates inside the scan / Add a book page (routes/admin/inventoryFindCover.js "scan-cover" routes,
// lib/inventoryIntake.js, public/scan-intake.js). Real routers, views and database, in-process; Open Library is a stub and the
// cover download is replaced, so nothing touches the network.
// Rules pinned here: the candidates are only offered (nothing is saved or downloaded by asking for them); a pick is a cover NUMBER
// that the form carries to the save, where it is stored as cover_origin 'chosen' and logged as cover.choose; a typed address, a photo or a
// forged origin is never recorded as a pick.

const { test, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const coverStore = require("../../src/lib/coverStore");
const { adminHarness } = require("../helpers/adminHarness");
const { settled } = require("../../src/lib/afterResponse");
const { isbn13From } = require("../helpers/isbn");

const STORED = `/img/${"c".repeat(64)}.jpg`;
const prepared = [];
mock.method(coverStore, "prepareCover", async (url) => { prepared.push(url); return { cover: STORED, source: url }; });
const thumbAsked = [];
let thumbBytes;
mock.method(coverStore, "fetchCoverImage", async (url) => { thumbAsked.push(url); return thumbBytes; });

const h = adminHarness("scancoverpicks", ["inventoryFindCover", "inventory"], { isolated: true });
const realFetch = global.fetch;
let searches = [];
const ISBN = isbn13From("978033029811");

function searchAnswer(url) {
  const isIsbn = new URL(url).searchParams.has("isbn");
  const doc = { key: "/works/OL1W", title: "Some Title", author_name: ["An Author"], first_publish_year: 1969, cover_i: 111,
    editions: { docs: isIsbn
      ? [{ key: "/books/OL7M", title: "Some Title", cover_i: 222, publisher: ["Picador"], publish_year: [1987], language: ["eng"], isbn: [ISBN] }]
      : [{ key: "/books/OL8M", title: "Some Title", cover_i: 333, publisher: ["Other"], publish_year: [1969], language: ["eng"], isbn: ["9780316290999"] }] } };
  return { docs: [doc] };
}

before(async () => {
  thumbBytes = await sharp({ create: { width: 300, height: 450, channels: 3, background: "#369" } }).jpeg().toBuffer();
  await h.start();
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://openlibrary.org/search.json")) { searches.push(u); return new Response(JSON.stringify(searchAnswer(u)), { status: 200 }); }
    if (u.startsWith("https://openlibrary.org/works/")) { searches.push(u); return new Response(JSON.stringify({ entries: [] }), { status: 200 }); }
    return realFetch(url, init);
  };
});
after(async () => { global.fetch = realFetch; mock.restoreAll(); await settled(); await h.stop(); });
beforeEach(() => { searches = []; prepared.length = 0; thumbAsked.length = 0; require("../../src/lib/coverSearch").searchCache.clear(); });

const as = (user) => (user ? { "x-test-user": JSON.stringify(user) } : {});
const get = (path, user = h.admin) => fetch(`${h.base}${path}`, { redirect: "manual", headers: as(user) });
let seq = 0;
async function save(fields) {
  const body = new URLSearchParams({ title: `Scan pick ${h.uniq()}`, author: "An Author", condition: "very_good", price: "5", location: "Store", source: "donation", binding: "trade", description: "d", fast: "1", ...fields });
  const res = await fetch(`${h.base}/admin/inventory`, { method: "POST", redirect: "manual", headers: { ...as(h.admin), "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body.toString() });
  const json = await res.json();
  await settled();
  return json;
}
const bookRow = async (id) => (await h.q("SELECT * FROM books WHERE id = $1", [id]))[0];
const newIsbn = () => isbn13From(`978${String(7100000 + (++seq)).padStart(9, "0")}`);

test("the scan candidates are the Find a cover candidates: same-ISBN first, at most 8, nothing saved or downloaded", async () => {
  const res = await get(`/admin/inventory/scan-cover/candidates?go=1&isbn=${ISBN}&title=Some%20Title&author=An%20Author`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const j = await res.json();
  assert.equal(j.state, "ok");
  assert.ok(j.candidates.length >= 1 && j.candidates.length <= 8);
  assert.equal(j.candidates[0].coverId, 222);
  assert.equal(j.candidates[0].isbnMatch, true);
  assert.equal(j.candidates[0].publisher, "Picador");
  assert.ok(j.candidates.slice(1).every((c) => c.isbnMatch === false));
  assert.ok(searches.length <= 4 && searches.some((u) => u.includes("isbn=")), "the ISBN search and the title search, bounded");
  assert.deepEqual(prepared, [], "nothing is downloaded or stored by asking");
  assert.equal((await h.q("SELECT count(*)::int AS n FROM books WHERE cover_origin = 'chosen'"))[0].n, 0);
});

test("without go=1 nothing is asked outside (a stray or crafted address costs no request)", async () => {
  const j = await (await get("/admin/inventory/scan-cover/candidates?isbn=" + ISBN + "&title=Some%20Title")).json();
  assert.equal(j.state, "idle");
  assert.deepEqual(searches, []);
});

test("a second ask for the same book is served from the cache (no new request to Open Library)", async () => {
  await get(`/admin/inventory/scan-cover/candidates?go=1&isbn=${ISBN}&title=Some%20Title&author=An%20Author`);
  const n = searches.length;
  await get(`/admin/inventory/scan-cover/candidates?go=1&isbn=${ISBN}&title=Some%20Title&author=An%20Author`);
  assert.equal(searches.length, n);
});

test("Open Library not answering gives a quiet 'error' state, never an error page", async () => {
  const keep = global.fetch;
  global.fetch = async (url, init) => (String(url).includes("openlibrary.org/search.json") ? new Response("down", { status: 503 }) : keep(url, init));
  try {
    const res = await get("/admin/inventory/scan-cover/candidates?go=1&title=Down%20Book");
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.deepEqual({ ok: j.ok, state: j.state, n: j.candidates.length }, { ok: true, state: "error", n: 0 });
  } finally { global.fetch = keep; }
});

test("only an admin may ask, and the small picture comes through the safe download", async () => {
  assert.notEqual((await get("/admin/inventory/scan-cover/candidates?title=X", null)).status, 200);
  assert.notEqual((await get("/admin/inventory/scan-cover/candidates?title=X", h.member)).status, 200);
  const res = await get("/admin/inventory/scan-cover/thumb/222");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(thumbAsked, ["https://covers.openlibrary.org/b/id/222-M.jpg"]);
  assert.equal((await get("/admin/inventory/scan-cover/thumb/abc")).status, 404);
});

test("a cover picked in the preview is saved with the new book: origin 'chosen', the numbered address, logged as cover.choose", async () => {
  const isbn = newIsbn();
  const out = await save({ isbn, chosenCoverId: "222" });
  assert.equal(out.ok, true);
  const b = await bookRow(out.bookId);
  assert.equal(b.cover_origin, "chosen");
  assert.equal(b.cover_source_url, "https://covers.openlibrary.org/b/id/222-L.jpg");
  assert.equal(b.cover_url, STORED);
  const log = await h.q("SELECT action, detail FROM admin_audit_log WHERE action = 'cover.choose' AND target_id = $1", [out.bookId]);
  assert.equal(log.length, 1);
  assert.match(log[0].detail, /Open Library cover 222/);
});

test("with no pick the book is saved as before: no cover.choose, origin not 'chosen'", async () => {
  const out = await save({ isbn: newIsbn(), coverUrl: "https://covers.openlibrary.org/b/isbn/9780330298117-L.jpg?default=false", coverOrigin: "isbn" });
  const b = await bookRow(out.bookId);
  assert.equal(b.cover_origin, "isbn");
  assert.equal((await h.q("SELECT 1 FROM admin_audit_log WHERE action = 'cover.choose' AND target_id = $1", [out.bookId])).length, 0);
});

test("only a plain cover NUMBER counts as a pick: an address, a path or a forged origin is never recorded as 'chosen'", async () => {
  for (const bad of ["https://evil.example/x.jpg", "../../x", "1e9", "0", "1234567890"]) {
    const out = await save({ isbn: newIsbn(), chosenCoverId: bad });
    const b = await bookRow(out.bookId);
    assert.notEqual(b.cover_origin, "chosen", bad);
    assert.equal((await h.q("SELECT 1 FROM admin_audit_log WHERE action = 'cover.choose' AND target_id = $1", [out.bookId])).length, 0, bad);
  }
  const out = await save({ isbn: newIsbn(), coverUrl: "https://covers.openlibrary.org/b/isbn/9780330298117-L.jpg", coverOrigin: "chosen" });
  assert.notEqual((await bookRow(out.bookId)).cover_origin, "chosen", "the origin field alone proves nothing");
});

test("a photo beats a pick: the book is a 'photo' book and nothing is logged as a pick", async () => {
  const intake = require("../../src/lib/inventoryIntake");
  const parsed = intake.parseIntakeInput({ title: "T", chosenCoverId: "222" }, { coverPhoto: [{ buffer: Buffer.from("x") }] });
  assert.equal(parsed.ok, true);
  assert.equal(intake.chosenCoverId(parsed.value), null);
  assert.equal(intake.chosenCoverId(intake.parseIntakeInput({ title: "T", chosenCoverId: "222" }).value), 222);
});

test("a second copy of a book that already has a cover keeps its cover: the pick is neither applied nor logged", async () => {
  const isbn = newIsbn();
  const [{ id }] = await h.q("INSERT INTO books (title, isbn, cover_url, cover_origin) VALUES ('Has cover', $1, '/img/" + "d".repeat(64) + ".jpg', 'photo') RETURNING id", [isbn]);
  await save({ isbn, title: "Has cover", chosenCoverId: "333" });
  const b = await bookRow(id);
  assert.equal(b.cover_origin, "photo");
  assert.equal((await h.q("SELECT 1 FROM admin_audit_log WHERE action = 'cover.choose' AND target_id = $1", [id])).length, 0);
});

test("a second copy of a book with NO cover gets the picked one", async () => {
  const isbn = newIsbn();
  const [{ id }] = await h.q("INSERT INTO books (title, isbn) VALUES ('No cover yet', $1) RETURNING id", [isbn]);
  await save({ isbn, title: "No cover yet", chosenCoverId: "333" });
  const b = await bookRow(id);
  assert.equal(b.cover_origin, "chosen");
  assert.equal(b.cover_url, STORED);
  assert.equal((await h.q("SELECT 1 FROM admin_audit_log WHERE action = 'cover.choose' AND target_id = $1", [id])).length, 1);
});
