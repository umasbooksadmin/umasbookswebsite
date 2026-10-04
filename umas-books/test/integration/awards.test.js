// Awards & best-seller lists (src/lib/awards, routes/admin/awards.js, the
// public book page): orchestration against a real database with every lookup
// stubbed, what customers can see, the admin review screens, and the
// background check at intake. The network is never reached: global.fetch is
// replaced and refuses every host that is not this test's own server.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen, waitFor } = require("../helpers/inProcessApp");

const db = prepareDatabase("awards", { isolated: true });
process.env.AWARDS_LOOKUPS = "on"; // the helper defaults to off; this file tests the lookups
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AWARDS_AI;
delete process.env.NYT_API_KEY;

const { pool } = require("../../src/db");
const awards = require("../../src/lib/awards");
const nyt = require("../../src/lib/awards/nyt");
const ai = require("../../src/lib/awards/ai");

const realFetch = global.fetch;
// wikidataGate: a promise the stubbed Wikidata waits on before answering, so a
// test can hold the lookup "in flight" for exactly as long as it needs (no
// wall-clock delay for a slow CI machine to overrun).
const net = { wikidata: null, wikidataGate: null, calls: [] };
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bind = (label, year, kind = "award") => ({
  awardLabel: { value: label }, ...(year ? { year: { value: String(year) } } : {}), kind: { value: kind },
});

global.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1:")) return realFetch(url, init);
  net.calls.push(u);
  if (u.startsWith("https://query.wikidata.org/sparql")) {
    if (net.wikidataGate) await net.wikidataGate;
    if (net.wikidata === "error") return jsonRes({}, 500);
    return jsonRes({ results: { bindings: net.wikidata || [] } });
  }
  throw new Error(`test refused a real outbound request to ${u}`);
};

let server;
let admin;
before(async () => {
  db.create();
  server = await listen(buildApp([require("../../src/routes/books"), require("../../src/routes/admin/awards"), require("../../src/routes/admin/inventory")]));
  const { rows } = await pool.query(
    "INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ($1, 'x', 'Awards Admin', true) RETURNING id, email",
    [`awards-admin-${uniq()}@example.test`]
  );
  admin = { id: rows[0].id, email: rows[0].email, displayName: "Awards Admin", isAdmin: true };
});
after(async () => {
  global.fetch = realFetch;
  await server.close();
  await pool.end();
  db.drop();
});
beforeEach(() => {
  net.wikidata = null;
  net.wikidataGate = null;
  net.calls.length = 0;
  nyt.resetGate();
  ai.resetAiUsage();
});

function uniq() { return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`; }
let seq = 0;
const tag = () => `Aw${Date.now().toString(36)}${++seq}`;
const isbn13 = () => `979${String(Date.now()).slice(-7)}${String(++seq).padStart(3, "0")}`;
const FAST = { gapMs: 0 }; // no politeness sleep in tests

async function seedBook({ title = `Book ${tag()}`, authors = "Some Author", isbn = isbn13(), inStock = true } = {}) {
  const { rows } = await pool.query("INSERT INTO books (title, authors, isbn) VALUES ($1, $2, $3) RETURNING id", [title, authors, isbn]);
  if (inStock) await pool.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 5, 'very_good')", [rows[0].id]);
  return { id: rows[0].id, title, isbn };
}
const addAward = async (bookId, label, { year = null, kind = "award", source = "wikidata", status = "verified", url = null } = {}) =>
  (await pool.query(
    "INSERT INTO book_awards (book_id, label, year, kind, source, source_url, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
    [bookId, label, year, kind, source, url, status]
  )).rows[0].id;
const rowsOf = async (bookId) => (await pool.query("SELECT * FROM book_awards WHERE book_id = $1 ORDER BY id", [bookId])).rows;
const bookRow = async (id) => (await pool.query("SELECT * FROM books WHERE id = $1", [id])).rows[0];

const hdr = (user) => (user ? { "x-test-user": JSON.stringify(user) } : {});
async function http(path, { method = "GET", form, user = admin, cookie } = {}) {
  const headers = { ...hdr(user), ...(cookie ? { cookie } : {}) };
  let body;
  if (form) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) for (const x of [].concat(v)) p.append(k, String(x));
    body = p.toString();
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const res = await fetch(`${server.base}${path}`, { method, redirect: "manual", headers, body });
  return { res, status: res.status, text: await res.text(), location: res.headers.get("location") };
}
const auditRows = async (action, targetId) =>
  (await pool.query("SELECT * FROM admin_audit_log WHERE action = $1 AND target_id = $2 ORDER BY id", [action, targetId])).rows;

const AI_ENV = { ...process.env, ANTHROPIC_API_KEY: "k", AWARDS_AI: "1", AWARDS_AI_DAILY_MAX: "100" };
const stubAi = (items, extra = {}) => async () => ({ items, error: false, called: true, ...extra });

// ------------------------------------------------------------ orchestration

test("check stores Wikidata findings as verified, sets state ok, and is idempotent", async () => {
  const book = await seedBook();
  net.wikidata = [bind("Hugo Award for Best Novel", 1990), bind("Nebula Award for Best Novel", 1989, "shortlist")];
  const first = await awards.checkBookAwards(pool, book.id, FAST);
  assert.equal(first.state, "ok");
  const rows = await rowsOf(book.id);
  assert.deepEqual(rows.map((r) => [r.label, r.year, r.kind, r.source, r.status]), [
    ["Hugo Award for Best Novel", 1990, "award", "wikidata", "verified"],
    ["Nebula Award for Best Novel", 1989, "shortlist", "wikidata", "verified"],
  ]);
  const b1 = await bookRow(book.id);
  assert.equal(b1.awards_check_state, "ok");
  assert.ok(b1.awards_checked_at);

  await awards.checkBookAwards(pool, book.id, FAST);
  assert.equal((await rowsOf(book.id)).length, 2, "running again adds nothing");
  assert.ok(net.calls.every((u) => u.startsWith("https://query.wikidata.org/")), "only Wikidata was asked (no keys set)");
});

test("state is 'none' when nothing is found and 'error' when a lookup fails", async () => {
  const none = await seedBook();
  net.wikidata = [];
  assert.equal((await awards.checkBookAwards(pool, none.id, FAST)).state, "none");
  assert.equal((await bookRow(none.id)).awards_check_state, "none");

  const bad = await seedBook();
  net.wikidata = "error";
  const res = await awards.checkBookAwards(pool, bad.id, FAST);
  assert.equal(res.state, "error");
  assert.equal((await bookRow(bad.id)).awards_check_state, "error");
  assert.equal((await rowsOf(bad.id)).length, 0);

  assert.equal((await awards.checkBookAwards(pool, 2147483000, FAST)).missing, true, "unknown book: no throw");
});

test("a book without an ISBN skips Wikidata and still gets a state", async () => {
  const book = await seedBook({ isbn: null });
  const res = await awards.checkBookAwards(pool, book.id, FAST);
  assert.equal(res.state, "none");
  assert.equal(net.calls.length, 0);
});

test("NYT runs only when a key is set; its rows are verified bestseller rows", async () => {
  const book = await seedBook();
  const nytStub = async (b, o) => {
    assert.equal(o.apiKey, "nyt-key");
    return { items: [{ label: "New York Times Best Seller (Hardcover Fiction)", year: 2019, kind: "bestseller", source_url: "https://www.nytimes.com/books/best-sellers/" }], error: false };
  };
  await awards.checkBookAwards(pool, book.id, { ...FAST, nyt: nytStub, env: { ...process.env, NYT_API_KEY: "nyt-key" }, wikidata: async () => ({ items: [], error: false }) });
  const rows = await rowsOf(book.id);
  assert.deepEqual(rows.map((r) => [r.source, r.status, r.kind]), [["nyt", "verified", "bestseller"]]);

  const other = await seedBook();
  net.wikidata = [];
  await awards.checkBookAwards(pool, other.id, FAST); // no key in env: real nyt module skips
  assert.ok(!net.calls.some((u) => u.includes("nytimes")));
});

test("AI findings are stored pending; trusted sources upgrade them; rejected ones never come back", async () => {
  const book = await seedBook();
  const item = { label: "Booker Prize", year: 2019, kind: "award", source_url: "https://example.org/booker" };
  const deps = { ...FAST, env: AI_ENV, ai: stubAi([item]), wikidata: async () => ({ items: [], error: false }) };
  const res = await awards.checkBookAwards(pool, book.id, deps);
  assert.equal(res.aiCalled, true);
  let rows = await rowsOf(book.id);
  assert.deepEqual(rows.map((r) => [r.source, r.status, r.source_url]), [["ai", "pending", "https://example.org/booker"]]);
  assert.ok((await bookRow(book.id)).awards_ai_checked_at);

  // Wikidata later confirms the same award: the pending AI row becomes verified.
  await awards.checkBookAwards(pool, book.id, { ...deps, ai: stubAi([]), wikidata: async () => ({ items: [{ label: "booker prize", year: 2019, kind: "award", source_url: null }], error: false }) });
  rows = await rowsOf(book.id);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].source, rows[0].status, rows[0].source_url], ["wikidata", "verified", "https://example.org/booker"]);

  // A rejected suggestion is not offered again, in any year.
  const other = await seedBook();
  const id = await addAward(other.id, "Pulitzer Prize", { year: 2001, source: "ai", status: "rejected" });
  await awards.checkBookAwards(pool, other.id, { ...deps, ai: stubAi([{ label: "Pulitzer Prize", year: 2002, kind: "award", source_url: "https://example.org/p" }]) });
  const after = await rowsOf(other.id);
  assert.deepEqual(after.map((r) => [r.id, r.status]), [[id, "rejected"]]);
});

test("AI is skipped when switched off, without a key, without an author, or over the daily cap", async () => {
  const never = async () => assert.fail("AI must not run");
  const base = { ...FAST, ai: never, wikidata: async () => ({ items: [], error: false }) };
  const a = await seedBook();
  await awards.checkBookAwards(pool, a.id, { ...base, env: { ...process.env, ANTHROPIC_API_KEY: "k", AWARDS_AI: "" } });
  await awards.checkBookAwards(pool, a.id, { ...base, env: { ...process.env, ANTHROPIC_API_KEY: "", AWARDS_AI: "1" } });
  const noAuthor = await seedBook({ authors: "" });
  await awards.checkBookAwards(pool, noAuthor.id, { ...base, env: AI_ENV });
  assert.equal((await bookRow(a.id)).awards_ai_checked_at, null);

  // Cap: 2 books per day. The third is skipped and keeps its place in the AI backlog.
  await pool.query("UPDATE books SET awards_ai_checked_at = NULL WHERE awards_ai_checked_at IS NOT NULL");
  const env = { ...AI_ENV, AWARDS_AI_DAILY_MAX: "2" };
  const ran = [];
  const counting = async (b) => { ran.push(b.id); return { items: [], error: false, called: true }; };
  const books = [await seedBook(), await seedBook(), await seedBook()];
  const results = [];
  for (const b of books) results.push(await awards.checkBookAwards(pool, b.id, { ...base, env, ai: counting }));
  assert.deepEqual(ran, [books[0].id, books[1].id]);
  assert.equal(results[2].aiCapped, true);
  assert.equal((await bookRow(books[2].id)).awards_ai_checked_at, null);
  assert.equal((await bookRow(books[2].id)).awards_check_state, "none", "the rest of the check still happened");

  // A restart (memory counter reset) does not reset the cap: the database remembers.
  ai.resetAiUsage();
  const again = await seedBook();
  const r = await awards.checkBookAwards(pool, again.id, { ...base, env, ai: counting });
  assert.equal(r.aiCapped, true);
  assert.equal(ran.length, 2);
});

test("an AI error marks the book 'error' (retried tomorrow), keeps what trusted sources found, and makes one call", async () => {
  const book = await seedBook();
  let calls = 0;
  const res = await awards.checkBookAwards(pool, book.id, {
    ...FAST, env: AI_ENV,
    wikidata: async () => ({ items: [{ label: "Locus Award", year: 2000, kind: "award", source_url: null }], error: false }),
    ai: async () => { calls++; return { items: [], error: true, called: true }; },
  });
  assert.equal(res.state, "error");
  assert.equal(calls, 1);
  assert.equal((await rowsOf(book.id)).length, 1);
});

test("the kill switch stops every lookup and touches nothing", async () => {
  const book = await seedBook();
  const res = await awards.checkBookAwards(pool, book.id, { ...FAST, env: { ...process.env, AWARDS_LOOKUPS: "off" }, wikidata: async () => assert.fail("off means off") });
  assert.equal(res.disabled, true);
  assert.equal((await bookRow(book.id)).awards_checked_at, null);
});

// ------------------------------------------------------------ unique index

test("the same award cannot be stored twice for one book (case-insensitive, per year)", async () => {
  const book = await seedBook();
  await addAward(book.id, "Hugo Award", { year: 1990 });
  await assert.rejects(addAward(book.id, "HUGO award", { year: 1990 }), (e) => e.code === "23505");
  await addAward(book.id, "Hugo Award", { year: 1991 });
  await addAward(book.id, "Hugo Award", { year: null });
  await assert.rejects(addAward(book.id, "hugo AWARD", { year: null }), (e) => e.code === "23505");
  await assert.rejects(pool.query("INSERT INTO book_awards (book_id,label,kind,source,status) VALUES ($1,'x','prize','wikidata','verified')", [book.id]), (e) => e.code === "23514");
  await assert.rejects(pool.query("INSERT INTO book_awards (book_id,label,kind,source,status) VALUES ($1,'x','award','wikidata','maybe')", [book.id]), (e) => e.code === "23514");
});

// -------------------------------------------------------------- public page

test("the book page shows verified and approved awards only, in order, and hides the line when there are none", async () => {
  const book = await seedBook();
  const empty = await http(`/books/${book.id}`, { user: null });
  assert.equal(empty.status, 200);
  assert.ok(!empty.text.includes("Awards &amp; lists"));

  await addAward(book.id, "Shown List", { year: 2010, kind: "bestseller" });
  await addAward(book.id, "Shown Shortlist", { year: 2012, kind: "shortlist" });
  await addAward(book.id, "Shown Old Award", { year: 1999, kind: "award" });
  await addAward(book.id, "Shown New Award", { year: 2015, kind: "award" });
  await addAward(book.id, "Approved Thing", { kind: "award", source: "ai", status: "approved" });
  await addAward(book.id, "Hidden Pending", { source: "ai", status: "pending" });
  await addAward(book.id, "Hidden Rejected", { source: "ai", status: "rejected" });
  const page = await http(`/books/${book.id}`, { user: null });
  assert.match(page.text, /Awards &amp; lists:/);
  const line = page.text.match(/Awards &amp; lists:<\/strong>([\s\S]*?)<\/div>/)[1].replace(/\s+/g, " ").trim();
  assert.equal(line, "Shown New Award (2015), Shown Old Award (1999), Approved Thing, Shown Shortlist (2012), Shown List (2010)");
  assert.ok(!page.text.includes("Hidden Pending") && !page.text.includes("Hidden Rejected"));
  assert.ok(!page.text.includes("Show all"), "5 entries: no expander");
});

test("more than 8 entries: the first 8 and a native details 'Show all' with every one", async () => {
  const book = await seedBook();
  for (let i = 0; i < 10; i++) await addAward(book.id, `Prize Number ${i}`, { year: 2000 + i });
  const page = await http(`/books/${book.id}`, { user: null });
  assert.match(page.text, /<details[^>]*>\s*<summary[^>]*>Show all \(10\)<\/summary>/);
  assert.ok(page.text.includes("Prize Number 0 (2000)"));
});

test("the French page uses 'Prix et classements :' and keeps the label text", async () => {
  const book = await seedBook();
  await addAward(book.id, "Prix Goncourt", { year: 1999 });
  const fr = await http(`/books/${book.id}`, { user: null, cookie: "umasbooks_lang=fr" });
  assert.match(fr.text, /Prix et classements&nbsp;:|Prix et classements :/);
  assert.ok(fr.text.includes("Prix Goncourt (1999)"));
  assert.ok(!fr.text.includes("Awards &amp; lists"));
  const en = await http(`/books/${book.id}`, { user: null, cookie: "umasbooks_lang=en" });
  assert.ok(en.text.includes("Awards &amp; lists:"));
});

test("a label from an outside source is HTML-escaped on the book page and in the admin screens", async () => {
  const book = await seedBook();
  const evil = `<script>alert("x")</script> Prize`;
  await addAward(book.id, evil, { year: 2001, source: "ai", status: "pending", url: "https://example.org/x" });
  await addAward(book.id, evil + " 2", { year: 2001 });
  const page = await http(`/books/${book.id}`, { user: null });
  assert.ok(!page.text.includes("<script>alert"));
  assert.ok(page.text.includes("&lt;script&gt;alert(&#34;x&#34;)&lt;/script&gt; Prize 2 (2001)"));
  for (const path of [`/admin/inventory/${book.id}`, "/admin/awards"]) {
    const admin_ = await http(path);
    assert.equal(admin_.status, 200);
    assert.ok(!admin_.text.includes("<script>alert"), path);
  }
});

test("the search API carries a short awards text (verified and approved only)", async () => {
  const t = tag();
  const book = await seedBook({ title: `Searchable ${t}` });
  await addAward(book.id, "Visible Prize", { year: 2020 });
  await addAward(book.id, "Secret Pending", { source: "ai", status: "pending" });
  const res = await fetch(`${server.base}/api/books/search?q=${t}`);
  const list = await res.json();
  assert.equal(list.length, 1);
  assert.equal(list[0].awards, "Visible Prize (2020)");
  const plain = await seedBook({ title: `Plain ${t}x` });
  const l2 = await (await fetch(`${server.base}/api/books/search?q=Plain%20${t}x`)).json();
  assert.equal(l2.find((b) => b.id === plain.id).awards, "");
});

// ------------------------------------------------------------------- admin

test("every awards route refuses anonymous visitors and non-admins", async () => {
  const member = { id: admin.id, email: "m@example.test", displayName: "M", isAdmin: false, isMember: true };
  const routes = [
    ["GET", "/admin/awards"], ["POST", "/admin/awards/approve-bulk"], ["POST", "/admin/awards/1/approve"],
    ["POST", "/admin/awards/1/reject"], ["POST", "/admin/awards/1/remove"],
    ["POST", "/admin/inventory/1/awards/check"], ["POST", "/admin/inventory/1/awards/add"],
  ];
  for (const [method, path] of routes) {
    const anon = await http(path, { method, user: null });
    assert.equal(anon.status, 302, `${method} ${path}`);
    assert.equal(anon.location, "/login");
    assert.equal((await http(path, { method, user: member })).status, 403, `${method} ${path} member`);
  }
});

test("approve and reject change status, record who decided, and write audit rows", async () => {
  const book = await seedBook();
  const a = await addAward(book.id, "Approve Me", { source: "ai", status: "pending", url: "https://example.org/a" });
  const r = await addAward(book.id, "Reject Me", { source: "ai", status: "pending" });
  const res = await http(`/admin/awards/${a}/approve`, { method: "POST" });
  assert.equal(res.status, 302);
  assert.equal(res.location, `/admin/inventory/${book.id}?notice=awards-updated`);
  await http(`/admin/awards/${r}/reject`, { method: "POST", form: { returnTo: "review" } });
  const rows = await rowsOf(book.id);
  assert.equal(rows[0].status, "approved");
  assert.equal(rows[0].decided_by, admin.id);
  assert.ok(rows[0].decided_at);
  assert.equal(rows[1].status, "rejected");
  const [aud] = await auditRows("award.approve", a);
  assert.equal(aud.detail, "Approve Me");
  assert.equal(aud.actor_user_id, admin.id);
  assert.equal((await auditRows("award.reject", r))[0].detail, "Reject Me");

  await http(`/admin/awards/${a}/approve`, { method: "POST" }); // second click
  assert.equal((await auditRows("award.approve", a)).length, 1, "no change, no second audit row");
  assert.equal((await http("/admin/awards/abc/approve", { method: "POST" })).status, 404, "bad id is a 404");
  assert.equal((await http("/admin/awards/99999999/approve", { method: "POST" })).status, 302);

  // Approved rows show to customers; rejected ones do not.
  const page = await http(`/books/${book.id}`, { user: null });
  assert.ok(page.text.includes("Approve Me") && !page.text.includes("Reject Me"));
});

test("the review page lists pending suggestions with counts and bulk-approves the selected ones", async () => {
  const book = await seedBook({ title: `Review ${tag()}` });
  const ids = [];
  for (const l of ["Bulk One", "Bulk Two", "Bulk Three"]) ids.push(await addAward(book.id, l, { source: "ai", status: "pending", url: "https://example.org/" + l.replace(" ", "") }));
  const page = await http("/admin/awards");
  assert.equal(page.status, 200);
  for (const l of ["Bulk One", "Bulk Two", "Bulk Three", book.title]) assert.ok(page.text.includes(l), l);
  assert.match(page.text, /Books checked for awards:/);
  assert.match(page.text, /AI web search is switched off/);
  assert.match(page.text, /href="https:\/\/example\.org\/BulkOne"/);

  const res = await http("/admin/awards/approve-bulk", { method: "POST", form: { ids: [ids[0], ids[2], "junk", "-5"] } });
  assert.equal(res.location, "/admin/awards?notice=awards-updated");
  const rows = await rowsOf(book.id);
  assert.deepEqual(rows.map((r) => r.status), ["approved", "pending", "approved"]);
  assert.equal((await auditRows("award.approve", ids[0])).length, 1);
  assert.equal((await auditRows("award.approve", ids[1])).length, 0);
  const after = await http("/admin/awards");
  assert.ok(!after.text.includes("Bulk One") && after.text.includes("Bulk Two"));
});

test("the review page shows today's AI usage against the cap when AI is on", async () => {
  process.env.ANTHROPIC_API_KEY = "k";
  process.env.AWARDS_AI = "1";
  process.env.AWARDS_AI_DAILY_MAX = "37";
  try {
    const page = await http("/admin/awards");
    assert.match(page.text, /AI web search today: <strong>\d+<\/strong> of <strong>37<\/strong>/);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AWARDS_AI;
    delete process.env.AWARDS_AI_DAILY_MAX;
  }
});

test("manual add parses (year), dedupes, shows at once; remove deletes manual rows only; both are audited", async () => {
  const book = await seedBook();
  const res = await http(`/admin/inventory/${book.id}/awards/add`, { method: "POST", form: { awards: "Booker Prize (2019), booker prize (2019), Costa Award, " } });
  assert.equal(res.location, `/admin/inventory/${book.id}?notice=awards-added`);
  const rows = await rowsOf(book.id);
  assert.deepEqual(rows.map((r) => [r.label, r.year, r.source, r.status]), [["Booker Prize", 2019, "manual", "verified"], ["Costa Award", null, "manual", "verified"]]);
  assert.equal((await auditRows("award.add", rows[0].id))[0].detail, "Booker Prize");
  assert.ok((await http(`/books/${book.id}`, { user: null })).text.includes("Booker Prize (2019), Costa Award"));

  await http(`/admin/inventory/${book.id}/awards/add`, { method: "POST", form: { awards: "Booker Prize (2019)" } }); // again: no duplicate
  assert.equal((await rowsOf(book.id)).length, 2);

  const wd = await addAward(book.id, "From Wikidata", { year: 2001 });
  assert.equal((await http(`/admin/awards/${wd}/remove`, { method: "POST" })).status, 404, "non-manual rows cannot be removed");
  assert.equal((await rowsOf(book.id)).length, 3);
  const rm = await http(`/admin/awards/${rows[1].id}/remove`, { method: "POST" });
  assert.equal(rm.location, `/admin/inventory/${book.id}?notice=awards-removed`);
  assert.equal((await rowsOf(book.id)).length, 2);
  assert.equal((await auditRows("award.remove", rows[1].id))[0].detail, "Costa Award");
  assert.equal((await http(`/admin/inventory/99999999/awards/add`, { method: "POST", form: { awards: "x" } })).status, 404);
});

test("a typed-in award replaces a rejected AI suggestion of the same name", async () => {
  const book = await seedBook();
  await addAward(book.id, "Edgar Award", { year: 2005, source: "ai", status: "rejected" });
  await http(`/admin/inventory/${book.id}/awards/add`, { method: "POST", form: { awards: "Edgar Award (2005)" } });
  const rows = await rowsOf(book.id);
  assert.deepEqual(rows.map((r) => [r.source, r.status]), [["manual", "verified"]]);
});

test("the book screen lists every row with source link, badges and buttons", async () => {
  const book = await seedBook();
  await addAward(book.id, "Pending One", { source: "ai", status: "pending", url: "https://example.org/pending" });
  await addAward(book.id, "Verified One", { year: 2000 });
  await addAward(book.id, "Manual One", { source: "manual" });
  await addAward(book.id, "Rejected One", { source: "ai", status: "rejected" });
  const { text } = await http(`/admin/inventory/${book.id}`);
  for (const s of ["Awards &amp; lists", "Pending One", "Verified One</strong> (2000)", "Manual One", "Rejected One", "Add awards (comma separated)", "Re-check now"]) assert.ok(text.includes(s), s);
  assert.match(text, /href="https:\/\/example\.org\/pending"/);
  assert.match(text, /status-pill pending">pending/);
  assert.match(text, /\/awards\/check/);
  assert.match(text, /Remove<\/button>/);
});

test("Re-check now runs the check, redirects with a notice, and the result shows up", async () => {
  const book = await seedBook();
  net.wikidata = [bind("Found By Recheck", 2003)];
  const res = await http(`/admin/inventory/${book.id}/awards/check`, { method: "POST" });
  assert.equal(res.location, `/admin/inventory/${book.id}?notice=awards-checked`);
  assert.deepEqual((await rowsOf(book.id)).map((r) => r.label), ["Found By Recheck"]);
  const page = await http(res.location);
  assert.match(page.text, /Awards check finished\./);
  assert.equal((await auditRows("award.check", book.id)).length, 1);
  assert.equal((await http(`/admin/inventory/${book.id}?notice=constructor`)).status, 200, "odd notice values are ignored");
});

// ------------------------------------------------------------------ intake

test("saving a new book returns at once while the awards check runs in the background", async () => {
  const isbn = isbn13();
  const title = `Intake ${tag()}`;
  net.wikidata = [bind("Intake Prize", 2022)];
  // Hold Wikidata "in flight": the stub will not answer until we open the gate.
  // The save can only return while the gate is closed if it does not wait for
  // the lookup, which is the claim — and unlike a stopwatch it cannot be
  // overrun by a slow machine.
  let openGate;
  net.wikidataGate = new Promise((resolve) => { openGate = resolve; });
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("the save waited for the awards lookup")), 15000).unref());
    const res = await Promise.race([http("/admin/inventory", {
      method: "POST",
      form: { title, author: "Intake Author", isbn, condition: "very_good", price: "5", status: "in_stock", description: "d", descriptionFr: "d", coverUrl: "https://example.org/c.jpg" },
    }), timeout]);
    assert.equal(res.status, 302);
    assert.match(res.location, /^\/admin\/inventory\/\d+$/);
    const bookId = Number(res.location.split("/").pop());
    assert.equal((await bookRow(bookId)).awards_checked_at, null, "not finished yet");
    assert.equal((await rowsOf(bookId)).length, 0, "no award recorded while the lookup is still in flight");
    openGate();
    // The award row is written before the book's check state is stamped, so
    // wait for the final state (the very last write), then assert on both.
    await waitFor(async () => (await bookRow(bookId)).awards_check_state === "ok", { timeoutMs: 10000, message: "background awards check" });
    assert.equal((await rowsOf(bookId)).length, 1);
    assert.equal((await rowsOf(bookId))[0].label, "Intake Prize");
  } finally {
    openGate(); // never leave the background check parked if an assertion failed
  }
});

test("a failing awards lookup never fails or loses the save", async () => {
  const title = `Intake Fail ${tag()}`;
  net.wikidata = "error";
  const res = await http("/admin/inventory", {
    method: "POST",
    form: { title, author: "A", isbn: isbn13(), condition: "very_good", price: "5", status: "in_stock", description: "d", descriptionFr: "d", coverUrl: "https://example.org/c.jpg" },
  });
  assert.equal(res.status, 302);
  const bookId = Number(res.location.split("/").pop());
  await waitFor(async () => (await bookRow(bookId)).awards_check_state === "error", { timeoutMs: 10000 });
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM book_copies WHERE book_id = $1", [bookId])).rows[0].n, 1);
});
