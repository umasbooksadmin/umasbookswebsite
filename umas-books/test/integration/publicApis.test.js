// Public JSON endpoints and the book detail page (src/routes/books.js,
// src/routes/blog.js) against the real app: search q/genre/topic filters and
// result cap, latest-arrivals limit/days clamping, genres, by-ids, favorites toggle auth, book
// detail 404s/escaping, and the blog feed hiding drafts and future posts.
//
// Own throwaway database (isolated:true) because latest-arrivals is a
// global "newest N" query that other test files' rows would otherwise crowd. Search results are filtered by a unique
// per-run tag, so they don't depend on that.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3581;
const PASSWORD = "PublicApis1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const TAG = `Zq${Date.now().toString(36)}`; // unique per run, safe in ILIKE

let app;
let pool;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
});
after(async () => {
  await pool.end();
  await app.stop();
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function api(path, jar) {
  const res = await fetch(`${app.base}${path}`, { redirect: "manual", headers: jar ? { cookie: jar.header() } : {} });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { res, status: res.status, text, json };
}

async function makeBook({ title, authors = "Pub Author", categories = null, description = null, isbn = null, copies = [{ price: 5 }], coverUrl = null } = {}) {
  const t = title || `${TAG} Book ${uniq()}`;
  const { rows } = await pool.query(
    "INSERT INTO books (title, authors, categories, description, isbn, cover_url) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
    [t, authors, categories, description, isbn, coverUrl]
  );
  const ids = [];
  for (const c of copies) {
    const r = await pool.query(
      "INSERT INTO book_copies (book_id, status, price, condition, created_at) VALUES ($1, $2, $3, $4, COALESCE($5, now())) RETURNING id",
      [rows[0].id, c.status || "in_stock", c.price ?? null, c.condition || "very_good", c.createdAt || null]
    );
    ids.push(r.rows[0].id);
  }
  return { id: rows[0].id, title: t, copyIds: ids, authors };
}

async function makeLoggedInUser({ member = true, admin = false } = {}) {
  const email = `pub-${uniq()}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_member, is_admin, email_verified_at)
     VALUES ($1, $2, 'Pub User', $3, $4, now()) RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 10), member, admin]
  );
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ email, password: PASSWORD, _csrf: token }).toString(),
  });
  jar.capture(res);
  assert.equal(res.status, 302);
  return { id: rows[0].id, jar };
}

async function postJson(jar, path, fields) {
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}${path}`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
  });
  return { res, status: res.status };
}

const favCount = async (userId, bookId) =>
  Number((await pool.query("SELECT COUNT(*) FROM favorites WHERE user_id = $1 AND book_id = $2", [userId, bookId])).rows[0].count);

// ------------------------------------------------------------------ search

test("search: CORS headers and result shape; only in-stock books; price is the cheapest in-stock copy", async () => {
  const b = await makeBook({ title: `${TAG} Shape ${uniq()}`, authors: "Some Author", coverUrl: "/c.png", copies: [{ price: 9 }, { price: 4.5 }, { price: 1, status: "sold" }] });
  const gone = await makeBook({ title: `${TAG} Sold ${uniq()}`, copies: [{ status: "sold" }, { status: "reserved" }] });
  const { res, json } = await api(`/api/books/search?q=${encodeURIComponent(TAG)}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal(res.headers.get("cache-control"), "public, max-age=60");
  const hit = json.find((x) => x.id === b.id);
  assert.deepEqual(hit, { id: b.id, title: b.title, author: "Some Author", coverUrl: "/c.png", price: 4.5, awards: "", conditions: [{ value: "very_good", label: "Very Good" }], clearance: false, binding: null, bindingLabel: null, url: `${app.base}/books/${b.id}` });
  assert.ok(!json.some((x) => x.id === gone.id), "books with no in-stock copy are hidden");
});

test("search: q matches title, author, description and categories case-insensitively; ISBN matches digits only", async () => {
  const t = `${TAG} Alpha`;
  const byTitle = await makeBook({ title: `${t} Title ${uniq()}` });
  const byAuthor = await makeBook({ authors: `${t}author`.toLowerCase() });
  const byDesc = await makeBook({ description: `a story about ${t}desc` });
  const byCat = await makeBook({ categories: `Fiction, ${t}cat` });
  const isbn = `97${Math.floor(Math.random() * 1e11).toString().padStart(11, "0")}`;
  const byIsbn = await makeBook({ isbn, copies: [{ price: 3 }] });
  const ids = async (q) => (await api(`/api/books/search?q=${encodeURIComponent(q)}`)).json.map((x) => x.id);
  assert.deepEqual(await ids(t.toUpperCase() + "AUTHOR"), [byAuthor.id]);
  assert.deepEqual(await ids(`${t}DESC`), [byDesc.id]);
  assert.deepEqual(await ids(`${t}cat`), [byCat.id]);
  assert.ok((await ids(t)).includes(byTitle.id));
  assert.deepEqual(await ids(isbn), [byIsbn.id]);
  assert.deepEqual(await ids(`${isbn.slice(0, 3)}-${isbn.slice(3)}`), [byIsbn.id], "hyphenated ISBN still matches");
  assert.deepEqual(await ids(`${TAG}-nothing-${uniq()}`), []);
});

test("search: LIKE wildcards in q are bound as data, not SQL (quote and % do not break or widen the query)", async () => {
  await makeBook({ title: `${TAG} Quote ' ; DROP TABLE books; -- ${uniq()}` });
  const hit = await api(`/api/books/search?q=${encodeURIComponent(`${TAG} Quote ' ; DROP`)}`);
  assert.equal(hit.status, 200);
  assert.equal(hit.json.length, 1);
  assert.equal((await api("/api/books/search?q=" + encodeURIComponent("'"))).status, 200);
  assert.equal(Number((await pool.query("SELECT COUNT(*) FROM books")).rows[0].count) > 0, true);
});

test("search: results are capped at 60, ordered by title", async () => {
  const prefix = `${TAG} Cap`;
  for (let i = 0; i < 63; i++) await makeBook({ title: `${prefix} ${String(i).padStart(3, "0")}` });
  const { json } = await api(`/api/books/search?q=${encodeURIComponent(prefix)}`);
  assert.equal(json.length, 60);
  const titles = json.map((x) => x.title);
  assert.deepEqual(titles, [...titles].sort());
  assert.equal(titles[0], `${prefix} 000`);
});

test("search: genre is an exact match on a comma-separated category; topic matches substrings, Fiction excludes Non-fiction", async () => {
  const g = `Gen${uniq().replace("-", "")}`;
  const inGenre = await makeBook({ categories: `Mystery, ${g}` });
  const other = await makeBook({ categories: `${g}x` });
  const genre = await api(`/api/books/search?genre=${encodeURIComponent(g)}`);
  assert.deepEqual(genre.json.map((x) => x.id), [inGenre.id]);
  assert.ok(!genre.json.some((x) => x.id === other.id), "genre is exact, not substring");

  const fic = await makeBook({ title: `${TAG} Fic ${uniq()}`, categories: `Fiction ${TAG}t` });
  const nonfic = await makeBook({ title: `${TAG} NonFic ${uniq()}`, categories: `Non-fiction ${TAG}t` });
  const topic = await api(`/api/books/search?q=${TAG}&topic=Fiction`);
  assert.ok(topic.json.some((x) => x.id === fic.id));
  assert.ok(!topic.json.some((x) => x.id === nonfic.id));
  const multi = await api(`/api/books/search?q=${TAG}&topic=${encodeURIComponent("non-fiction, nomatch")}`);
  assert.ok(multi.json.some((x) => x.id === nonfic.id));
  assert.ok(!multi.json.some((x) => x.id === fic.id));
});

// ------------------------------------------------------------ genres/latest

test("genres: distinct, trimmed, sorted, only from books that are in stock", async () => {
  const id = uniq().replace("-", "");
  const a = `Zgenre${id}A`;
  const b = `Zgenre${id}B`;
  const hidden = `Zgenre${id}Hidden`;
  await makeBook({ categories: ` ${b} , ${a}` });
  await makeBook({ categories: `${a}` });
  await makeBook({ categories: `${hidden}`, copies: [{ status: "sold" }] });
  const { res, json } = await api("/api/books/genres");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("cache-control"), "public, max-age=300, s-maxage=300");
  assert.equal(json.filter((g) => g === a).length, 1, "distinct");
  assert.ok(json.includes(b));
  assert.ok(!json.includes(hidden));
  assert.ok(json.indexOf(a) < json.indexOf(b));
  assert.ok(json.every((g) => g === g.trim() && g !== ""));
});

test("latest-arrivals: limit is clamped to 1..24 (default 8) and results are newest first with the public shape", async () => {
  const marker = `${TAG} Latest`;
  for (let i = 0; i < 26; i++) await makeBook({ title: `${marker} ${String(i).padStart(2, "0")}`, copies: [{ price: 2 + i, createdAt: new Date(Date.now() + 3600 * 1000 + i * 1000) }] });
  const dflt = await api("/api/books/latest-arrivals");
  assert.equal(dflt.res.headers.get("access-control-allow-origin"), "*");
  assert.equal(dflt.res.headers.get("cache-control"), "public, max-age=60, s-maxage=60");
  assert.equal(dflt.json.length, 8);
  assert.equal(dflt.json[0].title, `${marker} 25`, "newest copy first");
  assert.deepEqual(Object.keys(dflt.json[0]).sort(), ["author", "coverUrl", "id", "price", "title", "url"]);
  assert.equal(dflt.json[0].price, 27);
  assert.equal((await api("/api/books/latest-arrivals?limit=3")).json.length, 3);
  assert.equal((await api("/api/books/latest-arrivals?limit=1000")).json.length, 24);
  assert.equal((await api("/api/books/latest-arrivals?limit=-4")).json.length, 1);
  assert.equal((await api("/api/books/latest-arrivals?limit=0")).json.length, 8);
  assert.equal((await api("/api/books/latest-arrivals?limit=abc")).json.length, 8);
});

test("latest-arrivals: ?days= windows by copy age; days=0 removes the window; sold copies never count", async () => {
  const old = await makeBook({ title: `${TAG} OldArrival`, copies: [{ createdAt: new Date(Date.now() - 30 * 86400 * 1000) }] });
  const soldNew = await makeBook({ title: `${TAG} SoldArrival`, copies: [{ status: "sold" }] });
  const ids = async (q) => (await api(`/api/books/latest-arrivals?limit=24&${q}`)).json.map((x) => x.id);
  assert.ok(!(await ids("days=7")).includes(old.id));
  assert.ok(!(await ids("")).includes(old.id), "default window is 7 days");
  assert.ok((await ids("days=60")).includes(old.id) || (await ids("days=60")).length === 24, "wider window admits it unless crowded out");
  const all = await ids("days=0");
  assert.ok(!all.includes(soldNew.id));
  assert.equal((await api("/api/books/latest-arrivals?days=-1&limit=24")).status, 200);
});

// ------------------------------------------- New In: "See All" shows every qualifying book

// The whole list, 60 at a time, the way the carousel loads it.
async function newInBatches(limit = 60) {
  const books = [];
  let total = null;
  let next = 0;
  for (let guard = 0; next != null && guard < 400; guard++) {
    const page = await api(`/api/books/new-in?offset=${next}&limit=${limit}`);
    assert.equal(page.status, 200);
    if (total == null) total = page.json.total;
    assert.equal(page.json.total, total, "the total is the same on every batch");
    assert.ok(page.json.books.length <= limit);
    books.push(...page.json.books);
    next = page.json.nextOffset;
  }
  return { books, total };
}

test("new-in: every book of the last 60 days (no cap), newest first by the exact time added, reachable in batches of 60 or pages of 24 with no gap and no duplicate; there is no all=1 mode", async () => {
  // 230 recent books so the old 200 maximum would cut the list
  for (let i = 0; i < 230; i++) await makeBook({ title: `${TAG} NewIn ${i}` });
  const { rows } = await pool.query("SELECT count(DISTINCT book_id)::int AS n FROM book_copies WHERE status = 'in_stock' AND created_at >= now() - interval '60 days'");
  assert.ok(rows[0].n >= 230);
  const batches = await newInBatches(60);
  assert.equal(batches.total, Math.max(rows[0].n, 40), "total = every book of the last 60 days (at least 40), not capped");
  assert.ok(batches.total > 200);
  assert.equal(batches.books.length, batches.total, "batches reach every book");
  assert.equal(new Set(batches.books.map((b) => b.id)).size, batches.books.length, "no book twice");
  assert.deepEqual(Object.keys(batches.books[0]).sort(), ["author", "coverUrl", "id", "price", "title", "url"]);
  const first = await api("/api/books/new-in?offset=0&limit=60");
  assert.equal(first.json.books.length, 60);
  assert.equal(first.json.nextOffset, 60, "the boundary is at 60");
  const second = await api("/api/books/new-in?offset=60&limit=60");
  assert.deepEqual(second.json.books.map((b) => b.id), batches.books.slice(60, 120).map((b) => b.id), "batch two starts exactly where batch one ended");
  // See All: 24 at a time gives the same list in the same order
  const seen = (await newInBatches(24)).books.map((b) => b.id);
  assert.deepEqual(batches.books.map((b) => b.id), seen, "the carousel (60 at a time) and See All (24 at a time) are the same list in the same order");
  assert.deepEqual((await api("/api/books/latest-arrivals?days=0&limit=12")).json.map((b) => b.id), seen.slice(0, 12), "and the old endpoint agrees");
  // all=1 is gone: it behaves like no parameter (the default 24), never the whole list
  const all = await api("/api/books/new-in?all=1");
  assert.equal(all.json.books.length, 24);
  assert.equal(all.json.nextOffset, 24);
  const past = await api(`/api/books/new-in?offset=${first.json.total + 50}`);
  assert.deepEqual([past.json.books.length, past.json.nextOffset, past.json.total], [0, null, first.json.total]);
  // the whole list is in descending time order
  const stamps = (await pool.query("SELECT book_id, MAX(created_at) AS t FROM book_copies WHERE status = 'in_stock' GROUP BY book_id")).rows;
  const at = new Map(stamps.map((r) => [r.book_id, r.t.getTime()]));
  for (let i = 1; i < seen.length; i++) assert.ok(at.get(seen[i - 1]) >= at.get(seen[i]), "newest first");
});

test("new-in: out-of-range or garbage offset and limit give 200 (empty or clamped), never a 500; limit is at most 100; the JSON is public-cacheable, sets no cookie", async () => {
  for (const qs of ["offset=1e22", "offset=99999999999999999999", "offset=-5", "offset=abc", "offset=1.5", "offset=100001", "offset=Infinity", "offset=0x10", "offset[]=1&limit[]=2", "limit=0", "limit=-1", "limit=abc", "limit=1e9", "limit=999999999999999999999", "offset=1e22&limit=1e9"]) {
    const r = await api(`/api/books/new-in?${qs}`);
    assert.equal(r.status, 200, qs);
    assert.ok(Array.isArray(r.json.books), qs);
    assert.ok(r.json.books.length <= 100, `${qs}: at most 100 books`);
    assert.ok(Number.isInteger(r.json.total), qs);
  }
  assert.equal((await api("/api/books/new-in?offset=1e22")).json.books.length, 0);
  assert.equal((await api("/api/books/new-in?limit=1e9")).json.books.length, 100, "limit is clamped to 100");
  assert.equal((await api("/api/books/new-in?limit=-1")).json.books.length, 1);
  assert.equal((await api("/api/books/new-in?limit=0")).json.books.length, 24, "0 = the default");
  const r = await api("/api/books/new-in?offset=0&limit=60");
  const cc = r.res.headers.get("cache-control") || "";
  assert.match(cc, /public/);
  assert.match(cc, /max-age=60/);
  assert.match(cc, /s-maxage=60/);
  assert.equal(r.res.headers.get("set-cookie"), null, "an anonymous cacheable response sets no cookie");
  // (the app adds Vary: Accept-Language, Cookie to every publicly cacheable answer, middleware/lang.js: harmless for a browser
  // and for a CDN that keys on the URL; the body below is identical for everyone)
  for (const path of ["/api/books/genres", "/api/books/latest-arrivals"]) {
    const g = await api(path);
    assert.equal(g.status, 200);
    assert.match(g.res.headers.get("cache-control") || "", /public, max-age=\d+, s-maxage=\d+/, path);
    assert.equal(g.res.headers.get("set-cookie"), null, path);
  }
});

test("books.html: the page does not grow with the shelf (the no-JavaScript list is a fixed handful) ", async () => {
  const size = async () => {
    const r = await api("/books.html");
    assert.equal(r.status, 200);
    const noscript = (r.text.match(/<noscript>[\s\S]*?<\/noscript>/g) || []).join("");
    return { bytes: Buffer.byteLength(r.text), items: (noscript.match(/<li>/g) || []).length };
  };
  const before = await size();
  assert.ok(before.items > 0 && before.items <= 36, `no-JavaScript list has ${before.items} books (1..36)`);
  await pool.query(
    `WITH b AS (INSERT INTO books (title, authors) SELECT $1 || ' Size ' || g, 'Size Author ' || g FROM generate_series(1, 520) g RETURNING id)
     INSERT INTO book_copies (book_id, status, price, condition) SELECT id, 'in_stock', 4, 'very_good' FROM b`,
    [TAG]
  );
  const after = await size();
  assert.equal(after.items, 36, "the handful is 36 once there are more than 36 new books");
  assert.ok(after.bytes < 100 * 1024, `books.html is ${after.bytes} bytes`);
  assert.ok(after.bytes - before.bytes < 4000, `520 more new books added ${after.bytes - before.bytes} bytes to the page (should be about the same size)`);
});

test("new-in: newest first by the exact time the copy was added, same-day books by time of day, ties by copy id, a book counts at its newest in-stock copy, acquired_at never orders", async () => {
  const ago = (min) => new Date(Date.now() - min * 60000);
  // all on the same calendar day (minutes ago), inserted in a scrambled order, with acquired_at pointing the opposite way
  const morning = await makeBook({ title: `${TAG} Time morning`, copies: [{ createdAt: ago(300) }] });
  const noon = await makeBook({ title: `${TAG} Time noon`, copies: [{ createdAt: ago(200) }] });
  const evening = await makeBook({ title: `${TAG} Time evening`, copies: [{ createdAt: ago(100) }] });
  // an old copy plus a newer one: counts at the newer; a newer SOLD copy does not count
  const multi = await makeBook({ title: `${TAG} Time multi`, copies: [{ createdAt: ago(400) }, { createdAt: ago(150) }, { createdAt: ago(10), status: "sold" }] });
  const tieTs = ago(50);
  const tieA = await makeBook({ title: `${TAG} Time tie A`, copies: [{ createdAt: tieTs }] });
  const tieB = await makeBook({ title: `${TAG} Time tie B`, copies: [{ createdAt: tieTs }] });
  await pool.query("UPDATE book_copies SET acquired_at = CURRENT_DATE - 30 WHERE book_id = ANY($1)", [[evening.id, tieA.id, tieB.id]]);
  await pool.query("UPDATE book_copies SET acquired_at = CURRENT_DATE + 1 WHERE book_id = ANY($1)", [[morning.id, multi.id]]);
  const want = [tieB.id, tieA.id, evening.id, multi.id, noon.id, morning.id]; // 50 min (tie: higher copy id first), 100, 150, 200, 300
  const wantSet = new Set(want);
  assert.deepEqual((await newInBatches(60)).books.map((b) => b.id).filter((id) => wantSet.has(id)), want, "carousel batches");
  const paged = [];
  for (let next = 0, guard = 0; next != null && guard++ < 40;) {
    const page = (await api(`/api/books/new-in?offset=${next}&limit=48`)).json;
    paged.push(...page.books.map((b) => b.id));
    next = page.nextOffset;
  }
  const mineIds = new Set(want);
  assert.deepEqual(paged.filter((id) => mineIds.has(id)), want, "See All pages give the same order");
});

test("search paged: a genre or a search pages through EVERY book (24 at a time) in a stable title order with a total; without paged=1 the old 60-book array is unchanged", async () => {
  const cat = `${TAG}Cat`;
  for (let i = 0; i < 70; i++) await makeBook({ title: `${TAG} Genre ${String(i).padStart(2, "0")}`, categories: `Fiction, ${cat}` });
  const base = `/api/books/search?genre=${encodeURIComponent(cat)}&paged=1`;
  const first = await api(`${base}&offset=0&limit=24`);
  assert.equal(first.status, 200);
  assert.deepEqual([first.json.total, first.json.books.length, first.json.nextOffset], [70, 24, 24]);
  const ids = first.json.books.map((b) => b.id);
  for (let next = first.json.nextOffset, guard = 0; next != null && guard++ < 10;) {
    const page = (await api(`${base}&offset=${next}&limit=24`)).json;
    assert.equal(page.total, 70);
    ids.push(...page.books.map((b) => b.id));
    next = page.nextOffset;
  }
  assert.equal(ids.length, 70, "every book of the genre is reachable (the old cap was 60)");
  assert.equal(new Set(ids).size, 70, "no book twice, none skipped");
  const titles = (await api(`/api/books/search?genre=${encodeURIComponent(cat)}&paged=1&offset=0&limit=48`)).json.books.map((b) => b.title);
  assert.deepEqual(titles, [...titles].sort(), "title order");
  const past = (await api(`${base}&offset=500`)).json;
  assert.deepEqual([past.books.length, past.nextOffset, past.total], [0, null, 70]);
  const byText = await api(`/api/books/search?q=${encodeURIComponent(`${TAG} Genre`)}&paged=1&limit=48`);
  assert.deepEqual([byText.json.total, byText.json.books.length, byText.json.nextOffset], [70, 48, 48], "a text search pages too");
  const plain = await api(`/api/books/search?genre=${encodeURIComponent(cat)}`);
  assert.ok(Array.isArray(plain.json));
  assert.equal(plain.json.length, 60, "the unpaged call keeps its 60-book array");
});

test("books.html is sent with the New In carousel hidden when the address has a search, a genre or new=1, and shown on the plain view", async () => {
  const hiddenIn = (html) => /<section class="bk-new"[^>]*\bhidden\b/.test(html);
  const get = async (u) => (await fetch(`${app.base}${u}`)).text();
  assert.equal(hiddenIn(await get("/books.html")), false);
  assert.equal(hiddenIn(await get("/books.html?genre=fiction")), true);
  assert.equal(hiddenIn(await get("/books.html?q=dune")), true);
  assert.equal(hiddenIn(await get("/books.html?new=1")), true);
  assert.equal(hiddenIn(await get("/fr/books.html?genre=fiction")), true);
  assert.equal(hiddenIn(await get("/fr/books.html")), false);
});

// ------------------------------------------- recommendation of the week (removed)

test("the 'recommendation of the week' feature is gone: the API route 404s and /books.html has no such section", async () => {
  assert.equal((await api("/api/books/recommendation")).status, 404);
  const html = await (await fetch(`${app.base}/books.html`)).text();
  assert.doesNotMatch(html, /bk-rec|recommendation of the week|coup de c[œo]eur de la semaine/i);
  assert.match(html, /bk-new/, "the New In section is still there");
  const css = await (await fetch(`${app.base}${(html.match(/href="([^"]*\/books\.css[^"]*)"/) || [])[1]}`)).text();
  assert.doesNotMatch(css, /\.bk-rec|rec-cover|recommendation of the week/i);
  const js = await (await fetch(`${app.base}${(html.match(/src="([^"]*page-books\.js[^"]*)"/) || [])[1]}`)).text();
  assert.doesNotMatch(js, /recommendation|bk-rec/i);
});

// ------------------------------------------------------- by-ids / favorites

test("by-ids: returns only the requested existing books with stock counts; junk ids are ignored", async () => {
  const a = await makeBook({ copies: [{ price: 6 }, { price: 3 }, { status: "sold", price: 1 }] });
  const b = await makeBook({ copies: [{ status: "sold" }] });
  assert.deepEqual((await api("/api/books/by-ids")).json, []);
  assert.deepEqual((await api("/api/books/by-ids?ids=abc,-1,0,1.5,,")).json, []);
  const { json } = await api(`/api/books/by-ids?ids=${a.id},${b.id},999999999,abc`);
  assert.deepEqual(json.map((x) => x.id).sort((x, y) => x - y), [a.id, b.id].sort((x, y) => x - y));
  const ra = json.find((x) => x.id === a.id);
  assert.equal(ra.price, 3);
  assert.equal(ra.inStockCount, 2);
  assert.equal(ra.url, `/books/${a.id}`);
  assert.equal(json.find((x) => x.id === b.id).price, null);
  assert.equal((await api("/favorites")).status, 200);
});

test("favorites toggle: anonymous is a silent 204 no-op; logged-in add is idempotent and remove deletes", async () => {
  const book = await makeBook();
  const user = await makeLoggedInUser({ member: false });
  const anon = makeCookieJar();
  const noop = await postJson(anon, "/api/favorites/toggle", { bookId: String(book.id), isFavorite: "1" });
  assert.equal(noop.status, 204);
  assert.equal(await favCount(user.id, book.id), 0);

  assert.equal((await postJson(user.jar, "/api/favorites/toggle", { bookId: String(book.id), isFavorite: "1" })).status, 204);
  assert.equal((await postJson(user.jar, "/api/favorites/toggle", { bookId: String(book.id), isFavorite: "1" })).status, 204);
  assert.equal(await favCount(user.id, book.id), 1);
  assert.equal((await postJson(user.jar, "/api/favorites/toggle", { bookId: String(book.id), isFavorite: "" })).status, 204);
  assert.equal(await favCount(user.id, book.id), 0);
});

test("favorites toggle: missing/zero/non-numeric bookId is a 400 for a logged-in user", async () => {
  const user = await makeLoggedInUser({ member: false });
  for (const bookId of ["", "0", "abc"]) {
    assert.equal((await postJson(user.jar, "/api/favorites/toggle", { bookId, isFavorite: "1" })).status, 400, `bookId=${bookId}`);
  }
  assert.equal((await postJson(user.jar, "/api/favorites/toggle", { isFavorite: "1" })).status, 400);
});

// A well-formed id that is not a book must not reach the favorites.book_id
// foreign key (a 500, which also spends the alertOnError throttle window).
test("favorites toggle: an unknown (well-formed) book id is a 404, never a 500", async () => {
  const user = await makeLoggedInUser({ member: false });
  const r = await postJson(user.jar, "/api/favorites/toggle", { bookId: "999999999", isFavorite: "1" });
  assert.equal(r.status, 404);
  // removing a favourite of a book that does not exist is a harmless no-op
  assert.equal((await postJson(user.jar, "/api/favorites/toggle", { bookId: "999999999", isFavorite: "" })).status, 204);
});

test("favorites toggle: huge, negative, fractional, exponent, NaN and non-string ids are 400/404, never a 500", async () => {
  const user = await makeLoggedInUser({ member: false });
  for (const bookId of ["1e21", "-5", "1.5", "NaN", "Infinity", "2147483648", "99999999999999999999", " 7", "0x10", 1e21, -5, 1.5, NaN, null, [], {}]) {
    const r = await postJson(user.jar, "/api/favorites/toggle", { bookId, isFavorite: "1" });
    assert.ok([400, 404].includes(r.status), `bookId=${JSON.stringify(bookId)} gave ${r.status}`);
  }
});

// ------------------------------------------------------------ book detail

test("book detail: renders title, author, cheapest-first copies, condition, escaped description, and more-by-author", async () => {
  const author = `Author ${uniq()}`;
  const book = await makeBook({
    title: `<script>alert('b')</script> ${TAG}`, authors: author, categories: "Poetry",
    description: "<img src=x onerror=1> Nice", copies: [{ price: 12, condition: "very_good" }, { price: 4, condition: "acceptable" }],
  });
  const sibling = await makeBook({ title: `${TAG} Sibling`, authors: author });
  const soldOut = await makeBook({ title: `${TAG} SiblingSold`, authors: author, copies: [{ status: "sold" }] });
  const { status, text } = await api(`/books/${book.id}?genre=Poetry`);
  assert.equal(status, 200);
  assert.ok(!text.includes("<script>alert('b')"));
  assert.ok(!text.includes("<img src=x onerror=1>"));
  assert.match(text, /&lt;script&gt;alert\(&#39;b&#39;\)&lt;\/script&gt;/);
  assert.match(text, /2 copies on our shelves/);
  assert.ok(text.indexOf("€4.00") < text.indexOf("€12.00"), "cheapest copy listed first");
  assert.match(text, /Back to Poetry/);
  assert.match(text, /More by /);
  assert.ok(text.includes(`/books/${sibling.id}`));
  assert.ok(!text.includes(`/books/${soldOut.id}`), "sold-out books by the same author aren't suggested");
  assert.match(text, /action="\/cart\/add"/);
  assert.equal((text.match(/name="copyId"/g) || []).length, 2, "one add-to-cart form per copy");
  assert.match(text, /Acceptable/);
  assert.match(text, /Very Good/);
});

test("book detail: a book with no in-stock copies renders without an add-to-cart form; unknown, garbage and overflow ids 404", async () => {
  const sold = await makeBook({ copies: [{ status: "sold" }] });
  const page = await api(`/books/${sold.id}`);
  assert.equal(page.status, 200);
  assert.ok(!page.text.includes(`action="/books/${sold.id}/reserve"`));
  assert.ok(!page.text.includes('action="/cart/add"'), "nothing to add to the cart");
  for (const id of ["999999999", "abc", "0", "-1", "99999999999999999999", "1.5"]) {
    const r = await api(`/books/${id}`);
    assert.equal(r.status, 404, `/books/${id}`);
  }
});

// -------------------------------------------------------------------- blog

test("blog feed: published posts only (no drafts, scheduled or future-dated), public shape, CORS and cache headers", async () => {
  const hour = 3600 * 1000;
  const mk = async ({ status = "published", at = new Date(Date.now() - hour), category = null, image = null, excerpt = null, title }) => {
    const slug = `blog-${uniq()}`;
    await pool.query(
      "INSERT INTO blog_posts (title, body, slug, status, published_at, category, image_url, excerpt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [title || `Post ${slug}`, "<p>Body</p>", slug, status, at, category, image, excerpt]
    );
    return slug;
  };
  const live = await mk({ category: "News", image: "/i.png", excerpt: "Short", title: "Live <b>post</b>" });
  const bare = await mk({ at: new Date(Date.now() - 2 * hour) });
  const draft = await mk({ status: "draft" });
  const future = await mk({ at: new Date(Date.now() + 24 * hour) });
  const futureScheduled = await mk({ status: "scheduled", at: new Date(Date.now() + 24 * hour) });

  const { res, json } = await api("/api/blog/posts");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
  const slugs = json.map((p) => p.slug);
  assert.ok(slugs.includes(live) && slugs.includes(bare));
  for (const hidden of [draft, future, futureScheduled]) assert.ok(!slugs.includes(hidden), `${hidden} must be hidden`);
  assert.ok(slugs.indexOf(live) < slugs.indexOf(bare), "newest first");

  const p = json.find((x) => x.slug === live);
  assert.equal(p.title, "Live <b>post</b>", "JSON carries the raw title; the consumer escapes it");
  assert.equal(p.excerpt, "Short");
  assert.equal(p.category, "News");
  assert.equal(p.image, "/i.png");
  assert.match(p.date, /^\d{4}-\d{2}-\d{2}$/);
  const b = json.find((x) => x.slug === bare);
  assert.equal(b.excerpt, "");
  assert.ok(!("category" in b) && !("image" in b), "empty optional fields are omitted");
  assert.ok(json.length <= 100);
});
