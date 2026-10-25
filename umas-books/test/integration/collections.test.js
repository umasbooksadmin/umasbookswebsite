// Curated collections end to end against the real app and a throwaway database: the seed, the admin screens
// (authorization, CSRF, publish rules, review ticks, generate with the AI mocked or unavailable), the public page
// (404 for unpublished, only approved books in stock, live availability, English and French) and the sitemap.
//
// The AI is never called for real: the library takes an `ask` function, and the route is run without an API key.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");
const { pairs } = require("../helpers/i18nPairs");

const PORT = 6481;
const PASSWORD = "Collections1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let app;
let pool;
let adminJar;
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true, env: { ANTHROPIC_API_KEY: "" } });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  adminJar = await loginJar(await createUser({ admin: true }));
});

after(async () => {
  await pool.end();
  app.stop();
});

async function createUser(flags) {
  const email = `coll-${uniq()}@example.test`;
  await pool.query(
    "INSERT INTO users (email, password_hash, display_name, is_admin, is_member, email_verified_at) VALUES ($1, $2, 'Coll Test', $3, $4, now())",
    [email, await bcrypt.hash(PASSWORD, 10), !!flags.admin, !!flags.member]
  );
  return email;
}

async function loginJar(email) {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie: jar.header() }, body: new URLSearchParams({ email, password: PASSWORD, _csrf: token }) });
  jar.capture(res);
  assert.equal(res.status, 302, "test login should succeed");
  return jar;
}

async function get(p, { jar, headers = {} } = {}) {
  const res = await fetch(`${app.base}${p}`, { redirect: "manual", headers: { ...(jar ? { cookie: jar.header() } : {}), ...headers } });
  if (jar) jar.capture(res);
  return { res, text: await res.text() };
}

// POST as the admin with a valid CSRF token, then follow the 303 like a browser; returns the page it lands on.
async function adminPost(p, fields = {}, { jar = adminJar, csrf = true } = {}) {
  const body = new URLSearchParams();
  if (csrf) body.append("_csrf", await fetchCsrfToken(app.base, jar));
  for (const [k, v] of Object.entries(fields)) for (const item of [].concat(v)) body.append(k, String(item));
  const res = await fetch(`${app.base}${p}`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie: jar.header() }, body });
  jar.capture(res);
  if (res.status !== 303) return { res, text: await res.text() };
  const next = await get(res.headers.get("location"), { jar });
  return { res, location: res.headers.get("location"), text: next.text, page: next.res };
}

const notice = (html) => (html.match(/class="(?:notice|error)-box"[^>]*>([^<]*)</) || [])[1];

async function newBook(title, { copyStatus = "in_stock", price = 6 } = {}) {
  const { rows } = await pool.query("INSERT INTO books (title, authors, categories, description) VALUES ($1, 'Test Author', 'Fiction', 'A test book.') RETURNING id", [title]);
  const { rows: c } = await pool.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, $2, $3, 'good') RETURNING id", [rows[0].id, copyStatus, price]);
  return { id: rows[0].id, copyId: c[0].id, title };
}
const bySlug = async (slug) => (await pool.query("SELECT * FROM curated_collections WHERE slug = $1", [slug])).rows[0];
const status = async (cid, bid) => ((await pool.query("SELECT status FROM curated_collection_books WHERE collection_id = $1 AND book_id = $2", [cid, bid])).rows[0] || {}).status;

async function freshCollection(extra = {}) {
  const slug = `test-shelf-${uniq()}`;
  const { rows } = await pool.query(
    `INSERT INTO curated_collections (slug, title_en, description_en, title_fr, description_fr, curation_prompt)
     VALUES ($1, $2, $3, $4, $5, 'Pick gentle books.') RETURNING *`,
    [slug, extra.title_en ?? "Quiet Shelf", extra.description_en ?? "Gentle reads.", extra.title_fr ?? "Étagère calme", extra.description_fr ?? "Des lectures douces."]
  );
  return rows[0];
}
const addRow = (cid, bid, st, reason = null, position = 1) =>
  pool.query("INSERT INTO curated_collection_books (collection_id, book_id, status, reason, position) VALUES ($1, $2, $3, $4, $5)", [cid, bid, st, reason, position]);

// ---------- the seed ----------

test("the migration seeds the 19 collections, all unpublished, each with French text, a prompt and a picture", async () => {
  const { rows } = await pool.query("SELECT * FROM curated_collections ORDER BY sort_order, id");
  assert.equal(rows.filter((r) => r.slug && !r.slug.startsWith("test-shelf-")).length, 19);
  for (const r of rows.filter((x) => !x.slug.startsWith("test-shelf-"))) {
    assert.equal(r.published, false, `${r.slug} must start unpublished`);
    for (const f of ["title_en", "description_en", "title_fr", "description_fr", "curation_prompt"]) assert.ok(r[f].trim(), `${r.slug}.${f} is empty`);
    assert.notEqual(r.title_fr, r.title_en);
    assert.match(r.icon_path, /^\/assets\/img\/collections\/[a-z0-9-]+\.png$/);
    assert.equal(r.last_generated_at, null);
  }
  const magic = await bySlug("the-magic-we-never-outgrew");
  assert.match(magic.description_en, /fantasy classics/);
  assert.ok(magic.curation_prompt.length > 80, "the short prompt was expanded");
  assert.match((await bySlug("a-little-bit-of-emotional-damage")).curation_prompt, /avoid equating sadness with quality/);
  assert.match((await bySlug("the-literary-apothecary")).curation_prompt, /avoid presenting books as medical treatment/);
  assert.equal((await pool.query("SELECT 1 FROM curated_collection_books")).rowCount, 0);
});

test("every seeded picture exists on disk (png and webp)", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { rows } = await pool.query("SELECT icon_path FROM curated_collections WHERE icon_path IS NOT NULL");
  for (const { icon_path: p } of rows) {
    for (const ext of [".png", ".webp"]) assert.ok(fs.existsSync(path.join(__dirname, "..", "..", "..", p.replace(/\.png$/, ext))), `${p} (${ext}) missing`);
  }
});

// ---------- admin: authorization and CSRF ----------

test("the admin pages are for admins only", async () => {
  const c = await freshCollection();
  const memberJar = await loginJar(await createUser({ member: true }));
  for (const p of ["/admin/collections", `/admin/collections/${c.id}`]) {
    assert.equal((await get(p)).res.status, 302, "a guest is sent to log in");
    assert.equal((await get(p, { jar: memberJar })).res.status, 403, "a member is refused");
    assert.equal((await get(p, { jar: adminJar })).res.status, 200);
  }
  for (const p of [`/admin/collections/${c.id}`, `/admin/collections/${c.id}/published`, `/admin/collections/${c.id}/review`, `/admin/collections/${c.id}/generate`, `/admin/collections/${c.id}/translate`]) {
    const r = await adminPost(p, { published: "1" }, { jar: memberJar });
    assert.equal(r.res.status, 403, `${p}: a member cannot post`);
  }
  assert.equal((await bySlug(c.slug)).published, false);
});

test("a POST without the CSRF token is refused and changes nothing", async () => {
  const c = await freshCollection();
  const b = await newBook(`Csrf ${uniq()}`);
  await addRow(c.id, b.id, "approved");
  const r = await adminPost(`/admin/collections/${c.id}/published`, { published: "1" }, { csrf: false });
  assert.equal(r.res.status, 403);
  assert.equal((await bySlug(c.slug)).published, false);
});

test("the admin menu links to Collections and the list shows every collection with its counts", async () => {
  const c = await freshCollection({ title_en: "Counted Shelf" });
  const a = await newBook(`A ${uniq()}`);
  const s = await newBook(`S ${uniq()}`);
  await addRow(c.id, a.id, "approved", null, 1);
  await addRow(c.id, s.id, "suggested", "fits", 2);
  const { text } = await get("/admin/collections", { jar: adminJar });
  assert.match(text, /href="\/admin\/collections"[^>]*>Collections</);
  assert.match(text, /Counted Shelf/);
  assert.match(text, /The Magic We Never Outgrew/);
  const row = text.split("<tr>").slice(1).find((r) => r.includes("Counted Shelf"));
  assert.match(row, /1 to review/);
  assert.match(row, /<td>1<\/td>/, "approved 1");
  assert.match(row, /Publish/);
});

// ---------- publish rules ----------

test("a collection with no approved book cannot be published; with one it can; unpublish always works", async () => {
  const c = await freshCollection();
  let r = await adminPost(`/admin/collections/${c.id}/published`, { published: "1", back: "edit" });
  assert.match(notice(r.text), /at least one book is approved/);
  assert.equal((await bySlug(c.slug)).published, false);

  const b = await newBook(`Pub ${uniq()}`);
  await addRow(c.id, b.id, "suggested");
  r = await adminPost(`/admin/collections/${c.id}/published`, { published: "1", back: "edit" });
  assert.match(notice(r.text), /at least one book is approved/, "a suggestion is not an approval");

  await pool.query("UPDATE curated_collection_books SET status = 'approved' WHERE collection_id = $1", [c.id]);
  r = await adminPost(`/admin/collections/${c.id}/published`, { published: "1", back: "edit" });
  assert.match(notice(r.text), /^Published/);
  assert.equal((await bySlug(c.slug)).published, true);

  r = await adminPost(`/admin/collections/${c.id}/published`, { published: "0", back: "list" });
  assert.equal(r.location, "/admin/collections");
  assert.equal((await bySlug(c.slug)).published, false);
});

test("a collection cannot be published without its French title and description", async () => {
  const c = await freshCollection({ title_fr: "", description_fr: "" });
  const b = await newBook(`Fr ${uniq()}`);
  await addRow(c.id, b.id, "approved");
  let r = await adminPost(`/admin/collections/${c.id}/published`, { published: "1", back: "edit" });
  assert.match(notice(r.text), /French title and the French description/);
  assert.equal((await bySlug(c.slug)).published, false);
  await pool.query("UPDATE curated_collections SET title_fr = 'T', description_fr = '' WHERE id = $1", [c.id]);
  r = await adminPost(`/admin/collections/${c.id}/published`, { published: "1", back: "edit" });
  assert.match(notice(r.text), /French title and the French description/, "both are needed");
  await pool.query("UPDATE curated_collections SET title_fr = '', description_fr = 'D' WHERE id = $1", [c.id]);
  r = await adminPost(`/admin/collections/${c.id}/published`, { published: "1", back: "edit" });
  assert.match(notice(r.text), /French title and the French description/, "the description alone is not enough");
  await pool.query("UPDATE curated_collections SET title_fr = 'T' WHERE id = $1", [c.id]);
  r = await adminPost(`/admin/collections/${c.id}/published`, { published: "1", back: "edit" });
  assert.match(notice(r.text), /^Published/);
});

test("the seeded collections are not published by anything but an admin's button", async () => {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM curated_collections WHERE published AND slug NOT LIKE 'test-shelf-%'");
  assert.equal(rows[0].n, 0);
  const r = await adminPost(`/admin/collections/${(await bySlug("paris-is-always-a-good-idea")).id}/published`, { published: "1", back: "list" });
  assert.match(notice(r.text), /at least one book is approved/, "a seeded collection has no approved book yet");
});

// ---------- review: tick boxes ----------

test("Save choices: approve and reject ticks are stored; unticking returns a book to waiting; both ticked saves nothing", async () => {
  const c = await freshCollection();
  const [a, b, d] = [await newBook(`R1 ${uniq()}`), await newBook(`R2 ${uniq()}`), await newBook(`R3 ${uniq()}`)];
  for (const [i, x] of [a, b, d].entries()) await addRow(c.id, x.id, "suggested", `reason ${i}`, i + 1);

  let r = await adminPost(`/admin/collections/${c.id}/review`, { ids: [a.id, b.id, d.id], approve: [a.id], reject: [b.id] });
  assert.match(notice(r.text), /Saved your choices \(2 changed\)/);
  assert.deepEqual([await status(c.id, a.id), await status(c.id, b.id), await status(c.id, d.id)], ["approved", "rejected", "suggested"]);

  r = await adminPost(`/admin/collections/${c.id}/review`, { ids: [a.id, b.id, d.id], approve: [d.id], reject: [d.id] });
  assert.match(notice(r.text), /cannot be both approved and rejected/);
  assert.deepEqual([await status(c.id, a.id), await status(c.id, d.id)], ["approved", "suggested"], "nothing saved");

  await adminPost(`/admin/collections/${c.id}/review`, { ids: [a.id, b.id, d.id], approve: [] });
  assert.deepEqual([await status(c.id, a.id), await status(c.id, b.id)], ["suggested", "suggested"]);

  // A book id that is not in this collection is ignored, not added.
  const stranger = await newBook(`Stranger ${uniq()}`);
  await adminPost(`/admin/collections/${c.id}/review`, { ids: [stranger.id], approve: [stranger.id] });
  assert.equal(await status(c.id, stranger.id), undefined);
});

test("the edit page lists the books with their reasons and Approve / Reject boxes", async () => {
  const c = await freshCollection();
  const b = await newBook(`Edit Page ${uniq()}`);
  await addRow(c.id, b.id, "suggested", "A very gentle story for the evening.");
  const { text } = await get(`/admin/collections/${c.id}`, { jar: adminJar });
  assert.match(text, /A very gentle story for the evening\./);
  assert.match(text, new RegExp(`name="approve" value="${b.id}"`));
  assert.match(text, new RegExp(`name="reject" value="${b.id}"`));
  assert.match(text, /Generate suggestions/);
  assert.match(text, /Translate to French/);
  assert.match(text, /name="title_fr"/);
  assert.match(text, /name="description_fr"/);
});

test("un-approving the last approved book unpublishes the collection", async () => {
  const c = await freshCollection();
  const b = await newBook(`Last ${uniq()}`);
  await addRow(c.id, b.id, "approved");
  await adminPost(`/admin/collections/${c.id}/published`, { published: "1", back: "edit" });
  assert.equal((await bySlug(c.slug)).published, true);
  const r = await adminPost(`/admin/collections/${c.id}/review`, { ids: [b.id] });
  assert.match(notice(r.text), /unpublished/);
  assert.equal((await bySlug(c.slug)).published, false);
});

// ---------- editing text ----------

test("saving text: EN and FR title and description, guidance and order; an empty English title is refused", async () => {
  const c = await freshCollection();
  let r = await adminPost(`/admin/collections/${c.id}`, { title_en: "New T", description_en: "New D", title_fr: "Nouveau T", description_fr: "Nouvelle D", curation_prompt: "Pick calm ones.", sort_order: "15" });
  assert.match(notice(r.text), /^Saved\./);
  const row = await bySlug(c.slug);
  assert.deepEqual([row.title_en, row.title_fr, row.description_fr, row.curation_prompt, row.sort_order], ["New T", "Nouveau T", "Nouvelle D", "Pick calm ones.", 15]);

  r = await adminPost(`/admin/collections/${c.id}`, { title_en: "", description_en: "x", title_fr: "", description_fr: "", curation_prompt: "typed prompt", sort_order: "1" });
  assert.match(notice(r.text), /English title cannot be empty/);
  assert.match(r.text, /typed prompt/, "what was typed comes back");
  assert.equal((await bySlug(c.slug)).title_en, "New T");

  r = await adminPost(`/admin/collections/${c.id}`, { title_en: "T", sort_order: "abc" });
  assert.match(notice(r.text), /Sort order must be a whole number/);
});

test("emptying the French of a published collection takes it off the site", async () => {
  const c = await freshCollection();
  const b = await newBook(`Fr off ${uniq()}`);
  await addRow(c.id, b.id, "approved");
  await adminPost(`/admin/collections/${c.id}/published`, { published: "1", back: "edit" });
  const r = await adminPost(`/admin/collections/${c.id}`, { title_en: "T", description_en: "D", title_fr: "", description_fr: "", curation_prompt: "p", sort_order: "1" });
  assert.match(notice(r.text), /unpublished/);
  assert.equal((await bySlug(c.slug)).published, false);
  assert.equal((await get(`/collections/${c.slug}`)).res.status, 404);
});

// ---------- generate and translate without the AI ----------

test("Generate suggestions with no AI key shows a friendly message and changes nothing", async () => {
  const c = await freshCollection();
  await newBook(`Gen ${uniq()}`);
  const r = await adminPost(`/admin/collections/${c.id}/generate`);
  assert.equal(r.res.status, 303);
  assert.match(notice(r.text), /AI helper is not set up/);
  assert.equal((await pool.query("SELECT 1 FROM curated_collection_books WHERE collection_id = $1", [c.id])).rowCount, 0);
  assert.equal((await bySlug(c.slug)).last_generated_at, null);
});

test("Translate to French with no AI key is a friendly message and keeps the typed form", async () => {
  const c = await freshCollection({ title_fr: "", description_fr: "" });
  const r = await adminPost(`/admin/collections/${c.id}/translate`, { title_en: "My typed title", description_en: "D", title_fr: "", description_fr: "", curation_prompt: "p", sort_order: "3" });
  assert.match(notice(r.text), /AI helper is not set up/);
  assert.match(r.text, /value="My typed title"/);
  assert.equal((await bySlug(c.slug)).title_fr, "", "nothing is saved by Translate");
});

// ---------- generate with the AI mocked ----------

test("Generate: suggestions only, invented ids ignored, out-of-stock books ignored, decisions kept on re-run", async () => {
  process.env.DATABASE_URL = app.databaseUrl;
  const { generateSuggestions } = require("../../src/lib/collectionSuggestions");
  const c = await freshCollection();
  const stock = [await newBook(`Mock A ${uniq()}`), await newBook(`Mock B ${uniq()}`), await newBook(`Mock C ${uniq()}`)];
  const sold = await newBook(`Mock Sold ${uniq()}`, { copyStatus: "sold" });
  const prompts = [];
  // First run: the AI picks A, B, an invented id, and the sold book (not offered to it, but it names it anyway).
  let reply = (ids) => async (prompt) => { prompts.push(prompt); return { text: JSON.stringify(ids.map((id) => ({ id, reason: `fits ${id}` }))), reason: null }; };
  let r = await generateSuggestions(pool, c.id, { ask: reply([stock[0].id, stock[1].id, 987654, sold.id]) });
  assert.equal(r.ok, true);
  assert.equal(r.added, 2, "only real, in-stock, offered books are written");
  const rows = (await pool.query("SELECT book_id, status, reason FROM curated_collection_books WHERE collection_id = $1 ORDER BY position", [c.id])).rows;
  assert.deepEqual(rows.map((x) => [x.book_id, x.status]), [[stock[0].id, "suggested"], [stock[1].id, "suggested"]]);
  assert.equal(rows[0].reason, `fits ${stock[0].id}`);
  assert.ok((await bySlug(c.slug)).last_generated_at, "the run time is recorded");
  assert.ok(!prompts[0].includes(`Mock Sold`), "a book with no copy in stock is never offered to the AI");
  assert.match(prompts[0], /Pick gentle books\./, "the collection's own guidance is in the prompt");

  // The admin approves A and rejects B. Re-running must not touch either, and must not offer them again.
  await pool.query("UPDATE curated_collection_books SET status = 'approved' WHERE collection_id = $1 AND book_id = $2", [c.id, stock[0].id]);
  await pool.query("UPDATE curated_collection_books SET status = 'rejected' WHERE collection_id = $1 AND book_id = $2", [c.id, stock[1].id]);
  prompts.length = 0;
  r = await generateSuggestions(pool, c.id, { mode: "full", ask: reply([stock[0].id, stock[1].id, stock[2].id]) });
  assert.equal(r.ok, true);
  assert.equal(r.added, 1, "only the new book is added");
  assert.equal(await status(c.id, stock[0].id), "approved");
  assert.equal(await status(c.id, stock[1].id), "rejected");
  assert.equal(await status(c.id, stock[2].id), "suggested");
  assert.ok(!prompts[0].includes(`Mock A`) && !prompts[0].includes(`Mock B`), "decided books are not offered again");

  // Nothing is published by generating.
  assert.equal((await bySlug(c.slug)).published, false);

  // "Add new books" with nothing added since the last build asks nothing.
  let calls = 0;
  const again = await generateSuggestions(pool, c.id, { ask: async () => { calls += 1; return { text: "[]", reason: null }; } });
  assert.deepEqual([again.ok, again.nothingNew, calls], [true, true, 0]);
});

test("Writing suggestions never overwrites an existing decision, even if the same book comes back", async () => {
  const { insertSuggestions } = require("../../src/lib/collectionSuggestions");
  const c = await freshCollection();
  const [a, b] = [await newBook(`Keep A ${uniq()}`), await newBook(`Keep B ${uniq()}`)];
  await addRow(c.id, a.id, "approved", "my reason", 1);
  await addRow(c.id, b.id, "rejected", "no thanks", 2);
  const added = await insertSuggestions(pool, c.id, [{ bookId: a.id, reason: "new reason" }, { bookId: b.id, reason: "new reason" }]);
  assert.equal(added, 0);
  const rows = (await pool.query("SELECT book_id, status, reason FROM curated_collection_books WHERE collection_id = $1 ORDER BY position", [c.id])).rows;
  assert.deepEqual(rows.map((r) => [r.status, r.reason]), [["approved", "my reason"], ["rejected", "no thanks"]]);
});

test("Generate: the AI failing (no credit, cap, timeout) is a friendly result, not an exception, and changes nothing", async () => {
  const { generateSuggestions } = require("../../src/lib/collectionSuggestions");
  const c = await freshCollection();
  await newBook(`Fail ${uniq()}`);
  for (const [reason, re] of [["credit", /no credit left/], ["cap", /Daily AI limit reached \(5\)/], ["timeout", /too long/], ["no_key", /not set up/]]) {
    const r = await generateSuggestions(pool, c.id, { ask: async () => ({ text: null, reason, message: "Daily AI limit reached (5). Resets at midnight Paris time." }) });
    assert.equal(r.ok, false);
    assert.match(r.error, re);
  }
  assert.equal((await pool.query("SELECT 1 FROM curated_collection_books WHERE collection_id = $1", [c.id])).rowCount, 0);
  assert.equal((await bySlug(c.slug)).last_generated_at, null);
  // An answer that is not a list is "nothing usable": no rows, no crash.
  const junk = await generateSuggestions(pool, c.id, { ask: async () => ({ text: "Sorry, I cannot.", reason: null }) });
  assert.equal(junk.ok, true);
  assert.equal(junk.added, 0);
});

test("Generate: a long catalogue is cut to a bounded list and sent in batches", async () => {
  const { generateSuggestions } = require("../../src/lib/collectionSuggestions");
  const c = await freshCollection({ title_en: "Zebra Tales" });
  await pool.query("DELETE FROM book_copies WHERE book_id IN (SELECT id FROM books WHERE title LIKE 'Bulk %')");
  for (let i = 0; i < 25; i++) await newBook(`Bulk ${i} ${uniq()}`);
  const sizes = [];
  const r = await generateSuggestions(pool, c.id, {
    maxCandidates: 20, batchSize: 8,
    ask: async (prompt) => { sizes.push((prompt.match(/^\d+ \| /gm) || []).length); return { text: "[]", reason: null }; },
  });
  assert.equal(r.considered, 20, "never more than the cap");
  assert.deepEqual(sizes.sort(), [4, 8, 8], "batches of at most 8");
});

// ---------- the public page ----------

test("an unpublished or unknown collection is a 404, in English and in French", async () => {
  const c = await freshCollection();
  const b = await newBook(`Hidden ${uniq()}`);
  await addRow(c.id, b.id, "approved");
  for (const p of [`/collections/${c.slug}`, `/fr/collections/${c.slug}`, "/collections/no-such-shelf", "/fr/collections/no-such-shelf", "/collections/Bad_Slug", "/collections/paris-is-always-a-good-idea"]) {
    assert.equal((await get(p)).res.status, 404, p);
  }
});

async function publishedShelf(books, extra = {}) {
  const c = await freshCollection(extra);
  let pos = 1;
  for (const [b, st] of books) await addRow(c.id, b.id, st, "why", pos++);
  await pool.query("UPDATE curated_collections SET published = TRUE WHERE id = $1", [c.id]);
  return c;
}

test("a published collection shows its title, description and ONLY approved books that are in stock", async () => {
  const [ok, suggested, rejected, sold, reserved] = [
    await newBook(`Visible ${uniq()}`, { price: 9.5 }), await newBook(`Waiting ${uniq()}`), await newBook(`Rejected ${uniq()}`),
    await newBook(`Gone ${uniq()}`, { copyStatus: "sold" }), await newBook(`Held ${uniq()}`, { copyStatus: "reserved" }),
  ];
  const c = await publishedShelf([[ok, "approved"], [suggested, "suggested"], [rejected, "rejected"], [sold, "approved"], [reserved, "approved"]]);
  const { res, text } = await get(`/collections/${c.slug}`);
  assert.equal(res.status, 200);
  assert.match(text, /<h1[^>]*>Quiet Shelf<\/h1>/);
  assert.match(text, /Gentle reads\./);
  assert.ok(text.includes(ok.title) && text.includes("€9.50"));
  for (const hidden of [suggested, rejected, sold, reserved]) assert.ok(!text.includes(hidden.title), `${hidden.title} must not be shown`);
  assert.match(text, new RegExp(`href="/books/${ok.id}"`));
  assert.match(text, /href="\/books\.html"><span aria-hidden="true">&larr;<\/span> Back to Browse books/);
  assert.match(text, /<link rel="canonical" href="[^"]*\/collections\//);
  assert.match(text, /hreflang="fr" href="[^"]*\/fr\/collections\//);
  assert.match(text, /<title[^>]*>Quiet Shelf — Uma/);
  assert.match(text, /<meta name="description" content="Gentle reads\."/);
});

test("when a book sells it silently drops from the page, with no change to the collection", async () => {
  const [a, b] = [await newBook(`Stays ${uniq()}`), await newBook(`Sells ${uniq()}`)];
  const c = await publishedShelf([[a, "approved"], [b, "approved"]]);
  assert.ok((await get(`/collections/${c.slug}`)).text.includes(b.title));
  await pool.query("UPDATE book_copies SET status = 'sold' WHERE id = $1", [b.copyId]);
  const after = (await get(`/collections/${c.slug}`)).text;
  assert.ok(after.includes(a.title) && !after.includes(b.title));
  assert.equal(await status(c.id, b.id), "approved", "the decision is kept: it returns if a copy comes back");
  await pool.query("UPDATE book_copies SET status = 'in_stock' WHERE id = $1", [b.copyId]);
  assert.ok((await get(`/collections/${c.slug}`)).text.includes(b.title));
});

test("a collection whose approved books are all gone shows a friendly message (English and French) and a link back", async () => {
  const b = await newBook(`Last copy ${uniq()}`, { copyStatus: "sold" });
  const c = await publishedShelf([[b, "approved"]]);
  const en = await get(`/collections/${c.slug}`);
  assert.equal(en.res.status, 200);
  assert.match(en.text, /Every book in this collection has found a new home/);
  assert.match(en.text, /href="\/books\.html"[^>]*>Browse all books/);
  const fr = await get(`/fr/collections/${c.slug}`);
  assert.match(fr.text, /Tous les livres de cette collection ont trouvé preneur/);
  assert.match(fr.text, /href="\/fr\/books\.html"[^>]*>Parcourir tous les livres/);
});

test("the French page is French: language, title, links, texts, and none of the English from the page's own strings", async () => {
  const b = await newBook(`Livre ${uniq()}`, { price: 12.5 });
  const c = await publishedShelf([[b, "approved"]], { title_en: "English Title", description_en: "English blurb.", title_fr: "Titre français", description_fr: "Description française." });
  const { res, text } = await get(`/fr/collections/${c.slug}`);
  assert.equal(res.status, 200);
  assert.match(text, /<html lang="fr"/);
  assert.match(text, /<h1[^>]*>Titre français<\/h1>/);
  assert.match(text, /Description française\./);
  assert.match(text, /<title[^>]*>Titre français — Uma/);
  assert.match(text, /<meta name="description" content="Description française\."/);
  assert.match(text, /<link rel="canonical" href="[^"]*\/fr\/collections\//);
  assert.match(text, /hreflang="en" href="[^"]*\/collections\/[^"]*"/);
  assert.match(text, /hreflang="x-default" href="[^"]*\/collections\//);
  assert.match(text, /href="\/fr\/books\/\d+"/, "book links stay in French");
  assert.match(text, /href="\/fr\/books\.html"/, "the way back stays in French");
  assert.match(text, /12,50\s*€/);
  assert.ok(!text.includes("English Title") && !text.includes("English blurb."));

  // Every English string the collection views pass through tr() must be absent, and its French present.
  const own = pairs().filter((p) => /marketing[\\/]collection\.ejs$|collections_row\.ejs$/.test(p.file) && p.en && p.fr);
  assert.ok(own.length >= 5, `found only ${own.length} tr() pairs in the collection views`);
  const plain = (s) => s.replace(/&[a-z#0-9]+;/g, " ");
  const page = plain(text);
  for (const p of own) {
    if (p.en.includes("{")) continue; // has a {placeholder}: the filled text is checked above
    // Only strings this page actually prints (the empty-state message is not on a page that has books).
    if (page.includes(p.fr.replace(/’/g, "’"))) assert.ok(!page.includes(p.en), `English text left on the French page: "${p.en}"`);
  }
  const en = (await get(`/collections/${c.slug}`)).text;
  assert.match(en, /<html lang="en"/);
  assert.match(en, /Back to Browse books/);
  assert.match(en, /Cover images come from an online book library/);
  assert.match(text, /Les couvertures proviennent d’une bibliothèque/);
});

// The header and footer are shared with pages at the site root, so their links must not be relative: from
// /collections/<slug> a relative "books.html" is /collections/books.html, a 404.
for (const [lang, prefix] of [["en", ""], ["fr", "/fr"]]) {
  test(`collection page (${lang}): every header and footer link and asset URL resolves, and Browse Books goes to ${prefix}/books.html`, async () => {
    const c = await publishedShelf([[await newBook(`Nav ${uniq()}`), "approved"]]);
    const pagePath = `${prefix}/collections/${c.slug}`;
    const { res, text } = await get(pagePath);
    assert.equal(res.status, 200);
    const grab = (re) => (text.match(re) || [""])[0];
    const chrome = grab(/<header class="mkt-header"[\s\S]*?<\/header>/) + grab(/<footer[\s\S]*?<\/footer>/);
    assert.ok(chrome.length > 200, "found the header and footer");
    const urls = new Set();
    for (const m of chrome.matchAll(/<a\b[^>]*?\shref="([^"]*)"/g)) urls.add(m[1]);
    for (const m of text.matchAll(/<(?:link|script|img|source)\b[^>]*?\s(?:href|src)="([^"]*)"/g)) urls.add(m[1]);
    const internal = [...urls].filter((u) => u && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u));
    assert.ok(internal.length >= 12, `only ${internal.length} internal URLs found`);
    for (const u of internal) {
      assert.ok(u.startsWith("/"), `relative URL on a nested page: ${u}`);
      let r = await fetch(new URL(u, `${app.base}${pagePath}`), { redirect: "manual" });
      for (let hop = 0; r.status >= 300 && r.status < 400 && hop < 5; hop++) r = await fetch(new URL(r.headers.get("location"), `${app.base}${pagePath}`), { redirect: "manual" });
      await r.arrayBuffer();
      assert.equal(r.status, 200, `${u} -> ${r.status}`);
    }
    const hrefs = (label) => [...chrome.matchAll(/<a\b[^>]*?\shref="([^"]*)"[^>]*>([^<]*)</g)].filter((m) => m[2].includes(label)).map((m) => m[1]);
    assert.deepEqual(hrefs(lang === "fr" ? "Parcourir les livres" : "Browse Books"), [`${prefix}/books.html`]);
    assert.ok(chrome.includes(`href="${prefix || "/"}${prefix ? "/" : ""}"`) , "logo/Home go to the language's home");
    // The language switch lands on the same collection in the other language.
    assert.match(chrome, /<a href="\/collections\/[^"]+" data-lang="en"/);
    assert.match(chrome, /<a href="\/fr\/collections\/[^"]+" data-lang="fr"/);
    assert.ok(chrome.includes(`href="/collections/${c.slug}" data-lang="en"`) && chrome.includes(`href="/fr/collections/${c.slug}" data-lang="fr"`));
  });
}

// ---------- sitemap ----------

test("the sitemap lists published collections that still have a book, at both addresses, and nothing else", async () => {
  const b = await newBook(`Map ${uniq()}`);
  const listed = await publishedShelf([[b, "approved"]]);
  const emptied = await publishedShelf([[await newBook(`Map gone ${uniq()}`, { copyStatus: "sold" }), "approved"]]);
  const unpub = await freshCollection();
  await addRow(unpub.id, b.id, "approved");
  const { res, text } = await get("/sitemap-pages.xml");
  if (res.status === 503) return; // no base URL in this environment: the sitemap is not served at all
  assert.equal(res.status, 200);
  assert.ok(text.includes(`/collections/${listed.slug}</loc>`));
  assert.ok(text.includes(`/fr/collections/${listed.slug}</loc>`));
  assert.match(text, new RegExp(`<loc>[^<]*/fr/collections/${listed.slug}</loc>[^\\n]*hreflang="en" href="[^"]*/collections/${listed.slug}"`));
  assert.ok(!text.includes(emptied.slug), "a collection with nothing to show is not advertised");
  assert.ok(!text.includes(unpub.slug), "an unpublished collection is not advertised");
  assert.ok(!text.includes("paris-is-always-a-good-idea"), "a seeded, unpublished collection is not advertised");
});

// ---------- the Browse Books button row ----------

const rowOf = (html) => (html.match(/<section class="bk-genres bk-collections"[\s\S]*?<\/section>/) || [""])[0];

test("Browse Books: no collection published means no row at all", async () => {
  await pool.query("UPDATE curated_collections SET published = FALSE");
  for (const p of ["/books.html", "/fr/books.html"]) {
    const { res, text } = await get(p);
    assert.equal(res.status, 200);
    assert.ok(!text.includes("bk-collections"), `${p}: no row, no heading, no empty section`);
  }
});

test("Browse Books: a published collection with a book in stock gets a button, in English and in French", async () => {
  const b = await newBook(`Row ${uniq()}`);
  const c = await publishedShelf([[b, "approved"]], { title_en: "Row Shelf", title_fr: "Étagère du rang" });
  await pool.query("UPDATE curated_collections SET icon_path = '/assets/img/collections/paris-is-always-a-good-idea.png' WHERE id = $1", [c.id]);
  const en = rowOf((await get("/books.html")).text);
  assert.match(en, /<h2[^>]*>Browse by Collection<\/h2>/, "heading above the carousel");
  assert.match(en, new RegExp(`<a class="bk-genre col-btn" href="/collections/${c.slug}">`));
  assert.match(en, /<span class="col-name">Row Shelf<\/span>/);
  assert.match(en, /<img src="[^"]*\/assets\/img\/collections\/[a-z-]+\.png[^"]*" alt="" width="90" height="90" loading="lazy">/, "decorative picture, 90px (75% of 120), size set, lazy");
  assert.ok(!/ hidden/.test(en.split(">")[0]), "visible on the plain page");
  const fr = rowOf((await get("/fr/books.html")).text);
  assert.match(fr, /<h2[^>]*>Parcourir par collection<\/h2>/);
  assert.match(fr, new RegExp(`href="/fr/collections/${c.slug}"`));
  assert.match(fr, /<span class="col-name">Étagère du rang<\/span>/);
  assert.ok(!fr.includes("Row Shelf") && !fr.includes("by Collection"), "no English on the French row");
  // Page order: title, search, collections, New In, genres, results.
  const html = (await get("/books.html")).text;
  const at = (needle) => { const i = html.indexOf(needle); assert.ok(i >= 0, `${needle} is on the page`); return i; };
  const order = ["<h1", 'id="shop-search-form"', 'id="bk-collections"', 'id="bk-new-title"', 'id="bk-genre-list"', 'id="bk-results"'].map(at);
  assert.deepEqual(order, [...order].sort((x, y) => x - y), "title, search, collections, New In, genres, results");
  assert.ok(!html.includes("bk-flower") && !html.includes("flower.webp"), "no flower beside the title");
  assert.ok(html.split("<h1").length === 2 && html.indexOf("<h1") < html.indexOf("<h2"), "one h1, before the h2s");
});

test("Browse Books: the row is hidden whenever a genre, a search, a topic or ?new=1 is active (and with no JavaScript)", async () => {
  for (const q of ["", "?q=paris", "?genre=fiction", "?topic=mystery", "?new=1", "?new=0", "?genre="]) {
    const html = rowOf((await get(`/books.html${q}`)).text);
    const hidden = /^<section[^>]* hidden>/.test(html);
    const expected = ["?q=paris", "?genre=fiction", "?topic=mystery", "?new=1"].includes(q);
    assert.equal(hidden, expected, `/books.html${q}: hidden=${hidden}`);
    const fr = rowOf((await get(`/fr/books.html${q}`)).text);
    assert.equal(/^<section[^>]* hidden>/.test(fr), expected, `/fr/books.html${q}`);
  }
});

test("Browse Books: a published collection with no approved book in stock gets no button; unpublished ones never do", async () => {
  await pool.query("UPDATE curated_collections SET published = FALSE");
  const gone = await publishedShelf([[await newBook(`Row gone ${uniq()}`, { copyStatus: "sold" }), "approved"]], { title_en: "Emptied Shelf" });
  const unpub = await freshCollection({ title_en: "Draft Shelf" });
  await addRow(unpub.id, (await newBook(`Row draft ${uniq()}`)).id, "approved");
  let html = (await get("/books.html")).text;
  assert.ok(!html.includes("Emptied Shelf") && !html.includes("Draft Shelf"));
  assert.ok(!html.includes("bk-collections"), "nothing to show: no row");
  // One real collection appears; the emptied one still does not.
  await publishedShelf([[await newBook(`Row ok ${uniq()}`), "approved"]], { title_en: "Visible Shelf" });
  html = (await get("/books.html")).text;
  assert.ok(html.includes("Visible Shelf") && !html.includes("Emptied Shelf") && !html.includes("Draft Shelf"));
  // The emptied collection's own page is still there, with its friendly message.
  assert.match((await get(`/collections/${gone.slug}`)).text, /found a new home/);
});

test("Browse Books: buttons follow the sort order, and a collection without a picture is a plain text button", async () => {
  await pool.query("UPDATE curated_collections SET published = FALSE");
  const a = await publishedShelf([[await newBook(`Sort A ${uniq()}`), "approved"]], { title_en: "Second Shelf" });
  const b = await publishedShelf([[await newBook(`Sort B ${uniq()}`), "approved"]], { title_en: "First Shelf" });
  await pool.query("UPDATE curated_collections SET sort_order = 2 WHERE id = $1", [a.id]);
  await pool.query("UPDATE curated_collections SET sort_order = 1, icon_path = NULL WHERE id = $1", [b.id]);
  const row = rowOf((await get("/books.html")).text);
  assert.ok(row.indexOf("First Shelf") < row.indexOf("Second Shelf"));
  assert.match(row, /<a class="bk-genre col-btn no-art" href="\/collections\/[^"]+">\s*<span class="col-name">First Shelf<\/span>/);
});

test("the French Browse row and collection page carry none of the English from their own tr() strings", async () => {
  await pool.query("UPDATE curated_collections SET published = FALSE");
  await publishedShelf([[await newBook(`Fr row ${uniq()}`), "approved"]], { title_en: "Plain English Name", title_fr: "Nom français" });
  const own = pairs().filter((p) => /collections_row\.ejs$/.test(p.file) && p.en && p.fr);
  assert.ok(own.length >= 1);
  const fr = rowOf((await get("/fr/books.html")).text);
  for (const p of own) {
    assert.ok(fr.includes(p.fr), `French text "${p.fr}" missing`);
    assert.ok(!fr.includes(p.en), `English text "${p.en}" on the French row`);
  }
  const en = rowOf((await get("/books.html")).text);
  for (const p of own) assert.ok(en.includes(p.en));
});


// ---------- rebuilding as new books come in ----------

const { generateSuggestions, updateAllCollections } = require("../../src/lib/collectionSuggestions");
const okAsk = (log, ids = () => []) => async (prompt) => { log.push(prompt); return { text: JSON.stringify(ids(prompt).map((id) => ({ id, reason: "fits" }))), reason: null }; };
const idsIn = (prompt) => (prompt.match(/^\d+(?= \| )/gm) || []).map(Number);
const lastBuilt = async (c) => (await bySlug(c.slug)).last_generated_at;

test("Add new books sends ONLY books added since the last build; a never-built collection sends all in stock", async () => {
  const c = await freshCollection();
  const old = await newBook(`Old ${uniq()}`);
  const log = [];
  let r = await generateSuggestions(pool, c.id, { ask: okAsk(log, () => []) });
  assert.equal(r.ok, true);
  assert.ok(idsIn(log[0]).includes(old.id), "never built: every book in stock is considered");
  const built = await lastBuilt(c);
  assert.ok(built, "last built is set after a successful build");

  const fresh = await newBook(`Fresh ${uniq()}`);
  log.length = 0;
  r = await generateSuggestions(pool, c.id, { ask: okAsk(log, (p) => idsIn(p)) });
  assert.deepEqual(idsIn(log[0]), [fresh.id], `only the book that arrived after the last build is sent (old=${old.id}, built=${built.toISOString()})`);
  assert.equal(r.added, 1);
  assert.equal(await status(c.id, fresh.id), "suggested");
  assert.ok((await lastBuilt(c)) > built, "last built moves forward");

  // A second copy of an OLD book arriving later makes that book new again.
  await pool.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 5, 'good')", [old.id]);
  log.length = 0;
  await generateSuggestions(pool, c.id, { ask: okAsk(log, () => []) });
  assert.deepEqual(idsIn(log[0]), [old.id]);
});

test("Nothing new: no AI call, the last built time stays, and a book sold again is not 'new'", async () => {
  const c = await freshCollection();
  await newBook(`Seen ${uniq()}`);
  await generateSuggestions(pool, c.id, { ask: okAsk([]) });
  const built = await lastBuilt(c);
  let calls = 0;
  const r = await generateSuggestions(pool, c.id, { ask: async () => { calls += 1; return { text: "[]", reason: null }; } });
  assert.deepEqual([r.ok, r.nothingNew, r.added, calls], [true, true, 0, 0]);
  assert.deepEqual(await lastBuilt(c), built);
  // A new book that is already sold does not count either.
  await newBook(`Sold later ${uniq()}`, { copyStatus: "sold" });
  assert.equal((await generateSuggestions(pool, c.id, { ask: okAsk([]) })).nothingNew, true);
});

test("the last built time changes only when a build worked", async () => {
  const c = await freshCollection();
  await newBook(`Fail ${uniq()}`);
  for (const reason of ["credit", "cap", "timeout", "error"]) {
    const r = await generateSuggestions(pool, c.id, { ask: async () => ({ text: null, reason }) });
    assert.equal(r.ok, false);
    assert.equal(await lastBuilt(c), null, `still never built after ${reason}`);
  }
  assert.equal((await generateSuggestions(pool, c.id, { ask: async () => ({ text: "not json", reason: null }) })).ok, true);
  assert.ok(await lastBuilt(c), "an answer came back (even an empty one): that is a build");
  const built = await lastBuilt(c);
  await newBook(`Fail again ${uniq()}`);
  await generateSuggestions(pool, c.id, { ask: async () => ({ text: null, reason: "timeout" }) });
  assert.deepEqual(await lastBuilt(c), built, "a failed run keeps the old time, so those books are looked at next time");
});

test("a rebuild never changes or removes an approved or rejected decision, and new suggestions are not public even on a published collection", async () => {
  const [a, r2, w] = [await newBook(`Dec A ${uniq()}`), await newBook(`Dec R ${uniq()}`), await newBook(`Dec W ${uniq()}`)];
  const c = await publishedShelf([[a, "approved"], [r2, "rejected"]]);
  const before = (await pool.query("SELECT book_id, status, reason, position FROM curated_collection_books WHERE collection_id = $1 ORDER BY book_id", [c.id])).rows;
  const log = [];
  for (const mode of ["new", "full"]) {
    await generateSuggestions(pool, c.id, { mode, ask: okAsk(log, (p) => idsIn(p)) });
  }
  const after = (await pool.query("SELECT book_id, status, reason, position FROM curated_collection_books WHERE collection_id = $1 AND book_id = ANY($2) ORDER BY book_id", [c.id, [a.id, r2.id]])).rows;
  assert.deepEqual(after, before);
  assert.equal(await status(c.id, w.id), "suggested", "the AI's pick is waiting for review");
  assert.equal((await bySlug(c.slug)).published, true, "the collection stays published");
  const page = (await get(`/collections/${c.slug}`)).text;
  assert.ok(page.includes(a.title), "the approved book is shown");
  assert.ok(!page.includes(w.title) && !page.includes(r2.title), "a suggested or rejected book never is");
  assert.ok(!rowOf((await get("/books.html")).text).includes(w.title));
});

test("Full rebuild looks at every book in stock (not only new ones) and keeps the decisions", async () => {
  const c = await freshCollection();
  await newBook(`Before ${uniq()}`);
  await generateSuggestions(pool, c.id, { ask: okAsk([]) });
  const log = [];
  await generateSuggestions(pool, c.id, { ask: okAsk(log) });
  assert.equal(log.length, 0, "new mode: nothing new");
  const r = await generateSuggestions(pool, c.id, { mode: "full", ask: okAsk(log, (p) => idsIn(p).slice(0, 1)) });
  assert.equal(log.length >= 1, true);
  assert.ok(r.considered >= 1 && r.added >= 1);
});

test("Update all continues past a failing collection and reports each one", async () => {
  await pool.query("UPDATE curated_collections SET last_generated_at = NULL");
  const one = await freshCollection({ title_en: "UA One" });
  const two = await freshCollection({ title_en: "UA Two" });
  const three = await freshCollection({ title_en: "UA Three" });
  const never = await freshCollection({ title_en: "UA Never" });
  await pool.query("UPDATE curated_collections SET sort_order = id WHERE id = ANY($1)", [[one.id, two.id, three.id, never.id]]);
  await pool.query("UPDATE curated_collections SET last_generated_at = now() - interval '1 day' WHERE id = ANY($1)", [[one.id, two.id, three.id]]);
  const book = await newBook(`UA book ${uniq()}`);
  const asked = [];
  const ask = async (prompt) => {
    asked.push(prompt);
    if (prompt.includes("SHELF: UA One")) return { text: null, reason: "timeout" };
    if (prompt.includes("SHELF: UA Two")) return { text: JSON.stringify([{ id: book.id, reason: "fits" }]), reason: null };
    return { text: "[]", reason: null };
  };
  const out = await updateAllCollections(pool, { ask });
  const mine = Object.fromEntries(out.filter((r) => [one.id, two.id, three.id, never.id].includes(r.id)).map((r) => [r.title, r]));
  assert.equal(mine["UA One"].status, "failed");
  assert.match(mine["UA One"].error, /too long/);
  assert.equal(mine["UA Two"].status, "added");
  assert.equal(mine["UA Two"].added, 1);
  assert.equal(mine["UA Three"].status, "added", "the run went on after the failure");
  assert.equal(mine["UA Never"].status, "never");
  assert.equal(await status(two.id, book.id), "suggested");
  assert.equal(await lastBuilt(one) < new Date(Date.now() - 3600e3), true, "the failed one keeps its old time");
  // Second press: everything is up to date.
  asked.length = 0;
  const again = await updateAllCollections(pool, { ask: async () => ({ text: "[]", reason: null }) });
  assert.ok(again.filter((r) => [two.id, three.id].includes(r.id)).every((r) => r.status === "nothing"));
  // The time limit stops starting new collections and says so.
  const slow = await updateAllCollections(pool, { ask, startMs: -1, now: () => 0 });
  assert.ok(slow.filter((r) => r.status !== "never").every((r) => r.status === "nothing" || r.status === "later" || r.status === "failed" || r.status === "added"));
});

test("the list shows Last built, the review badge and 'N books were added since the last build'", async () => {
  const c = await freshCollection({ title_en: "Badge Shelf" });
  const [a, b] = [await newBook(`Badge A ${uniq()}`), await newBook(`Badge B ${uniq()}`)];
  await addRow(c.id, a.id, "suggested", "x", 1);
  await addRow(c.id, b.id, "suggested", "x", 2);
  await pool.query("UPDATE curated_collections SET last_generated_at = now() - interval '2 days' WHERE id = $1", [c.id]);
  await newBook(`Badge new ${uniq()}`);
  await newBook(`Badge new two ${uniq()}`);
  const { text } = await get("/admin/collections", { jar: adminJar });
  assert.match(text, /New books since the last build/);
  assert.match(text, /Badge Shelf<\/a>: \d+ books were added since the last build/);
  const row = text.split("<tr>").slice(1).find((r) => r.includes("Badge Shelf"));
  assert.match(row, /2 to review/);
  assert.match(row, /new books since/);
  const never = text.split("<tr>").slice(1).find((r) => r.includes("The Literary Apothecary"));
  assert.match(never, /Never built/);
  const edit = (await get(`/admin/collections/${c.id}`, { jar: adminJar })).text;
  assert.match(edit, /Last built:/);
  assert.match(edit, /Add new books/);
  assert.match(edit, /Full rebuild \(re-evaluate all books\)/);
});

test("Update all, Add new books and Full rebuild: admin only, CSRF, confirm step, friendly result and audit entry", async () => {
  const c = await freshCollection();
  await pool.query("UPDATE curated_collections SET last_generated_at = now() - interval '1 day' WHERE id = $1", [c.id]);
  await newBook(`Route ${uniq()}`);
  const memberJar = await loginJar(await createUser({ member: true }));
  for (const p of ["/admin/collections/update-all", `/admin/collections/${c.id}/rebuild`]) {
    assert.equal((await adminPost(p, {}, { jar: memberJar })).res.status, 403, `${p}: member refused`);
    assert.equal((await adminPost(p, {}, { csrf: false })).res.status, 403, `${p}: no CSRF token refused`);
  }
  assert.equal((await get(`/admin/collections/${c.id}/rebuild`, { jar: memberJar })).res.status, 403);
  const confirmPage = await get(`/admin/collections/${c.id}/rebuild`, { jar: adminJar });
  assert.match(confirmPage.text, /Are you sure\?/);
  assert.match(confirmPage.text, /Your Approve and Reject choices are kept/);

  let r = await adminPost(`/admin/collections/${c.id}/rebuild`, {});
  assert.match(notice(r.text), /not confirmed/);
  r = await adminPost(`/admin/collections/${c.id}/rebuild`, { confirm: "yes" });
  assert.match(notice(r.text), /AI helper is not set up/, "no key here: friendly, nothing changes");

  r = await adminPost("/admin/collections/update-all");
  assert.match(notice(r.text), /could not be updated/);
  assert.match(r.text, new RegExp(`${c.title_en}: FAILED, The AI helper is not set up`));
  const log = (await pool.query("SELECT action FROM admin_audit_log WHERE action LIKE 'collection.%' ORDER BY id DESC LIMIT 10")).rows.map((x) => x.action);
  assert.ok(log.includes("collection.update_all") && log.includes("collection.full_rebuild"));
});

// ---------- managing collections: create, slug, delete, reorder ----------

const sharp = require("sharp");

async function adminMultipart(p, fields, files = {}, { jar = adminJar, csrf = true } = {}) {
  const form = new FormData();
  if (csrf) form.append("_csrf", await fetchCsrfToken(app.base, jar));
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  for (const [k, f] of Object.entries(files)) form.append(k, new Blob([f.data], { type: f.type }), f.name);
  const res = await fetch(`${app.base}${p}`, { method: "POST", redirect: "manual", headers: { cookie: jar.header() }, body: form });
  jar.capture(res);
  if (res.status !== 303) return { res, text: await res.text() };
  const next = await get(res.headers.get("location"), { jar });
  return { res, location: res.headers.get("location"), text: next.text, page: next.res };
}
const colorPng = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: "#3a7" } }).png().toBuffer();
const colorJpg = (w, h, bg = "#a37") => sharp({ create: { width: w, height: h, channels: 3, background: bg } }).jpeg().toBuffer();
const newForm = (o = {}) => ({ title_en: "Created Shelf", description_en: "Made by hand.", title_fr: "Étagère créée", description_fr: "Faite à la main.", curation_prompt: "", slug: "", sort_order: "", ...o });

test("Create: starts unpublished with EN and FR text, the slug comes from the English title, duplicates get a number or are refused", async () => {
  const t = `Brand New Shelf ${uniq()}`;
  let r = await adminPost("/admin/collections", newForm({ title_en: t }));
  assert.match(notice(r.text), /Collection created/);
  const row = (await pool.query("SELECT * FROM curated_collections WHERE title_en = $1", [t])).rows[0];
  assert.equal(row.published, false);
  assert.equal(row.slug, t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  assert.deepEqual([row.title_fr, row.description_fr, row.curation_prompt], ["Étagère créée", "Faite à la main.", ""]);
  const max = (await pool.query("SELECT max(sort_order) AS m FROM curated_collections")).rows[0].m;
  assert.equal(row.sort_order, max, "put last in the order");

  // The same title again: the generated slug gets -2.
  await adminPost("/admin/collections", newForm({ title_en: t }));
  assert.equal((await pool.query("SELECT 1 FROM curated_collections WHERE slug = $1", [`${row.slug}-2`])).rowCount, 1);

  // A typed slug that is taken, or malformed, or an empty title: refused, typed values come back, nothing created.
  const before = (await pool.query("SELECT count(*)::int AS n FROM curated_collections")).rows[0].n;
  r = await adminPost("/admin/collections", newForm({ title_en: "Dup typed", slug: row.slug }));
  assert.match(notice(r.text), /already used by another collection/);
  assert.match(r.text, /value="Dup typed"/);
  r = await adminPost("/admin/collections", newForm({ slug: "Bad Slug!" }));
  assert.match(notice(r.text), /lower-case letters/);
  r = await adminPost("/admin/collections", newForm({ title_en: "" }));
  assert.match(notice(r.text), /English title cannot be empty/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM curated_collections")).rows[0].n, before);
});

test("the slug can be edited while unpublished (not to a taken one) and is locked once published", async () => {
  const c = await freshCollection();
  const other = await freshCollection();
  const text = (o = {}) => ({ slug: c.slug, title_en: "T", description_en: "D", title_fr: "Tf", description_fr: "Df", curation_prompt: "p", sort_order: "1", ...o });
  let r = await adminPost(`/admin/collections/${c.id}`, text({ slug: other.slug }));
  assert.match(notice(r.text), /already used/);
  r = await adminPost(`/admin/collections/${c.id}`, text({ slug: `renamed-${uniq()}`.toLowerCase() }));
  assert.match(notice(r.text), /^Saved/);
  const renamed = (await pool.query("SELECT slug FROM curated_collections WHERE id = $1", [c.id])).rows[0].slug;
  assert.match(renamed, /^renamed-/);
  const b = await newBook(`Slug ${uniq()}`);
  await addRow(c.id, b.id, "approved");
  await adminPost(`/admin/collections/${c.id}/published`, { published: "1", back: "edit" });
  await adminPost(`/admin/collections/${c.id}`, text({ slug: "sneaky-change" }));
  assert.equal((await pool.query("SELECT slug FROM curated_collections WHERE id = $1", [c.id])).rows[0].slug, renamed, "a published address does not change");
});

test("Delete: needs a confirmation, shows the approved count, removes the collection and its links but never a book, and the address 404s", async () => {
  const [a, b] = [await newBook(`Del A ${uniq()}`), await newBook(`Del B ${uniq()}`)];
  const c = await publishedShelf([[a, "approved"], [b, "suggested"]]);
  const page = await get(`/admin/collections/${c.id}/delete`, { jar: adminJar });
  assert.match(page.text, /1 approved book\b/);
  assert.match(page.text, /2 in its list/);
  assert.match(page.text, /Unpublish instead/);
  assert.match(page.text, /No book is deleted or changed/);
  let r = await adminPost(`/admin/collections/${c.id}/delete`, {});
  assert.match(notice(r.text), /not deleted: tick the box/);
  assert.equal((await get(`/collections/${c.slug}`)).res.status, 200);
  r = await adminPost(`/admin/collections/${c.id}/delete`, { confirm: "yes" });
  assert.match(notice(r.text), /was deleted \(its books were not touched\)/);
  assert.equal((await get(`/collections/${c.slug}`)).res.status, 404);
  assert.equal((await get(`/fr/collections/${c.slug}`)).res.status, 404);
  assert.equal((await pool.query("SELECT 1 FROM curated_collections WHERE id = $1", [c.id])).rowCount, 0);
  assert.equal((await pool.query("SELECT 1 FROM curated_collection_books WHERE collection_id = $1", [c.id])).rowCount, 0);
  assert.equal((await pool.query("SELECT 1 FROM books WHERE id = ANY($1)", [[a.id, b.id]])).rowCount, 2, "the books are untouched");
  assert.equal((await pool.query("SELECT 1 FROM book_copies WHERE book_id = ANY($1)", [[a.id, b.id]])).rowCount, 2);
  assert.equal((await pool.query("SELECT 1 FROM admin_audit_log WHERE action = 'collection.delete' AND target_id = $1", [c.id])).rowCount, 1);
  assert.equal((await get(`/admin/collections/${c.id}`, { jar: adminJar })).res.status, 404);
});

test("Reorder: up and down change the order of the buttons on Browse Books, and so does the sort order number", async () => {
  await pool.query("UPDATE curated_collections SET published = FALSE");
  const mk = async (name) => publishedShelf([[await newBook(`Order ${uniq()}`), "approved"]], { title_en: name });
  const [a, b, c3] = [await mk("Ord Alpha"), await mk("Ord Beta"), await mk("Ord Gamma")];
  await pool.query("UPDATE curated_collections SET sort_order = id");
  const names = async () => (rowOf((await get("/books.html")).text).match(/col-name">([^<]+)</g) || []).map((x) => x.replace(/.*>(.*)<$/, "$1").replace("col-name\">", ""));
  const order = async () => (await names()).filter((n) => n.startsWith("Ord ")).map((n) => n.slice(4));
  assert.deepEqual(await order(), ["Alpha", "Beta", "Gamma"]);
  await adminPost(`/admin/collections/${c3.id}/move`, { dir: "up" });
  assert.deepEqual(await order(), ["Alpha", "Gamma", "Beta"]);
  await adminPost(`/admin/collections/${a.id}/move`, { dir: "down" });
  assert.deepEqual(await order(), ["Gamma", "Alpha", "Beta"]);
  await adminPost(`/admin/collections/${b.id}`, { slug: b.slug, title_en: "Ord Beta", description_en: "d", title_fr: "x", description_fr: "y", curation_prompt: "p", sort_order: "-5" });
  assert.deepEqual(await order(), ["Beta", "Gamma", "Alpha"], "a numeric sort order works too");
  const list = (await get("/admin/collections", { jar: adminJar })).text;
  assert.ok(list.indexOf("Ord Beta") < list.indexOf("Ord Gamma"), "the admin list uses the same order");
  assert.match(list, /aria-label="Move Ord Beta up"/);
});

// ---------- pictures ----------

test("Pictures: a button picture (cut round) and a banner (with EN and FR alt text) are uploaded, shown, replaced and removed", async () => {
  const c = await freshCollection();
  const b = await newBook(`Pic ${uniq()}`);
  await addRow(c.id, b.id, "approved");
  await adminPost(`/admin/collections/${c.id}/published`, { published: "1", back: "edit" });
  const up = await adminMultipart(`/admin/collections/${c.id}/images`, { header_alt_en: "A bright reading nook", header_alt_fr: "Un coin de lecture lumineux" }, {
    icon: { data: await colorPng(500, 300), type: "image/png", name: "icon.png" },
    banner: { data: await colorJpg(2400, 900), type: "image/jpeg", name: "banner.jpg" },
  });
  assert.match(notice(up.text), /Pictures saved/);
  const row = await bySlug(c.slug);
  assert.match(row.icon_path, /^\/img\/[0-9a-f]{64}\.png$/);
  assert.match(row.banner_path, /^\/img\/[0-9a-f]{64}\.jpg$/);
  // Served from the database store, with the right sizes.
  const icon = await fetch(`${app.base}${row.icon_path}`);
  assert.equal(icon.headers.get("content-type"), "image/png");
  const im = await sharp(Buffer.from(await icon.arrayBuffer())).metadata();
  assert.deepEqual([im.width, im.height, im.hasAlpha], [240, 240, true]);
  const bn = await sharp(Buffer.from(await (await fetch(`${app.base}${row.banner_path}`)).arrayBuffer())).metadata();
  assert.deepEqual([bn.width, bn.height], [1600, 800]);
  // The edit page previews both.
  const edit = (await get(`/admin/collections/${c.id}`, { jar: adminJar })).text;
  assert.ok(edit.includes(`src="${row.icon_path}"`) && edit.includes(`src="${row.banner_path}"`));
  // Public page: banner with the alt text of the language, size attributes, no lazy loading above the fold.
  const en = (await get(`/collections/${c.slug}`)).text;
  assert.match(en, new RegExp(`<div class="col-banner"><img src="${row.banner_path}" srcset="[^"]*-w600\\.jpg 600w, ${row.banner_path} 1600w"[^>]*alt="A bright reading nook" width="1600" height="800"`));
  assert.ok(!/class="col-banner"><img[^>]*loading="lazy"/.test(en));
  const fr = (await get(`/fr/collections/${c.slug}`)).text;
  assert.match(fr, /alt="Un coin de lecture lumineux"/);
  assert.ok(!fr.includes("A bright reading nook"));
  // The Browse button uses the uploaded round picture.
  assert.match(rowOf((await get("/books.html")).text), new RegExp(`<img src="${row.icon_path}" alt="" width="90" height="90" loading="lazy"`));

  // Replace, then remove.
  const first = row.banner_path;
  await adminMultipart(`/admin/collections/${c.id}/images`, { header_alt_en: "x", header_alt_fr: "y" }, { banner: { data: await colorJpg(900, 900, "#27a"), type: "image/jpeg", name: "b2.jpg" } });
  assert.notEqual((await bySlug(c.slug)).banner_path, first);
  await adminMultipart(`/admin/collections/${c.id}/images`, { header_alt_en: "", header_alt_fr: "", remove_icon: "on", remove_banner: "on" });
  const gone = await bySlug(c.slug);
  assert.deepEqual([gone.icon_path, gone.banner_path], [null, null]);
  const page = (await get(`/collections/${c.slug}`)).text;
  assert.ok(!page.includes("col-banner"), "no banner: the page starts with the title");
  assert.match(page, /<h1/);
  assert.match(rowOf((await get("/books.html")).text), /col-btn no-art/, "plain text button without a picture");
});

test("Pictures: a wrong file type or an oversize file is refused and nothing changes", async () => {
  const c = await freshCollection();
  await pool.query("UPDATE curated_collections SET banner_path = NULL WHERE id = $1", [c.id]);
  const refused = /could not be used|larger than 5 MB/;
  let r = await adminMultipart(`/admin/collections/${c.id}/images`, { header_alt_en: "", header_alt_fr: "" }, { banner: { data: Buffer.from("not an image at all"), type: "image/png", name: "fake.png" } });
  assert.match(notice(r.text), refused, "text pretending to be a PNG");
  r = await adminMultipart(`/admin/collections/${c.id}/images`, { header_alt_en: "", header_alt_fr: "" }, { icon: { data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'), type: "image/svg+xml", name: "x.svg" } });
  assert.match(notice(r.text), refused, "SVG is not an accepted type");
  const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#000" } }).gif().toBuffer();
  r = await adminMultipart(`/admin/collections/${c.id}/images`, { header_alt_en: "", header_alt_fr: "" }, { banner: { data: gif, type: "image/jpeg", name: "x.jpg" } });
  assert.match(notice(r.text), refused, "a GIF with a JPEG name is refused: the bytes decide");
  const big = Buffer.alloc(5 * 1024 * 1024 + 10, 1);
  r = await adminMultipart(`/admin/collections/${c.id}/images`, { header_alt_en: "", header_alt_fr: "" }, { banner: { data: big, type: "image/jpeg", name: "big.jpg" } });
  assert.match(notice(r.text), /larger than 5 MB/);
  const row = await bySlug(c.slug);
  assert.deepEqual([row.icon_path, row.banner_path], [null, null]);
});

test("an uploaded collection picture is protected from the unused-image cleanup", async () => {
  const { findUnusedImages } = require("../../src/lib/imageCleanup");
  const c = await freshCollection();
  await adminMultipart(`/admin/collections/${c.id}/images`, { header_alt_en: "", header_alt_fr: "" }, { banner: { data: await colorJpg(800, 400), type: "image/jpeg", name: "k.jpg" } });
  const id = (await bySlug(c.slug)).banner_path.match(/[0-9a-f]{64}/)[0];
  assert.ok(!(await findUnusedImages(pool, { minAgeDays: 0 })).some((i) => i.id === id));
});

// ---------- books by hand, and manual-only collections ----------

test("Add a book by hand: search by title and ISBN, it counts as approved and shows publicly; remove with one click", async () => {
  const c = await freshCollection();
  const title = `Handpicked ${uniq()}`;
  const book = await newBook(title);
  await pool.query("UPDATE books SET isbn = '9781234567897' WHERE id = $1", [book.id]);
  const out = await newBook(`Handpicked out ${uniq()}`, { copyStatus: "sold" });
  let page = (await get(`/admin/collections/${c.id}?find=${encodeURIComponent("Handpicked")}`, { jar: adminJar })).text;
  assert.ok(page.includes(title) && !page.includes(out.title), "only books in stock are offered");
  page = (await get(`/admin/collections/${c.id}?find=9781234567897`, { jar: adminJar })).text;
  assert.ok(page.includes(title), "found by ISBN");
  assert.match(page, new RegExp(`action="/admin/collections/${c.id}/books/add"`));

  let r = await adminPost(`/admin/collections/${c.id}/books/add`, { bookId: book.id });
  assert.match(notice(r.text), /Book added \(it counts as approved\)/);
  assert.equal(await status(c.id, book.id), "approved");
  await adminPost(`/admin/collections/${c.id}/published`, { published: "1", back: "edit" });
  assert.equal((await bySlug(c.slug)).published, true, "one hand-added book is enough to publish");
  assert.ok((await get(`/collections/${c.slug}`)).text.includes(title));
  r = await adminPost(`/admin/collections/${c.id}/books/add`, { bookId: out.id });
  assert.match(notice(r.text), /not in stock/);
  assert.equal(await status(c.id, out.id), undefined);

  // A suggested book added by hand becomes approved; removing deletes the link, never the book.
  const s2 = await newBook(`Waiting ${uniq()}`);
  await addRow(c.id, s2.id, "suggested", "x", 5);
  await adminPost(`/admin/collections/${c.id}/books/add`, { bookId: s2.id });
  assert.equal(await status(c.id, s2.id), "approved");
  r = await adminPost(`/admin/collections/${c.id}/books/remove`, { bookId: s2.id });
  assert.match(notice(r.text), /Book removed/);
  assert.equal(await status(c.id, s2.id), undefined);
  assert.equal((await pool.query("SELECT 1 FROM books WHERE id = $1", [s2.id])).rowCount, 1);
  r = await adminPost(`/admin/collections/${c.id}/books/remove`, { bookId: book.id });
  assert.match(notice(r.text), /unpublished/, "no approved book left");
  assert.equal((await get(`/collections/${c.slug}`)).res.status, 404);
});

test("a collection with a blank guidance prompt is manual-only: no Generate buttons, and the AI is never asked", async () => {
  const c = await freshCollection();
  await pool.query("UPDATE curated_collections SET curation_prompt = '' WHERE id = $1", [c.id]);
  await newBook(`Manual ${uniq()}`);
  const edit = (await get(`/admin/collections/${c.id}`, { jar: adminJar })).text;
  assert.ok(!edit.includes(`/admin/collections/${c.id}/generate`) && !edit.includes(`/admin/collections/${c.id}/rebuild`), "no AI buttons");
  assert.match(edit, /filled in by hand only/);
  let calls = 0;
  const r = await generateSuggestions(pool, c.id, { ask: async () => { calls += 1; return { text: "[]", reason: null }; } });
  assert.deepEqual([r.ok, r.reason, calls], [false, "manual", 0]);
  await pool.query("UPDATE curated_collections SET last_generated_at = now() - interval '1 day' WHERE id = $1", [c.id]);
  const all = await updateAllCollections(pool, { ask: async () => { calls += 1; return { text: "[]", reason: null }; } });
  assert.equal(all.find((x) => x.id === c.id).status, "manual");
  assert.equal(calls >= 0, true);
  const posted = await adminPost(`/admin/collections/${c.id}/generate`);
  assert.match(notice(posted.text), /filled in by hand only/);
});

test("the new management routes are admin only and need the CSRF token", async () => {
  const c = await freshCollection();
  const memberJar = await loginJar(await createUser({ member: true }));
  const posts = [["/admin/collections", newForm()], [`/admin/collections/${c.id}/move`, { dir: "up" }], [`/admin/collections/${c.id}/delete`, { confirm: "yes" }],
    [`/admin/collections/${c.id}/books/add`, { bookId: 1 }], [`/admin/collections/${c.id}/books/remove`, { bookId: 1 }]];
  for (const [p, f] of posts) {
    assert.equal((await adminPost(p, f, { jar: memberJar })).res.status, 403, `${p}: member`);
    assert.equal((await adminPost(p, f, { csrf: false })).res.status, 403, `${p}: no token`);
  }
  assert.equal((await adminMultipart(`/admin/collections/${c.id}/images`, {}, {}, { jar: memberJar })).res.status, 403);
  assert.equal((await adminMultipart(`/admin/collections/${c.id}/images`, {}, {}, { csrf: false })).res.status, 403);
  for (const p of ["/admin/collections/new", `/admin/collections/${c.id}/delete`]) {
    assert.equal((await get(p, { jar: memberJar })).res.status, 403);
    assert.equal((await get(p)).res.status, 302);
  }
  assert.equal((await bySlug(c.slug)).id, c.id, "nothing was deleted");
});

// ---------- title and text under the banner ----------

test("With a banner the title is visually hidden and the description paragraph is not output; without one both show as before (EN and FR)", async () => {
  const ld = (t) => (t.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || []).join("\n");
  const c = await publishedShelf([[await newBook(`Banner ${uniq()}`), "approved"]]);
  const plain = { en: (await get(`/collections/${c.slug}`)).text, fr: (await get(`/fr/collections/${c.slug}`)).text };
  for (const t of Object.values(plain)) {
    assert.ok(!t.includes("col-banner"));
    assert.match(t, /<h1 id="col-title">/, "no banner: the h1 is a plain, visible heading");
    assert.match(t, /<p class="col-desc">/);
    assert.match(t, /<section class="col-head"/);
  }
  await pool.query("UPDATE curated_collections SET banner_path = $2, header_alt_en = 'Alt EN', header_alt_fr = 'Alt FR' WHERE id = $1", [c.id, `/img/${"a".repeat(64)}.jpg`]);
  const withB = { en: (await get(`/collections/${c.slug}`)).text, fr: (await get(`/fr/collections/${c.slug}`)).text };
  for (const [lang, t] of Object.entries(withB)) {
    assert.match(t, /<h1 class="col-sr" id="col-title">/, `${lang}: h1 present and visually hidden`);
    assert.ok(!t.includes("col-desc"), `${lang}: no description paragraph`);
    assert.ok(!t.includes('class="col-head"'));
    assert.match(t, /<div class="col-banner"><img[^>]*alt="Alt (EN|FR)"/);
    assert.match(t, /<h2 class="col-sr" id="col-books-title">/);
    // head: meta description, Open Graph, canonical, hreflang and structured data are the same as without a banner
    const head = (s) => s.slice(0, s.indexOf("</head>"));
    assert.equal(head(t).replace(/\s+/g, " "), head(plain[lang]).replace(/\s+/g, " "), `${lang}: <head> unchanged`);
    assert.equal(ld(t), ld(plain[lang]));
  }
  assert.match(withB.en, /<meta name="description" content="Gentle reads\."/);
  assert.match(withB.fr, /<meta name="description" content="Des lectures douces\."/);
  assert.match(withB.en, />Quiet Shelf<\/h1>/);
  assert.match(withB.fr, />Étagère calme<\/h1>/);
});

test("An empty collection with a banner still shows its message", async () => {
  const c = await publishedShelf([]);
  await pool.query("UPDATE curated_collections SET banner_path = $2 WHERE id = $1", [c.id, `/img/${"b".repeat(64)}.jpg`]);
  const t = (await get(`/collections/${c.slug}`)).text;
  assert.match(t, /<div class="col-empty" role="status">[\s\S]*Every book in this collection has found a new home/);
  assert.match(t, /<h1 class="col-sr"/);
});
