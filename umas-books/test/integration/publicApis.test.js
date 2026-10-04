// Public JSON endpoints and the book detail page (src/routes/books.js,
// src/routes/blog.js) against the real app: search q/genre/topic filters and
// result cap, latest-arrivals limit/days clamping, genres, the weekly
// recommendation's eligibility rules, by-ids, favorites toggle auth, book
// detail 404s/escaping, and the blog feed hiding drafts and future posts.
//
// Own throwaway database (isolated:true) because latest-arrivals and the
// recommendation are global "newest N" / "one pick" queries that other test
// files' rows would otherwise crowd. Search results are filtered by a unique
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
      [rows[0].id, c.status || "in_stock", c.price ?? null, c.condition || "good", c.createdAt || null]
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
  assert.deepEqual(hit, { id: b.id, title: b.title, author: "Some Author", coverUrl: "/c.png", price: 4.5, awards: "", url: `${app.base}/books/${b.id}` });
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
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
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
  assert.equal(dflt.res.headers.get("cache-control"), "public, max-age=60");
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

// -------------------------------------------------------- recommendation

test("recommendation: null with no eligible favorites; only member/admin favorites of in-stock books qualify; stable within the week", async () => {
  const empty = await api("/api/books/recommendation");
  assert.equal(empty.res.headers.get("access-control-allow-origin"), "*");
  assert.equal(empty.res.headers.get("cache-control"), "public, max-age=300");
  assert.equal(empty.json, null);

  const plainUser = await makeLoggedInUser({ member: false });
  const memberUser = await makeLoggedInUser({ member: true });
  const nonMemberBook = await makeBook({ title: `${TAG} FavPlain` });
  const soldBook = await makeBook({ title: `${TAG} FavSold`, copies: [{ status: "sold" }] });
  await pool.query("INSERT INTO favorites (user_id, book_id) VALUES ($1, $2)", [plainUser.id, nonMemberBook.id]);
  await pool.query("INSERT INTO favorites (user_id, book_id) VALUES ($1, $2)", [memberUser.id, soldBook.id]);
  assert.equal((await api("/api/books/recommendation")).json, null, "non-member favorites and sold-out books don't qualify");

  const pick = await makeBook({ title: `${TAG} FavPick`, description: "English blurb", authors: "Pick Author", coverUrl: "/p.png" });
  await pool.query("INSERT INTO favorites (user_id, book_id) VALUES ($1, $2)", [memberUser.id, pick.id]);
  const first = await api("/api/books/recommendation");
  assert.deepEqual(first.json, {
    id: pick.id, title: pick.title, author: "Pick Author", coverUrl: "/p.png",
    blurb: { en: "English blurb", fr: "English blurb" }, url: `${app.base}/books/${pick.id}`,
  });
  assert.deepEqual((await api("/api/books/recommendation")).json, first.json);
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

// BUG: no existence check before the INSERT, so favoriting a well-formed id
// that isn't a book hits the favorites.book_id foreign key and returns a 500
// (and spends the alertOnError throttle window) instead of a 4xx.
test("favorites toggle: an unknown (well-formed) book id is rejected with a 4xx, not a 500",
  { todo: "POST /api/favorites/toggle with a non-existent bookId returns 500 (FK violation) instead of a 4xx" },
  async () => {
    const user = await makeLoggedInUser({ member: false });
    const r = await postJson(user.jar, "/api/favorites/toggle", { bookId: "999999999", isFavorite: "1" });
    assert.ok(r.status >= 400 && r.status < 500, `got ${r.status}`);
  });

// ------------------------------------------------------------ book detail

test("book detail: renders title, author, cheapest-first copies, condition, escaped description, and more-by-author", async () => {
  const author = `Author ${uniq()}`;
  const book = await makeBook({
    title: `<script>alert('b')</script> ${TAG}`, authors: author, categories: "Poetry",
    description: "<img src=x onerror=1> Nice", copies: [{ price: 12, condition: "good" }, { price: 4, condition: "fair" }],
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
  assert.match(text, /<select[^>]*name="copyId"/);
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
