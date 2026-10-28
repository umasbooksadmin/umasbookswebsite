// Saving a book copy is idempotent (Review A, L2; lib/intakeToken.js): the form carries a one-time
// token, and the same token again returns the first save's answer instead of adding a second copy
// that customers could reserve. Outbound HTTP is stubbed at global.fetch as in fastScanIntake.test.js.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const multer = require("multer");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");

const db = prepareDatabase("intake_idem", { isolated: true });
const { pool } = require("../../src/db");
const { BINDINGS } = require("../../src/lib/inventory");
const { requireAdmin } = require("../../src/middleware/auth");
const coverStore = require("../../src/lib/coverStore");
coverStore.setLookupForTests(async () => [{ address: "93.184.216.34", family: 4 }]);

const realFetch = global.fetch;
const openLibrary = new Map();
const olCalls = [];
global.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1:")) return realFetch(url, init);
  if (u.startsWith("https://openlibrary.org/")) {
    olCalls.push(u);
    const m = u.match(/\/isbn\/([0-9X]+)\.json$/);
    if (m) {
      const data = openLibrary.get(m[1]);
      return new Response(JSON.stringify(data ? { records: { r: { isbns: [m[1]], data } } } : {}), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ docs: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`test refused a real outbound request to ${u}`);
};

let server;
let adminId;
before(async () => {
  db.create();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
  const gate = express.Router();
  gate.use("/admin/inventory", requireAdmin, upload.fields([{ name: "photo", maxCount: 1 }, { name: "coverPhoto", maxCount: 1 }]));
  server = await listen(buildApp([gate, require("../../src/routes/admin/inventoryLookup"), require("../../src/routes/admin/inventory")]));
  const { rows } = await pool.query("INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ($1, 'x', 'Scan Admin', true) RETURNING id", [`scan-admin-${Date.now()}@example.test`]);
  adminId = rows[0].id;
});
after(async () => {
  global.fetch = realFetch;
  await server.close();
  await pool.end();
  db.drop();
});
beforeEach(() => { openLibrary.clear(); olCalls.length = 0; });

let seq = 0;
const uniq = () => `${Date.now()}x${++seq}`;
const { isbn13From } = require("../helpers/isbn");
const isbn13 = () => isbn13From(`979${String(Date.now()).slice(-5)}${String(++seq).padStart(4, "0")}`); // 13 digits, unique, a real check digit (the lookup refuses a wrong one)
const adminHeader = () => ({ "x-test-user": JSON.stringify({ id: adminId, email: "a@example.test", displayName: "Admin", isAdmin: true }) });
const memberHeader = () => ({ "x-test-user": JSON.stringify({ id: adminId, email: "m@example.test", displayName: "M", isAdmin: false, isMember: true }) });

let cookie = ""; // the session cookie: the lookup page is shown once from the session after a redirect
async function request(path, { method = "GET", form, headers = adminHeader() } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  let body;
  if (form) { body = new URLSearchParams(form).toString(); h["content-type"] = "application/x-www-form-urlencoded"; }
  const res = await realFetch(`${server.base}${path}`, { method, redirect: "manual", headers: h, body, signal: AbortSignal.timeout(15000) });
  const set = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  if (set.length) cookie = set.join("; ");
  return { res, text: await res.text(), status: res.status, location: res.headers.get("location") };
}
const get = (p, o) => request(p, o);
const post = (p, o) => request(p, { ...o, method: "POST" });
const asJson = { accept: "application/json" };

const copyBody = (title, extra = {}) => ({ title, description: "d", coverUrl: "https://example.test/c.jpg", status: "in_stock", condition: "very_good", price: "5", ...extra });


const tok = () => `tok-${uniq()}-abcdefghij`;
const copies = async (title) => (await pool.query("SELECT c.id FROM book_copies c JOIN books b ON b.id = c.book_id WHERE b.title = $1", [title])).rows;
const save = (form, headers = asJson) => post("/admin/inventory", { form, headers: { ...adminHeader(), ...headers } });

test("the same token twice gives one copy and the same answer", async () => {
  const title = `Once ${uniq()}`;
  const form = copyBody(title, { fast: "1", intakeToken: tok() });
  const a = await save(form);
  const b = await save(form);
  const ja = JSON.parse(a.text);
  const jb = JSON.parse(b.text);
  assert.equal(ja.ok, true);
  assert.equal(jb.ok, true);
  assert.equal(jb.copyId, ja.copyId, "the earlier result");
  assert.equal(jb.bookId, ja.bookId);
  assert.equal(jb.title, title);
  assert.equal((await copies(title)).length, 1);
});

test("identical requests at the same moment (no ISBN) create one book and one copy", async () => {
  const title = `Race ${uniq()}`;
  const form = copyBody(title, { fast: "1", intakeToken: tok() });
  const results = await Promise.all([save(form), save(form), save(form)]);
  const ids = new Set(results.map((r) => JSON.parse(r.text).copyId));
  assert.equal(ids.size, 1);
  assert.equal((await copies(title)).length, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM books WHERE title = $1", [title])).rows[0].n, 1);
});

test("two different tokens are two copies", async () => {
  const title = `Twice ${uniq()}`;
  const isbn = isbn13();
  const a = JSON.parse((await save(copyBody(title, { isbn, fast: "1", intakeToken: tok() }))).text);
  const b = JSON.parse((await save(copyBody(title, { isbn, fast: "1", intakeToken: tok() }))).text);
  assert.notEqual(a.copyId, b.copyId);
  assert.equal(a.bookId, b.bookId);
  assert.equal((await copies(title)).length, 2);
});

test("the form without JavaScript: a repeated token redirects to the same book, no second copy", async () => {
  const title = `Plain ${uniq()}`;
  const form = copyBody(title, { intakeToken: tok() });
  const a = await save(form, {});
  const b = await save(form, {});
  assert.equal(a.status, 302);
  assert.equal(b.location, a.location);
  assert.equal((await copies(title)).length, 1);
});

test("a request without a token still saves (older cached page): two posts, two copies", async () => {
  const title = `Legacy ${uniq()}`;
  const isbn = isbn13();
  await save(copyBody(title, { isbn, fast: "1" }));
  await save(copyBody(title, { isbn, fast: "1" }));
  assert.equal((await copies(title)).length, 2);
});

test("a refused save does not use up the token", async () => {
  const title = `Refused ${uniq()}`;
  const token = tok();
  const bad = await save(copyBody(title, { fast: "1", intakeToken: token, price: "abc" }));
  assert.equal(bad.status, 422);
  const ok = JSON.parse((await save(copyBody(title, { fast: "1", intakeToken: token }))).text);
  assert.equal(ok.ok, true);
  assert.equal((await copies(title)).length, 1);
});

test("a token older than the window no longer counts", async () => {
  const title = `Old ${uniq()}`;
  const token = tok();
  await save(copyBody(title, { fast: "1", intakeToken: token }));
  await pool.query("UPDATE copy_intake_tokens SET created_at = now() - interval '11 minutes' WHERE token = $1", [token]);
  await save(copyBody(title, { fast: "1", intakeToken: token }));
  assert.equal((await copies(title)).length, 2);
});

test("a token released after a failure can be claimed again", async () => {
  const intake = require("../../src/lib/intakeToken");
  const token = tok();
  assert.equal((await intake.claim(pool, token)).state, "claimed");
  await intake.release(pool, token);
  assert.equal((await intake.claim(pool, token)).state, "claimed");
});

test("the Add Book form and the scan form carry a fresh token each time", async () => {
  const a = await get("/admin/inventory/new");
  const b = await get("/admin/inventory/new");
  const re = /name="intakeToken" value="([A-Za-z0-9_-]{16,64})"/;
  assert.match(a.text, re);
  assert.notEqual(a.text.match(re)[1], b.text.match(re)[1]);
});
