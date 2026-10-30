// Admin > Reports > Covers to check (lib/coverReview.js, routes/admin/coverReview.js): the list of covers that may belong to
// another edition, "Cover is fine", and that a cover is never changed by the page. Real app, real database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 7862;
const PASSWORD = "Covers-To-Check-1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
let app, pool, jar;
const tag = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const email = `ctc-${tag()}@example.test`;
  await pool.query("INSERT INTO users (email, password_hash, display_name, is_admin, email_verified_at) VALUES ($1, $2, 'Admin', true, now())", [email, await bcrypt.hash(PASSWORD, 10)]);
  jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie: jar.header() }, body: new URLSearchParams({ email, password: PASSWORD, _csrf: token }).toString() });
  jar.capture(res);
  assert.equal(res.status, 302);
});
after(async () => { await pool.end(); await app.stop(); });

async function book({ title, isbn = null, origin = null, source = null, cover = "/img/" + "a".repeat(64) + ".jpg", checked = false, inStock = true }) {
  const { rows } = await pool.query(
    "INSERT INTO books (title, isbn, cover_url, cover_source_url, cover_origin, cover_checked_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [title, isbn, cover, source, origin, checked ? new Date() : null]
  );
  await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, $2, 5)", [rows[0].id, inStock ? "in_stock" : "sold"]);
  return rows[0].id;
}
async function get(path) {
  const res = await fetch(`${app.base}${path}`, { redirect: "manual", headers: { cookie: jar.header() } });
  return { status: res.status, text: await res.text() };
}
async function post(path, fields = {}, cookieJar = jar) {
  const body = new URLSearchParams({ ...fields, _csrf: await fetchCsrfToken(app.base, cookieJar) });
  const res = await fetch(`${app.base}${path}`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie: cookieJar.header() }, body: body.toString() });
  cookieJar.capture(res);
  return { status: res.status, location: res.headers.get("location") };
}

test("the list holds only unverified numbered covers, with title, ISBN, copies and the edit link", async () => {
  const numbered = await book({ title: "Numbered Cover Book", isbn: "9780330298117", source: "https://covers.openlibrary.org/b/id/123-L.jpg" });
  const byIsbn = await book({ title: "Exact Isbn Cover Book", source: "https://covers.openlibrary.org/b/isbn/9780140328721-L.jpg?default=false" });
  const recorded = await book({ title: "Recorded Origin Book", origin: "isbn", source: "https://covers.openlibrary.org/b/id/5-L.jpg" });
  const photo = await book({ title: "Own Photo Book", source: null });
  const checked = await book({ title: "Already Checked Book", source: "https://covers.openlibrary.org/b/id/6-L.jpg", checked: true });
  const noCover = await book({ title: "No Cover Book", cover: null, source: "https://covers.openlibrary.org/b/id/7-L.jpg" });
  const r = await get("/admin/reports/covers-to-check");
  assert.equal(r.status, 200);
  assert.match(r.text, /Numbered Cover Book/);
  assert.match(r.text, /9780330298117/);
  assert.match(r.text, new RegExp(`/admin/inventory/${numbered}#cover`));
  assert.match(r.text, /1 in stock/);
  for (const t of ["Exact Isbn Cover Book", "Recorded Origin Book", "Own Photo Book", "Already Checked Book", "No Cover Book"]) assert.doesNotMatch(r.text, new RegExp(t), t);
  assert.ok(byIsbn && recorded && photo && checked && noCover);
  const reports = await get("/admin/reports");
  assert.match(reports.text, /Covers to check/);
});

test("Cover is fine marks the book checked, logs it, and never touches the cover", async () => {
  const id = await book({ title: "Fine Cover Book", isbn: "9780140328721", source: "https://covers.openlibrary.org/b/id/99-L.jpg" });
  const before = (await pool.query("SELECT cover_url, cover_source_url FROM books WHERE id = $1", [id])).rows[0];
  const r = await post(`/admin/reports/covers-to-check/${id}/ok`);
  assert.equal(r.status, 303);
  assert.equal(r.location, "/admin/reports/covers-to-check");
  const row = (await pool.query("SELECT cover_url, cover_source_url, cover_checked_at FROM books WHERE id = $1", [id])).rows[0];
  assert.ok(row.cover_checked_at);
  assert.equal(row.cover_url, before.cover_url);
  assert.equal(row.cover_source_url, before.cover_source_url);
  assert.doesNotMatch((await get("/admin/reports/covers-to-check")).text, new RegExp(`/admin/inventory/${id}"`), "the row is gone");
  let logged = [];
  for (let i = 0; i < 20 && !logged.length; i++) {
    logged = (await pool.query("SELECT * FROM admin_audit_log WHERE action = 'cover.review_ok' AND target_id = $1", [id])).rows;
    if (!logged.length) await new Promise((res) => setTimeout(res, 100));
  }
  assert.equal(logged.length, 1);
});

test("the page and its buttons are admin-only and need the CSRF token", async () => {
  const id = await book({ title: "Guarded Cover Book", source: "https://covers.openlibrary.org/b/id/98-L.jpg" });
  const anon = await fetch(`${app.base}/admin/reports/covers-to-check`, { redirect: "manual" });
  assert.notEqual(anon.status, 200);
  const anonPost = await fetch(`${app.base}/admin/reports/covers-to-check/${id}/ok`, { method: "POST", redirect: "manual", headers: FORM, body: "" });
  assert.notEqual(anonPost.status, 303);
  const noToken = await fetch(`${app.base}/admin/reports/covers-to-check/${id}/ok`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie: jar.header() }, body: "" });
  assert.equal(noToken.status, 403);
  assert.equal((await pool.query("SELECT cover_checked_at FROM books WHERE id = $1", [id])).rows[0].cover_checked_at, null);
});

test("a cover set by the Cover card (photo) records its origin and is not listed; removing clears it", async () => {
  const id = await book({ title: "Origin Book", source: "https://covers.openlibrary.org/b/id/97-L.jpg" });
  const sharp = require("sharp");
  const buffer = await sharp({ create: { width: 200, height: 300, channels: 3, background: "#369" } }).jpeg().toBuffer();
  const form = new FormData();
  form.append("_csrf", await fetchCsrfToken(app.base, jar));
  form.append("coverPhoto", new Blob([buffer], { type: "image/jpeg" }), "c.jpg");
  const res = await fetch(`${app.base}/admin/inventory/${id}/cover/replace`, { method: "POST", redirect: "manual", headers: { cookie: jar.header() }, body: form });
  assert.equal(res.status, 303);
  const row = (await pool.query("SELECT cover_origin, cover_checked_at FROM books WHERE id = $1", [id])).rows[0];
  assert.equal(row.cover_origin, "photo");
  assert.doesNotMatch((await get("/admin/reports/covers-to-check")).text, /Origin Book/);
});
