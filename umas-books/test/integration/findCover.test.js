// "Find a cover" (routes/admin/inventoryFindCover.js, lib/coverSearch.js) and the "Books without a cover" list of Admin > Reports >
// Covers to check. Real routers and views, in-process. Open Library is a stub: global.fetch answers search.json (and passes
// the test's own requests through), and the download of a picked cover is replaced in lib/coverStore.js, so no test touches the network.
// A candidate is never applied by itself; a pick sends only a cover number, the address is built on the server.

const { test, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const coverStore = require("../../src/lib/coverStore");
const { adminHarness } = require("../helpers/adminHarness");

const asked = [];
let thumbBytes;
const STORED = `/img/${"b".repeat(64)}.jpg`;
let downloadFails = false;
mock.method(coverStore, "localizeCover", async (url) => {
  asked.push(url);
  if (downloadFails) throw new Error("download failed");
  return STORED;
});
mock.method(coverStore, "fetchCoverImage", async (url) => { asked.push(url); return thumbBytes; });

const h = adminHarness("findcover", ["inventoryFindCover", "coverReview"], { isolated: true });
const realFetch = global.fetch;
const ISBN = "9780330298117";
let searches = [];

const EDITIONS = { entries: [
  { key: "/books/OL20M", title: "French Lieutenant's Woman", covers: [444], publishers: ["Vintage"], publish_date: "2004-05-01", isbn_13: ["9780099478331"], languages: [{ key: "/languages/eng" }] },
  { key: "/books/OL21M", title: "French Lieutenant's Woman", covers: [-1], publishers: ["No picture"], publish_date: "1999" },
  { key: "/books/OL22M", title: "La maitresse du lieutenant francais", covers: [555], publishers: ["Albin Michel"], publish_date: "1970", isbn_10: ["0330298119"], languages: [{ key: "/languages/fre" }] },
] };
function searchAnswer(url) {
  const u = new URL(url);
  const isIsbnSearch = u.searchParams.has("isbn");
  const exact = { key: "/works/OL1W", title: "The French Lieutenant's Woman", author_name: ["John Fowles"], first_publish_year: 1969, cover_i: 111,
    editions: { docs: [{ key: "/books/OL7M", title: "The French Lieutenant's Woman", cover_i: 222, publisher: ["Picador"], publish_year: [1987], language: ["eng"], isbn: ["0330298119", ISBN] }] } };
  const other = { key: "/works/OL1W", title: "The French Lieutenant's Woman", author_name: ["John Fowles"], first_publish_year: 1969, cover_i: 111,
    editions: { docs: [
      { key: "/books/OL8M", title: "French Lieutenant's Woman", cover_i: 333, publisher: ["Little, Brown"], publish_year: [1969], language: ["eng"], isbn: ["9780316290999"] },
      { key: "/books/OL9M", title: "No cover edition", publisher: ["X"], publish_year: [2000], isbn: [] },
    ] } };
  return { docs: [isIsbnSearch ? exact : other] };
}

before(async () => {
  thumbBytes = await sharp({ create: { width: 300, height: 450, channels: 3, background: "#369" } }).jpeg().toBuffer();
  await h.start();
  global.fetch = async (url, init) => {
    if (String(url).startsWith("https://openlibrary.org/search.json")) {
      searches.push(String(url));
      return new Response(JSON.stringify(searchAnswer(String(url))), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).startsWith("https://openlibrary.org/works/")) {
      searches.push(String(url));
      return new Response(JSON.stringify(EDITIONS), { status: 200, headers: { "content-type": "application/json" } });
    }
    return realFetch(url, init);
  };
});
after(async () => { global.fetch = realFetch; mock.restoreAll(); await h.stop(); });
beforeEach(() => { asked.length = 0; downloadFails = false; searches = []; require("../../src/lib/coverSearch").searchCache.clear(); });

async function book({ title = `FC ${h.uniq()}`, isbn = null, cover = null, removed = false, inStock = 0, sold = 0 } = {}) {
  const [{ id }] = await h.q("INSERT INTO books (title, authors, isbn, cover_url, cover_removed_at) VALUES ($1, 'John Fowles', $2, $3, $4) RETURNING id", [title, isbn, cover, removed ? new Date() : null]);
  for (let i = 0; i < inStock; i++) await h.q("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', 5)", [id]);
  for (let i = 0; i < sold; i++) await h.q("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'sold', 5)", [id]);
  return id;
}
const row = async (id) => (await h.q("SELECT * FROM books WHERE id = $1", [id]))[0];
const as = (user) => (user ? { "x-test-user": JSON.stringify(user) } : {});
async function get(path, user = h.admin) {
  const res = await fetch(`${h.base}${path}`, { redirect: "manual", headers: as(user) });
  return { res, text: res.headers.get("content-type")?.includes("text") ? await res.text() : "" };
}
async function post(path, fields, user = h.admin) {
  const res = await fetch(`${h.base}${path}`, { method: "POST", redirect: "manual", headers: { ...as(user), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  return { res, location: res.headers.get("location") };
}

test("the page lists up to 8 candidates with edition details; the one whose ISBN list holds this ISBN is flagged and first", async () => {
  const id = await book({ title: "The French Lieutenant's Woman", isbn: ISBN });
  const { res, text } = await get(`/admin/inventory/${id}/find-cover?go=1`);
  assert.equal(res.status, 200);
  assert.match(text, /Same ISBN/);
  assert.ok(text.indexOf("Picador") < text.indexOf("Little, Brown"), "best match first");
  assert.match(text, /Picador · 1987 · eng/);
  assert.match(text, /Vintage · 2004 · eng/, "the editions list of the work adds candidates");
  assert.match(text, /name="coverId" value="555"/);
  assert.doesNotMatch(text, /No picture/, "an edition whose cover number is -1 is not offered");
  assert.equal((text.match(/cvr-find-match/g) || []).length, 2, "an edition list entry holding the ISBN-10 form of this ISBN matches too");
  assert.ok(text.indexOf("Albin Michel") < text.indexOf("Vintage"), "matches before the rest");
  assert.match(text, new RegExp(`/admin/inventory/${id}/find-cover/thumb/222`));
  assert.match(text, /name="coverId" value="333"/);
  assert.match(text, /Main cover of the work/);
  assert.doesNotMatch(text, /No cover edition/, "an edition without a cover number is not offered");
  assert.ok(text.indexOf("cvr-find-match") < text.indexOf("Little, Brown"));
  assert.ok(searches.length <= 4 && searches.length >= 3, `bounded: two searches and the editions of at most two works (${searches.length})`);
  assert.ok(searches.every((u) => u.includes("limit=")), "bounded");
  const after = await row(id);
  assert.equal(after.cover_url, null, "opening the page applies nothing");
  assert.equal(after.cover_origin, null);
});

test("no cover is stored or downloaded by opening the page; a second opening is served from the cache", async () => {
  const id = await book({ title: "Cached Search", isbn: null });
  await get(`/admin/inventory/${id}/find-cover?go=1`);
  const n = searches.length;
  await get(`/admin/inventory/${id}/find-cover?go=1`);
  assert.equal(searches.length, n, "no second search");
  assert.deepEqual(asked, []);
});

test("Open Library not answering shows a clear message, not an error page", async () => {
  global.fetch = async (url, init) => (String(url).includes("openlibrary.org/search.json") ? new Response("down", { status: 503 }) : realFetch(url, init));
  try {
    const id = await book({ title: "Down Search" });
    const { res, text } = await get(`/admin/inventory/${id}/find-cover?go=1`);
    assert.equal(res.status, 200);
    assert.match(text, /did not answer/);
  } finally {
    global.fetch = async (url, init) => {
      if (String(url).startsWith("https://openlibrary.org/search.json")) { searches.push(String(url)); return new Response(JSON.stringify(searchAnswer(String(url))), { status: 200 }); }
      if (String(url).startsWith("https://openlibrary.org/works/")) return new Response(JSON.stringify(EDITIONS), { status: 200 });
      return realFetch(url, init);
    };
  }
});

test("the small picture of a candidate comes through the safe download and is a small JPEG", async () => {
  const id = await book();
  const { res } = await get(`/admin/inventory/${id}/find-cover/thumb/222`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(asked, ["https://covers.openlibrary.org/b/id/222-M.jpg"]);
  assert.equal((await get(`/admin/inventory/${id}/find-cover/thumb/abc`)).res.status, 404);
});

test("choosing a candidate: downloaded from the numbered address, saved, origin 'chosen', checked, logged; a removed-cover flag is cleared", async () => {
  const id = await book({ title: "Pick Me", removed: true });
  const r = await post(`/admin/inventory/${id}/find-cover/choose`, { coverId: "222" });
  assert.equal(r.res.status, 303);
  assert.equal(r.location, `/admin/inventory/${id}?cover=chosen#cover`);
  assert.deepEqual(asked, ["https://covers.openlibrary.org/b/id/222-L.jpg"]);
  const b = await row(id);
  assert.equal(b.cover_url, STORED);
  assert.equal(b.cover_source_url, "https://covers.openlibrary.org/b/id/222-L.jpg");
  assert.equal(b.cover_origin, "chosen");
  assert.ok(b.cover_checked_at);
  assert.equal(b.cover_removed_at, null);
  let log = [];
  for (let i = 0; i < 20 && !log.length; i++) { log = await h.q("SELECT * FROM admin_audit_log WHERE action = 'cover.choose' AND target_id = $1", [id]); if (!log.length) await new Promise((x) => setTimeout(x, 100)); }
  assert.equal(log.length, 1);
});

test("a pick replaces an existing cover too", async () => {
  const id = await book({ cover: `/img/${"a".repeat(64)}.jpg` });
  await post(`/admin/inventory/${id}/find-cover/choose`, { coverId: "333" });
  assert.equal((await row(id)).cover_url, STORED);
});

test("only a cover NUMBER is accepted: an address, zero, letters or a huge number change nothing and download nothing", async () => {
  const id = await book({ title: "Guarded Pick" });
  for (const bad of ["https://evil.example/x.jpg", "http://127.0.0.1/a", "0", "-5", "12abc", "", "99999999999999"]) {
    const r = await post(`/admin/inventory/${id}/find-cover/choose`, { coverId: bad });
    assert.equal(r.location, `/admin/inventory/${id}?cover=bad-pick#cover`, bad);
  }
  assert.deepEqual(asked, []);
  const b = await row(id);
  assert.equal(b.cover_url, null);
  assert.equal(b.cover_origin, null);
});

test("a download that fails changes nothing and says so", async () => {
  const id = await book({ title: "Fail Pick" });
  downloadFails = true;
  const r = await post(`/admin/inventory/${id}/find-cover/choose`, { coverId: "222" });
  assert.equal(r.location, `/admin/inventory/${id}?cover=pick-failed#cover`);
  const b = await row(id);
  assert.equal(b.cover_url, null);
  assert.equal(b.cover_origin, null);
});

test("admin only: a member is refused, a guest is sent to login, and nothing is stored", async () => {
  const id = await book({ title: "Members Cannot" });
  assert.equal((await get(`/admin/inventory/${id}/find-cover?go=1`, h.member)).res.status, 403);
  assert.equal((await post(`/admin/inventory/${id}/find-cover/choose`, { coverId: "222" }, h.member)).res.status, 403);
  const guest = await post(`/admin/inventory/${id}/find-cover/choose`, { coverId: "222" }, null);
  assert.ok(!(guest.location || "").includes("cover=chosen"), "a guest is not served");
  assert.equal((await row(id)).cover_url, null);
  assert.equal((await get("/admin/inventory/999999999/find-cover")).res.status, 404);
});

test("Books without a cover: the count (in stock first) at the top, the list with a Find a cover button, in-stock books first", async () => {
  await h.q("DELETE FROM book_copies; DELETE FROM books");
  const none = await book({ title: "Zero Copies Book" });
  const stocked = await book({ title: "Stocked Missing Book", inStock: 2 });
  const soldOnly = await book({ title: "Sold Missing Book", sold: 1 });
  const removed = await book({ title: "Removed On Purpose Book", removed: true, inStock: 1 });
  const hasCover = await book({ title: "Has Cover Book", cover: STORED, inStock: 1 });
  const { res, text } = await get("/admin/reports/covers-to-check");
  assert.equal(res.status, 200);
  assert.match(text, /<strong>4<\/strong> books have no cover, <strong>2<\/strong> of them in stock/);
  const list = await get("/admin/reports/covers-to-check?view=missing");
  assert.match(list.text, /Books without a cover \(4\)/);
  for (const t of ["Zero Copies Book", "Stocked Missing Book", "Sold Missing Book", "Removed On Purpose Book"]) assert.match(list.text, new RegExp(t), t);
  assert.doesNotMatch(list.text, /Has Cover Book/);
  assert.match(list.text, /Cover removed on purpose/);
  assert.match(list.text, new RegExp(`/admin/inventory/${stocked}/find-cover\\?go=1&amp;from=missing`));
  assert.ok(list.text.indexOf("Stocked Missing Book") < list.text.indexOf("Zero Copies Book"), "in stock first");
  assert.ok(list.text.indexOf("Removed On Purpose Book") < list.text.indexOf("Sold Missing Book"));
  assert.ok(none && soldOnly && removed && hasCover);
});

test("choosing from the missing list goes back to that list with a notice, and the book leaves it", async () => {
  await h.q("DELETE FROM book_copies; DELETE FROM books");
  const id = await book({ title: "Back To List Book", inStock: 1 });
  const page = await get(`/admin/inventory/${id}/find-cover?go=1&from=missing`);
  assert.match(page.text, /Back to books without a cover/);
  assert.match(page.text, /name="from" value="missing"/);
  const r = await post(`/admin/inventory/${id}/find-cover/choose`, { coverId: "222", from: "missing" });
  assert.equal(r.location, "/admin/reports/covers-to-check?view=missing");
  const bad = await post(`/admin/inventory/${id}/find-cover/choose`, { coverId: "222", from: "https://evil.example" });
  assert.equal(bad.location, `/admin/inventory/${id}?cover=chosen#cover`, "an unknown 'from' is ignored");
  const list = await get("/admin/reports/covers-to-check?view=missing");
  assert.doesNotMatch(list.text, /Back To List Book/);
  assert.match(list.text, /Every book has a cover/);
});

test("the Covers to check list rows also offer Find a cover", async () => {
  await h.q("DELETE FROM book_copies; DELETE FROM books");
  const [{ id }] = await h.q("INSERT INTO books (title, cover_url, cover_source_url) VALUES ('Check Row Book', $1, 'https://covers.openlibrary.org/b/id/5-L.jpg') RETURNING id", [STORED]);
  const { text } = await get("/admin/reports/covers-to-check");
  assert.match(text, new RegExp(`/admin/inventory/${id}/find-cover\\?go=1&amp;from=check`));
});

test("without go=1 the page only offers the button and asks Open Library nothing", async () => {
  const id = await book({ title: "Idle Page" });
  const { res, text } = await get(`/admin/inventory/${id}/find-cover?sent[]=a&x=%00`);
  assert.equal(res.status, 200);
  assert.match(text, /Search Open Library/);
  assert.equal(searches.length, 0);
});
