// Admin inventory (src/routes/admin/inventory.js) over HTTP, in-process:
// multipart cover/scan uploads (real JPEG/PNG buffers made with sharp),
// ISBN lookup, photo scan, add/edit/delete book and copies, reservations,
// and status/condition normalisation.
//
// The app mounts multer in front of the router exactly like src/index.js
// does (requireAdmin first, then multer, 8MB limit). Outbound HTTP is
// stubbed at global.fetch — Anthropic (vision, description, translation)
// and Open Library — and the stub refuses any other host, so no real call
// can be made; calls to this test's own 127.0.0.1 server pass through.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
require("express-async-errors"); // must load before the router is built, as in src/index.js
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");

const db = prepareDatabase("admin_inventory");
const { pool } = require("../../src/db");
const IMG_URL = /^\/img\/[0-9a-f]{64}\.jpg$/;
// Covers live in the images table and cover_url holds /img/<sha256>.jpg.
async function storedImage(url) {
  assert.match(url, IMG_URL);
  const { rows } = await pool.query("SELECT data, content_type FROM images WHERE id = $1", [url.slice(5, 69)]);
  assert.equal(rows.length, 1, "image bytes are in the images table");
  assert.equal(rows[0].content_type, "image/jpeg");
  return rows[0].data;
}
const { requireAdmin } = require("../../src/middleware/auth");

process.env.ANTHROPIC_API_KEY = "test-key-not-real";

// ---------------------------------------------------------------- fetch stub

const realFetch = global.fetch;
const ai = {}; // per-test knobs, see resetStubs
const anthropicCalls = []; // parsed request bodies
const olCalls = []; // URLs
const openLibrary = { isbn: new Map(), search: [] };

function resetStubs() {
  ai.vision = '{"isbn": null, "title": null, "author": null}';
  ai.description = "AI generated blurb.";
  ai.fail = false;
  anthropicCalls.length = 0;
  olCalls.length = 0;
  openLibrary.isbn.clear();
  openLibrary.search = [];
}

const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

global.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1:")) return realFetch(url, init);
  if (u.startsWith("https://api.anthropic.com/v1/messages")) {
    const body = JSON.parse(init.body);
    anthropicCalls.push(body);
    if (ai.fail) return new Response("overloaded", { status: 529 });
    const content = body.messages[0].content;
    let text;
    if (Array.isArray(content)) text = ai.vision;
    else if (content.startsWith("Translate")) text = `FR: ${content.match(/"([^"]*)"\s*$/)[1]}`;
    else text = ai.description;
    return jsonRes({ content: [{ type: "text", text }] });
  }
  if (u.startsWith("https://openlibrary.org/")) {
    olCalls.push(u);
    const m = u.match(/\/isbn\/([0-9X]+)\.json$/);
    if (m) {
      const data = openLibrary.isbn.get(m[1]);
      return data ? jsonRes({ records: { r: { isbns: [m[1]], data } } }) : jsonRes({});
    }
    if (u.includes("/search.json")) return jsonRes({ docs: openLibrary.search });
  }
  throw new Error(`test refused a real outbound request to ${u}`);
};

// ----------------------------------------------------------------- app setup

let server;
let adminId;
before(async () => {
  db.create();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
  const gate = express.Router();
  gate.use("/admin/inventory", requireAdmin, upload.fields([{ name: "photo", maxCount: 1 }, { name: "coverPhoto", maxCount: 1 }]));
  server = await listen(buildApp([gate, require("../../src/routes/admin/inventory")]));
  const { rows } = await pool.query(
    "INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ($1, 'x', 'Inv Admin', true) RETURNING id",
    [`inv-admin-${RUN()}@example.test`]
  );
  adminId = rows[0].id;
});
after(async () => {
  global.fetch = realFetch;
  await server.close();
  await pool.end();
  db.drop();
});
beforeEach(resetStubs);

function RUN() { return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`; }
let seq = 0;
const tag = () => `${RUN().replace(/-/g, "x")}q${++seq}`; // alphanumeric, unique, safe in titles and ISBN-ish searches
const isbn13 = () => `979${String(Date.now()).slice(-7)}${String(++seq).padStart(3, "0")}`; // 13 digits, unique

const adminHeader = () => ({ "x-test-user": JSON.stringify({ id: adminId, email: "a@example.test", displayName: "Admin", isAdmin: true }) });
const memberHeader = () => ({ "x-test-user": JSON.stringify({ id: adminId, email: "m@example.test", displayName: "M", isAdmin: false, isMember: true }) });

async function request(path, { method = "GET", fields, files, form, headers = adminHeader() } = {}) {
  let body;
  const h = { ...headers };
  if (fields || files) {
    body = new FormData();
    for (const [k, v] of Object.entries(fields || {})) body.append(k, v);
    for (const [k, f] of Object.entries(files || {})) body.append(k, new Blob([f.buffer], { type: f.type }), f.name);
  } else if (form) {
    body = new URLSearchParams(form).toString();
    h["content-type"] = "application/x-www-form-urlencoded";
  }
  const res = await realFetch(`${server.base}${path}`, { method, redirect: "manual", headers: h, body, signal: AbortSignal.timeout(15000) });
  return { res, text: await res.text(), status: res.status, location: res.headers.get("location") };
}
const get = (p, o) => request(p, o);
const post = (p, o) => request(p, { ...o, method: "POST" });

const jpeg = (w = 50, h = 50) => sharp({ create: { width: w, height: h, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();
const png = (w = 60, h = 40) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 200, g: 20, b: 20, alpha: 1 } } }).png().toBuffer();

const bookByTitle = async (title) => (await pool.query("SELECT * FROM books WHERE title = $1", [title])).rows;
const copiesOf = async (bookId) => (await pool.query("SELECT * FROM book_copies WHERE book_id = $1 ORDER BY id", [bookId])).rows;

async function seedBook({ title = `Seed ${tag()}`, isbn = null, cover = "https://img.example/c.jpg", description = "Existing description", descriptionFr = "Description existante", copies = [{}] } = {}) {
  const { rows } = await pool.query(
    "INSERT INTO books (isbn, title, authors, description, description_fr, cover_url) VALUES ($1, $2, 'Seed Author', $3, $4, $5) RETURNING id",
    [isbn, title, description, descriptionFr, cover]
  );
  const ids = [];
  for (const c of copies) {
    const r = await pool.query(
      `INSERT INTO book_copies (book_id, status, condition, price, acquisition_cost, reserved_by_name, reserved_by_email, reserved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [rows[0].id, c.status || "in_stock", c.condition || "good", c.price ?? 6, c.cost ?? 1, c.name || null, c.email || null, c.reservedAt || null]
    );
    ids.push(r.rows[0].id);
  }
  return { id: rows[0].id, title, copyIds: ids };
}

// ------------------------------------------------------------------ access

test("anonymous visitors are sent to /login and non-admins get 403 on every inventory route", async () => {
  const routes = [
    ["GET", "/admin/inventory"], ["GET", "/admin/inventory/new"], ["GET", "/admin/inventory/scan"], ["GET", "/admin/inventory/1"],
    ["POST", "/admin/inventory"], ["POST", "/admin/inventory/lookup"], ["POST", "/admin/inventory/generate-description"],
    ["POST", "/admin/inventory/1"], ["POST", "/admin/inventory/1/delete"], ["POST", "/admin/inventory/1/copies/1"],
    ["POST", "/admin/inventory/1/copies/1/cancel-reservation"], ["POST", "/admin/inventory/1/copies/1/delete"],
  ];
  for (const [method, path] of routes) {
    const anon = await request(path, { method, headers: {} });
    assert.equal(anon.status, 302, `${method} ${path} anonymous`);
    assert.equal(anon.location, "/login");
    const member = await request(path, { method, headers: memberHeader() });
    assert.equal(member.status, 403, `${method} ${path} member`);
  }
  assert.equal(anthropicCalls.length, 0);
});

test("a non-admin multipart upload is stopped before anything is stored", async () => {
  const title = `Sneaky ${tag()}`;
  const { status } = await post("/admin/inventory", { fields: { title }, files: { coverPhoto: { buffer: await jpeg(), type: "image/jpeg", name: "c.jpg" } }, headers: memberHeader() });
  assert.equal(status, 403);
  assert.equal((await bookByTitle(title)).length, 0);
});

// --------------------------------------------------------------- list / show

test("list page shows books, filters by title/author/isbn, and releases expired reservations", async () => {
  const t = tag();
  const a = await seedBook({ title: `Alpha ${t}`, isbn: isbn13() });
  await seedBook({ title: `Beta ${t}`, copies: [{}, { status: "sold" }] });
  const stale = await seedBook({ title: `Stale ${t}`, copies: [{ status: "reserved", name: "Old", email: "old@example.test", reservedAt: new Date(Date.now() - 15 * 86400000) }] });

  const all = await get(`/admin/inventory?q=${t}`);
  assert.equal(all.status, 200);
  for (const name of ["Alpha", "Beta", "Stale"]) assert.ok(all.text.includes(`${name} ${t}`));
  assert.match(all.text, /1\/2 in stock/);

  const byIsbn = await get(`/admin/inventory?q=${(await pool.query("SELECT isbn FROM books WHERE id=$1", [a.id])).rows[0].isbn}`);
  assert.ok(byIsbn.text.includes(`Alpha ${t}`));
  assert.ok(!byIsbn.text.includes(`Beta ${t}`));

  const byAuthor = await get(`/admin/inventory?q=${encodeURIComponent("seed author")}`);
  assert.equal(byAuthor.status, 200, "ILIKE search is case-insensitive");

  const none = await get(`/admin/inventory?q=${t}-nomatch`);
  assert.ok(!none.text.includes(`Alpha ${t}`));

  const [copy] = await copiesOf(stale.id);
  assert.equal(copy.status, "in_stock", "the 15-day-old reservation was released by viewing the list");
  assert.equal(copy.reserved_by_email, null);
});

test("show page renders the book and its copies; unknown and garbage ids give the 404 page", async () => {
  const b = await seedBook({ copies: [{}, { price: 9 }] });
  const ok = await get(`/admin/inventory/${b.id}`);
  assert.equal(ok.status, 200);
  assert.ok(ok.text.includes(b.title));
  assert.match(ok.text, /Copies \(2\)/);
  assert.equal((await get("/admin/inventory/999999999")).status, 404);
  assert.equal((await get("/admin/inventory/abc")).status, 404);
  assert.equal((await post("/admin/inventory/abc/copies/1", { form: {} })).status, 404);
  assert.equal((await post("/admin/inventory/1/copies/abc/delete", { form: {} })).status, 404);
});

test("show page releases an expired reservation but keeps a fresh one", async () => {
  const day = 86400000;
  const b = await seedBook({
    copies: [
      { status: "reserved", name: "Fresh", email: "fresh@example.test", reservedAt: new Date(Date.now() - 13 * day) },
      { status: "reserved", name: "Stale", email: "stale@example.test", reservedAt: new Date(Date.now() - 14 * day - 60000) },
    ],
  });
  const res = await get(`/admin/inventory/${b.id}`);
  assert.ok(res.text.includes("Fresh") && res.text.includes("fresh@example.test"));
  assert.ok(!res.text.includes("stale@example.test"));
  const copies = await copiesOf(b.id);
  assert.deepEqual(copies.map((c) => c.status), ["reserved", "in_stock"]);
});

// ------------------------------------------------------------------- scan UI

test("scan page reflects whether photo scanning is configured and the saved flag", async () => {
  const on = await get("/admin/inventory/scan?saved=1");
  assert.match(on.text, /Book saved/);
  assert.match(on.text, /name="photo"/);
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const off = await get("/admin/inventory/scan");
    assert.doesNotMatch(off.text, /Book saved/);
    assert.doesNotMatch(off.text, /name="photo"/);
    assert.match(off.text, /Photo scanning isn't set up yet/);
  } finally {
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  }
});

test("new-book form renders with the default pricing", async () => {
  const res = await get("/admin/inventory/new");
  assert.equal(res.status, 200);
  assert.match(res.text, /name="price"[^>]*value="5"/);
  assert.match(res.text, /name="acquisitionCost"[^>]*value="0"/);
});

// -------------------------------------------------------------- ISBN lookup

test("lookup: blank ISBN asks for one; no lookup is made", async () => {
  const { status, text } = await post("/admin/inventory/lookup", { fields: { isbn: "   " } });
  assert.equal(status, 200);
  assert.match(text, /Enter an ISBN or choose a photo\./);
  assert.equal(olCalls.length, 0);
});

test("lookup: a found ISBN pre-fills the add form (and the form escapes catalog text)", async () => {
  const isbn = isbn13();
  openLibrary.isbn.set(isbn, {
    title: 'Found "Book"><script>alert(1)</script>', authors: [{ name: "Ann Author" }], publishers: [{ name: "Pub House" }],
    publish_date: "2001", cover: { large: "https://covers.example/x.jpg" }, subjects: [{ name: "Fantasy" }],
  });
  const { status, text } = await post("/admin/inventory/lookup", { fields: { isbn: `${isbn.slice(0, 3)}-${isbn.slice(3)}` } });
  assert.equal(status, 200);
  assert.ok(olCalls[0].endsWith(`/isbn/${isbn}.json`), "hyphens are stripped before the lookup");
  assert.ok(!text.includes("<script>alert(1)</script>"), "catalog text is escaped");
  assert.ok(text.includes("Found &#34;Book&#34;&gt;&lt;script&gt;"));
  assert.ok(text.includes("Ann Author") && text.includes("Pub House") && text.includes("2001"));
  assert.ok(text.includes(`value="${isbn}"`));
  assert.ok(text.includes("https://covers.example/x.jpg"));
  assert.match(text, /name="fromScan" value="1"/);
  assert.doesNotMatch(text, /No catalog match/);
});

test("lookup: pricing defaults to the existing copies of the same ISBN", async () => {
  const isbn = isbn13();
  await seedBook({ isbn, copies: [{ price: 12.5, cost: 3.25 }] });
  openLibrary.isbn.set(isbn, { title: "Known" });
  const { text } = await post("/admin/inventory/lookup", { fields: { isbn } });
  assert.match(text, /name="price"[^>]*value="12.5"/);
  assert.match(text, /name="acquisitionCost"[^>]*value="3.25"/);
});

test("lookup: an unknown ISBN says so and still offers the normalised ISBN for manual entry", async () => {
  const isbn = isbn13();
  const { text } = await post("/admin/inventory/lookup", { fields: { isbn: ` ${isbn.slice(0, 3)} ${isbn.slice(3)} ` } });
  assert.match(text, /No catalog match for that ISBN/);
  assert.ok(text.includes(`value="${isbn}"`));
  assert.match(text, /name="price"[^>]*value="5"/);
});

// ---------------------------------------------------------------- photo scan

test("lookup by photo: sends the photo to the vision API, then uses the ISBN it read", async () => {
  const isbn = isbn13();
  ai.vision = JSON.stringify({ isbn, title: "Ignored Title", author: "Ignored" });
  openLibrary.isbn.set(isbn, { title: "Catalog Title" });
  const photo = await jpeg(30, 30);
  const { status, text } = await post("/admin/inventory/lookup", { fields: {}, files: { photo: { buffer: photo, type: "image/jpeg", name: "scan.jpg" } } });
  assert.equal(status, 200);
  assert.equal(anthropicCalls.length, 1);
  const image = anthropicCalls[0].messages[0].content[0];
  assert.equal(image.source.media_type, "image/jpeg");
  const sent = await sharp(Buffer.from(image.source.data, "base64")).metadata();
  assert.equal(sent.format, "jpeg", "the photo is normalised to a JPEG before it goes to the vision API");
  assert.ok(text.includes("Catalog Title"));
  assert.ok(!text.includes("Ignored Title"));
});

test("lookup by photo: no ISBN visible -> falls back to a title/author catalog search", async () => {
  ai.vision = '{"isbn": null, "title": "Photo Title", "author": "Photo Author"}';
  openLibrary.search = [{ title: "Search Hit One", author_name: ["Hit Author"] }, { title: "Search Hit Two" }];
  const { text } = await post("/admin/inventory/lookup", { files: { photo: { buffer: await jpeg(), type: "image/jpeg", name: "s.jpg" } } });
  const searchUrl = new URL(olCalls.find((u) => u.includes("/search.json")));
  assert.equal(searchUrl.searchParams.get("title"), "Photo Title");
  assert.equal(searchUrl.searchParams.get("author"), "Photo Author");
  assert.ok(text.includes("Search Hit One"));
  assert.ok(!text.includes("Search Hit Two"), "only the first candidate is used");
});

test("lookup by photo: read but not in the catalog -> prefilled from the photo with a warning", async () => {
  const isbn = isbn13();
  ai.vision = JSON.stringify({ isbn, title: "Only On The Cover", author: "Cover Author" });
  const { text } = await post("/admin/inventory/lookup", { files: { photo: { buffer: await png(), type: "image/png", name: "s.png" } } });
  assert.match(text, /Found some details from the photo, but no catalog match/);
  assert.ok(text.includes("Only On The Cover") && text.includes("Cover Author") && text.includes(`value="${isbn}"`));
  assert.equal(anthropicCalls[0].messages[0].content[0].source.media_type, "image/jpeg", "a PNG photo is converted to JPEG first");
});

test("lookup by photo: nothing readable, or the vision API failing, shows the scan page with guidance", async () => {
  const photo = { buffer: await jpeg(), type: "image/jpeg", name: "s.jpg" };
  let r = await post("/admin/inventory/lookup", { files: { photo } });
  assert.match(r.text, /Couldn(?:'|&#39;)t read anything useful from that photo/);
  assert.match(r.text, /Enter an ISBN/);

  ai.fail = true;
  r = await post("/admin/inventory/lookup", { files: { photo } });
  assert.equal(r.status, 200);
  assert.match(r.text, /Couldn(?:'|&#39;)t read anything useful from that photo/);

  ai.fail = false;
  ai.vision = "I see a book, but no JSON for you.";
  r = await post("/admin/inventory/lookup", { files: { photo } });
  assert.match(r.text, /Couldn(?:'|&#39;)t read anything useful from that photo/);
});

// --------------------------------------------------------- generate-description

test("generate-description: needs a title, returns English + French, 502s when the AI is down", async () => {
  let r = await post("/admin/inventory/generate-description", { form: { title: "  " } });
  assert.equal(r.status, 400);
  assert.deepEqual(JSON.parse(r.text), { error: "Enter a title first." });
  assert.equal(anthropicCalls.length, 0);

  ai.description = "A lovely blurb.";
  r = await post("/admin/inventory/generate-description", { form: { title: "Blurb Book", author: "A. Writer", publisher: "P", publishedYear: "1999" } });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text), { description: "A lovely blurb.", descriptionFr: "FR: A lovely blurb." });
  const prompt = anthropicCalls[0].messages[0].content;
  assert.ok(prompt.includes('"Blurb Book"') && prompt.includes("by A. Writer") && prompt.includes("published by P") && prompt.includes("(1999)"));

  ai.fail = true;
  r = await post("/admin/inventory/generate-description", { form: { title: "Blurb Book" } });
  assert.equal(r.status, 502);
  assert.match(JSON.parse(r.text).error, /Couldn't generate a description/);
});

// ------------------------------------------------------------------ add book

test("add: a title is required; the form is re-shown with what was typed and nothing is saved", async () => {
  const author = `Author ${tag()}`;
  const { status, text } = await post("/admin/inventory", { fields: { title: "   ", author, price: "7.5", fromScan: "1" } });
  assert.equal(status, 200);
  assert.match(text, /Title is required\./);
  assert.ok(text.includes(author));
  assert.match(text, /name="price"[^>]*value="7.5"/);
  assert.equal((await pool.query("SELECT 1 FROM books WHERE authors = $1", [author])).rows.length, 0);
  assert.equal(anthropicCalls.length, 0);
});

test("add: creates the book and one copy; garbage condition/status fall back to good/in_stock", async () => {
  const title = `Created ${tag()}`;
  const isbn = isbn13();
  const { status, location } = await post("/admin/inventory", {
    fields: {
      title: `  ${title}  `, author: "Au Thor", isbn: `${isbn.slice(0, 3)}-${isbn.slice(3)}`, publisher: "Pub", publishedYear: "1987",
      genre: " Mystery , mystery, Fiction ", description: "Given description", descriptionFr: "Description donnée",
      coverUrl: "https://img.example/given.jpg", condition: "pristine", status: "lost", price: "8.50", acquisitionCost: "2", acquiredAt: "2026-01-15", copyNotes: " dog-eared ",
    },
  });
  assert.equal(status, 302);
  const [book] = await bookByTitle(title);
  assert.equal(location, `/admin/inventory/${book.id}`);
  assert.equal(book.isbn, isbn);
  assert.equal(book.authors, "Au Thor");
  assert.equal(book.published_year, 1987);
  assert.equal(book.categories, "Mystery, Fiction");
  assert.equal(book.categories_fr, "Policier, Fiction");
  assert.equal(book.description, "Given description");
  assert.equal(book.description_fr, "Description donnée");
  assert.equal(book.cover_url, "https://img.example/given.jpg");
  assert.equal(book.created_by, adminId);
  const [copy] = await copiesOf(book.id);
  assert.equal(copy.condition, "good");
  assert.equal(copy.status, "in_stock");
  assert.equal(Number(copy.price), 8.5);
  assert.equal(Number(copy.acquisition_cost), 2);
  assert.equal(copy.notes, "dog-eared");
  assert.equal(copy.created_by, adminId);
  // pg returns a DATE as local midnight: read it with local getters so the
  // assertion does not depend on the machine's timezone.
  const d = new Date(copy.acquired_at);
  assert.deepEqual([d.getFullYear(), d.getMonth() + 1, d.getDate()], [2026, 1, 15]);
  assert.equal(anthropicCalls.length, 0, "nothing to generate when description, French and cover are all given");
  assert.equal(olCalls.length, 0);
});

test("add: valid condition and status values are kept (reserved/sold/donated/damaged)", async () => {
  for (const [condition, status] of [["like_new", "reserved"], ["poor", "sold"], ["fair", "donated"], ["new", "damaged"]]) {
    const title = `Vocab ${tag()}`;
    // A NEW book needs its publisher's price (French fixed-price law).
    const extra = condition === "new" ? { publisherPrice: "10", price: "10" } : {};
    await post("/admin/inventory", { fields: { title, description: "d", descriptionFr: "d", coverUrl: "c", condition, status, ...extra } });
    const [book] = await bookByTitle(title);
    const [copy] = await copiesOf(book.id);
    assert.deepEqual([copy.condition, copy.status], [condition, status]);
  }
});

test("add: missing optional fields become NULL / defaults; fromScan returns to the scan page", async () => {
  const title = `Minimal ${tag()}`;
  ai.fail = true; // no AI, no cover found: still saves
  const { status, location } = await post("/admin/inventory", { fields: { title, fromScan: "1" } });
  assert.equal(status, 302);
  assert.equal(location, "/admin/inventory/scan?saved=1");
  const [book] = await bookByTitle(title);
  assert.deepEqual([book.isbn, book.authors, book.publisher, book.published_year, book.description, book.description_fr, book.cover_url, book.categories, book.categories_fr],
    [null, null, null, null, null, null, null, null, null]);
  const [copy] = await copiesOf(book.id);
  assert.deepEqual([copy.price, copy.acquisition_cost, copy.acquired_at, copy.notes], [null, null, null, null]);
});

test("add: a missing description is generated and translated; a missing cover is looked up by ISBN", async () => {
  const title = `Auto ${tag()}`;
  const isbn = isbn13();
  openLibrary.isbn.set(isbn, { title, cover: { large: "https://covers.example/auto.jpg" } });
  ai.description = "Auto blurb.";
  const { location } = await post("/admin/inventory", { fields: { title, isbn, author: "Auto Author" } });
  const [book] = await bookByTitle(title);
  assert.equal(location, `/admin/inventory/${book.id}`);
  assert.equal(book.description, "Auto blurb.");
  assert.equal(book.description_fr, "FR: Auto blurb.");
  assert.equal(book.cover_url, "https://covers.example/auto.jpg");
});

test("add: with no ISBN match the cover falls back to a title/author search", async () => {
  const title = `Searched ${tag()}`;
  openLibrary.search = [{ title: "No cover" }, { title: "With cover", cover_i: 77 }];
  await post("/admin/inventory", { fields: { title, description: "d", descriptionFr: "d" } });
  const [book] = await bookByTitle(title);
  assert.equal(book.cover_url, "https://covers.openlibrary.org/b/id/77-L.jpg");
});

test("add: an uploaded cover photo is stored as a resized JPEG in the image store, overriding the URL field", async () => {
  const title = `Photo ${tag()}`;
  const big = await sharp({ create: { width: 2000, height: 3000, channels: 3, background: "#336699" } }).png().toBuffer();
  await post("/admin/inventory", {
    fields: { title, coverUrl: "https://img.example/ignored.jpg", description: "d", descriptionFr: "d" },
    files: { coverPhoto: { buffer: big, type: "image/png", name: "cover.png" } },
  });
  const [book] = await bookByTitle(title);
  const stored = await storedImage(book.cover_url);
  const meta = await sharp(stored).metadata();
  assert.equal(meta.format, "jpeg", "a PNG upload is converted to JPEG");
  assert.equal(meta.height, 700);
  assert.equal(meta.width, 467);
  assert.ok(stored.length < 50_000, "stored thumbnail is small");
  assert.equal(olCalls.length, 0, "no cover lookup when a photo was supplied");
});

test("add: a small JPEG is not enlarged, and EXIF rotation is applied", async () => {
  const title = `Small ${tag()}`;
  const wide = await sharp({ create: { width: 100, height: 50, channels: 3, background: "#ffffff" } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  await post("/admin/inventory", { fields: { title, description: "d", descriptionFr: "d" }, files: { coverPhoto: { buffer: wide, type: "image/jpeg", name: "c.jpg" } } });
  const [book] = await bookByTitle(title);
  const meta = await sharp(await storedImage(book.cover_url)).metadata();
  assert.deepEqual([meta.width, meta.height], [50, 100], "rotated 90 degrees, not upscaled");
});

test("add: a file that isn't an image is rejected and nothing is saved", async () => {
  const title = `NotImage ${tag()}`;
  const { status } = await post("/admin/inventory", {
    fields: { title, description: "d", descriptionFr: "d" },
    files: { coverPhoto: { buffer: Buffer.from("MZ\x90\x00 definitely not a picture"), type: "image/jpeg", name: "evil.jpg" } },
  });
  assert.equal(status, 500);
  assert.equal((await bookByTitle(title)).length, 0, "no book created");
});

test("add: an upload over the 8MB limit is rejected and nothing is saved", async () => {
  const title = `Oversize ${tag()}`;
  const { status } = await post("/admin/inventory", {
    fields: { title, description: "d", descriptionFr: "d" },
    files: { coverPhoto: { buffer: Buffer.alloc(8 * 1024 * 1024 + 1024, 1), type: "image/jpeg", name: "huge.jpg" } },
  });
  assert.equal(status, 500);
  assert.equal((await bookByTitle(title)).length, 0);
});

test("add: an upload in an unexpected field is rejected", async () => {
  const title = `WrongField ${tag()}`;
  const { status } = await post("/admin/inventory", {
    fields: { title }, files: { avatar: { buffer: await jpeg(), type: "image/jpeg", name: "a.jpg" } },
  });
  assert.equal(status, 500);
  assert.equal((await bookByTitle(title)).length, 0);
});

test("add: a second copy of an ISBN already in stock joins the existing book instead of duplicating it", async () => {
  const isbn = isbn13();
  const b = await seedBook({ isbn, copies: [{ price: 6 }] });
  const { location } = await post("/admin/inventory", { fields: { title: b.title, isbn, price: "4", condition: "fair" } });
  assert.equal(location, `/admin/inventory/${b.id}`);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM books WHERE isbn = $1", [isbn])).rows[0].n, 1);
  const copies = await copiesOf(b.id);
  assert.equal(copies.length, 2);
  assert.deepEqual([copies[1].condition, Number(copies[1].price)], ["fair", 4]);
  assert.equal(anthropicCalls.length, 0, "existing book is complete: nothing regenerated");
  assert.equal(olCalls.length, 0);
});

test("add: a second copy backfills the existing book's missing description, translation and cover", async () => {
  const isbn = isbn13();
  const b = await seedBook({ isbn, cover: null, description: null, descriptionFr: null });
  openLibrary.isbn.set(isbn, { title: b.title, cover: { large: "https://covers.example/backfill.jpg" } });
  ai.description = "Backfilled blurb.";
  await post("/admin/inventory", { fields: { title: b.title, isbn } });
  const [book] = (await pool.query("SELECT * FROM books WHERE id = $1", [b.id])).rows;
  assert.equal(book.description, "Backfilled blurb.");
  assert.equal(book.description_fr, "FR: Backfilled blurb.");
  assert.equal(book.cover_url, "https://covers.example/backfill.jpg");
  assert.equal((await copiesOf(b.id)).length, 2);
});

test("add: a second copy never overwrites what the existing book already has", async () => {
  const isbn = isbn13();
  const b = await seedBook({ isbn, cover: "https://img.example/keep.jpg", description: "Keep me", descriptionFr: null });
  await post("/admin/inventory", {
    fields: { title: b.title, isbn, description: "Different description", coverUrl: "https://img.example/other.jpg" },
  });
  const [book] = (await pool.query("SELECT * FROM books WHERE id = $1", [b.id])).rows;
  assert.equal(book.description, "Keep me");
  assert.equal(book.cover_url, "https://img.example/keep.jpg");
  assert.equal(book.description_fr, "FR: Keep me", "only the missing French text was filled in");
});

// ------------------------------------------------------------------ edit book

test("edit: updates the book's fields, normalising ISBN and genres", async () => {
  const b = await seedBook({ isbn: isbn13() });
  const newTitle = `Renamed ${tag()}`;
  const isbn = isbn13();
  const { status, location } = await post(`/admin/inventory/${b.id}`, {
    fields: {
      title: newTitle, author: "New Author", isbn: `${isbn.slice(0, 3)}-${isbn.slice(3)}`, publisher: "NP", publishedYear: "2010",
      genre: "History,history, Poetry", description: "New description", descriptionFr: "Nouvelle description", coverUrl: "https://img.example/new.jpg",
    },
  });
  assert.equal(status, 302);
  assert.equal(location, `/admin/inventory/${b.id}`);
  const [book] = (await pool.query("SELECT * FROM books WHERE id = $1", [b.id])).rows;
  assert.deepEqual(
    [book.title, book.authors, book.isbn, book.publisher, book.published_year, book.categories, book.categories_fr, book.description, book.description_fr, book.cover_url],
    [newTitle, "New Author", isbn, "NP", 2010, "History, Poetry", "Histoire, Poésie", "New description", "Nouvelle description", "https://img.example/new.jpg"]
  );
  assert.equal((await copiesOf(b.id)).length, 1, "copies untouched");
});

test("edit: a blank title changes nothing (the redirect still happens)", async () => {
  const b = await seedBook();
  const { status } = await post(`/admin/inventory/${b.id}`, { fields: { title: "  ", author: "Hijack" } });
  assert.equal(status, 302);
  const [book] = (await pool.query("SELECT * FROM books WHERE id = $1", [b.id])).rows;
  assert.equal(book.title, b.title);
  assert.equal(book.authors, "Seed Author");
});

test("edit: blanking the description regenerates it, blanking the cover looks one up", async () => {
  const b = await seedBook({ isbn: isbn13() });
  const isbn = (await pool.query("SELECT isbn FROM books WHERE id=$1", [b.id])).rows[0].isbn;
  openLibrary.isbn.set(isbn, { title: b.title, cover: { large: "https://covers.example/edit.jpg" } });
  ai.description = "Regenerated.";
  await post(`/admin/inventory/${b.id}`, { fields: { title: b.title, isbn } });
  const [book] = (await pool.query("SELECT * FROM books WHERE id = $1", [b.id])).rows;
  assert.equal(book.description, "Regenerated.");
  assert.equal(book.description_fr, "FR: Regenerated.");
  assert.equal(book.cover_url, "https://covers.example/edit.jpg");
});

test("edit: uploading a cover photo replaces the cover with a stored JPEG", async () => {
  const b = await seedBook();
  await post(`/admin/inventory/${b.id}`, {
    fields: { title: b.title, description: "d", descriptionFr: "d", coverUrl: "https://img.example/old.jpg" },
    files: { coverPhoto: { buffer: await png(), type: "image/png", name: "n.png" } },
  });
  const [book] = (await pool.query("SELECT cover_url FROM books WHERE id = $1", [b.id])).rows;
  await storedImage(book.cover_url);
});

test("edit: a non-image upload is rejected and the existing cover is kept", async () => {
  const b = await seedBook({ cover: "https://img.example/keep.jpg" });
  const { status } = await post(`/admin/inventory/${b.id}`, {
    fields: { title: `Changed ${b.title}`, description: "d", descriptionFr: "d" },
    files: { coverPhoto: { buffer: Buffer.from("<html>not an image</html>"), type: "image/png", name: "x.png" } },
  });
  assert.equal(status, 500);
  const [book] = (await pool.query("SELECT * FROM books WHERE id = $1", [b.id])).rows;
  assert.equal(book.cover_url, "https://img.example/keep.jpg");
  assert.equal(book.title, b.title, "the whole edit was refused");
});

// ------------------------------------------------------------- copies / status

test("copy update: sets condition/status/price/cost/date/notes and normalises bad values", async () => {
  const b = await seedBook();
  const [copyId] = b.copyIds;
  const { status, location } = await post(`/admin/inventory/${b.id}/copies/${copyId}`, {
    form: { condition: "like_new", status: "sold", price: "11.25", acquisitionCost: "0.5", acquiredAt: "2026-02-01", notes: " signed " },
  });
  assert.equal(status, 302);
  assert.equal(location, `/admin/inventory/${b.id}`);
  let [c] = await copiesOf(b.id);
  assert.deepEqual([c.condition, c.status, Number(c.price), Number(c.acquisition_cost), c.notes], ["like_new", "sold", 11.25, 0.5, "signed"]);

  await post(`/admin/inventory/${b.id}/copies/${copyId}`, { form: { condition: "shiny", status: "borrowed", price: "", acquisitionCost: "", acquiredAt: "", notes: "" } });
  [c] = await copiesOf(b.id);
  assert.deepEqual([c.condition, c.status, c.price, c.acquisition_cost, c.acquired_at, c.notes], ["good", "in_stock", null, null, null, null]);
});

test("copy update: marking each status works (mark sold, donated, damaged, reserved)", async () => {
  const b = await seedBook();
  const [copyId] = b.copyIds;
  for (const status of ["sold", "donated", "damaged", "reserved", "in_stock"]) {
    await post(`/admin/inventory/${b.id}/copies/${copyId}`, { form: { condition: "good", status, price: "5" } });
    assert.equal((await copiesOf(b.id))[0].status, status);
  }
});

test("copy update: a copy id belonging to a different book is not touched", async () => {
  const mine = await seedBook();
  const other = await seedBook({ copies: [{ price: 20 }] });
  await post(`/admin/inventory/${mine.id}/copies/${other.copyIds[0]}`, { form: { condition: "poor", status: "sold", price: "1" } });
  const [c] = await copiesOf(other.id);
  assert.deepEqual([c.condition, c.status, Number(c.price)], ["good", "in_stock", 20]);
});

test("cancel-reservation: releases the copy and clears the reserver's details", async () => {
  const b = await seedBook({ copies: [{ status: "reserved", name: "Resa", email: "resa@example.test", reservedAt: new Date() }] });
  await pool.query("UPDATE book_copies SET reserved_by_phone = '0611', reminder_sent_at = now() WHERE id = $1", [b.copyIds[0]]);
  const { status, location } = await post(`/admin/inventory/${b.id}/copies/${b.copyIds[0]}/cancel-reservation`, { form: {} });
  assert.equal(status, 302);
  assert.equal(location, `/admin/inventory/${b.id}`);
  const [c] = await copiesOf(b.id);
  assert.equal(c.status, "in_stock");
  assert.deepEqual([c.reserved_by_name, c.reserved_by_email, c.reserved_by_phone, c.reserved_at], [null, null, null, null]);
});

test("cancel-reservation: scoped to the book in the URL", async () => {
  const mine = await seedBook();
  const other = await seedBook({ copies: [{ status: "reserved", name: "Keep", email: "keep@example.test", reservedAt: new Date() }] });
  await post(`/admin/inventory/${mine.id}/copies/${other.copyIds[0]}/cancel-reservation`, { form: {} });
  const [c] = await copiesOf(other.id);
  assert.equal(c.status, "reserved");
  assert.equal(c.reserved_by_email, "keep@example.test");
});

test("cancel-reservation: reservation details are visible on the show page until cancelled", async () => {
  const email = `visible-${tag()}@example.test`;
  const b = await seedBook({ copies: [{ status: "reserved", name: "Visible Person", email, reservedAt: new Date() }] });
  const before = await get(`/admin/inventory/${b.id}`);
  assert.ok(before.text.includes("Visible Person") && before.text.includes(email));
  assert.ok(before.text.includes(`/copies/${b.copyIds[0]}/cancel-reservation`));
  await post(`/admin/inventory/${b.id}/copies/${b.copyIds[0]}/cancel-reservation`, { form: {} });
  const after = await get(`/admin/inventory/${b.id}`);
  assert.ok(!after.text.includes(email));
});

test("delete copy: removes only that copy; deleting the last copy removes the book too", async () => {
  const b = await seedBook({ copies: [{}, {}] });
  let r = await post(`/admin/inventory/${b.id}/copies/${b.copyIds[0]}/delete`, { form: {} });
  assert.equal(r.location, `/admin/inventory/${b.id}`);
  assert.deepEqual((await copiesOf(b.id)).map((c) => c.id), [b.copyIds[1]]);
  assert.equal((await pool.query("SELECT 1 FROM books WHERE id = $1", [b.id])).rows.length, 1);

  r = await post(`/admin/inventory/${b.id}/copies/${b.copyIds[1]}/delete`, { form: {} });
  assert.equal(r.location, "/admin/inventory");
  assert.equal((await pool.query("SELECT 1 FROM books WHERE id = $1", [b.id])).rows.length, 0);
});

test("delete copy: a copy id from another book is not deleted", async () => {
  const mine = await seedBook();
  const other = await seedBook();
  await post(`/admin/inventory/${mine.id}/copies/${other.copyIds[0]}/delete`, { form: {} });
  assert.equal((await copiesOf(other.id)).length, 1);
});

test("delete book: removes the book and cascades to its copies", async () => {
  const b = await seedBook({ copies: [{}, {}, {}] });
  const { status, location } = await post(`/admin/inventory/${b.id}/delete`, { form: {} });
  assert.equal(status, 302);
  assert.equal(location, "/admin/inventory");
  assert.equal((await pool.query("SELECT 1 FROM books WHERE id = $1", [b.id])).rows.length, 0);
  assert.equal((await copiesOf(b.id)).length, 0);
  assert.equal((await get(`/admin/inventory/${b.id}`)).status, 404);
});
