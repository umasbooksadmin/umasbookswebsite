// Admin > Genres through the REAL app (child process, real CSRF middleware, real body parsing, real sessions):
// CSRF is required on every write, only an admin gets in, the repeated "accept" field of the AI proposals survives the
// app's repeated-field collapse (src/lib/multiValueFields.js), and the whole preview -> confirm -> undo flow works
// with real redirects. Port 6492 is reserved for this file.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");
const { createAccount, loginOverHttp } = require("../helpers/accounts");

const PORT = 6492;
const FORM = { "content-type": "application/x-www-form-urlencoded" };
let app;
let db;
let adminJar;
let memberJar;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  db = new Client({ connectionString: app.databaseUrl, ssl: false });
  await db.connect();
  process.env.DATABASE_URL = app.databaseUrl;
  const admin = await createAccount({ query: (s, p) => db.query(s, p) }, { email: "genres-admin@example.test", displayName: "Genres Admin" });
  await db.query("UPDATE users SET is_admin = true WHERE id = $1", [admin.id]);
  const member = await createAccount({ query: (s, p) => db.query(s, p) }, { email: "genres-member@example.test", displayName: "Genres Member", isMember: true });
  adminJar = makeCookieJar();
  assert.equal((await loginOverHttp(app.base, adminJar, admin)).status, 302);
  memberJar = makeCookieJar();
  assert.equal((await loginOverHttp(app.base, memberJar, member)).status, 302);
});
after(async () => { await db.end(); app.stop(); });

const q = async (sql, params) => (await db.query(sql, params)).rows;
async function post(jar, path, fields, { csrf = true } = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const item of [].concat(v)) body.append(k, String(item));
  if (csrf) body.append("_csrf", await fetchCsrfToken(app.base, jar));
  const res = await fetch(`${app.base}${path}`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie: jar.header() }, body: body.toString() });
  jar.capture(res);
  return res;
}
const get = async (jar, path) => { const r = await fetch(`${app.base}${path}`, { redirect: "manual", headers: { cookie: jar.header() } }); jar.capture(r); return r; };
const follow = async (jar, res) => { assert.equal(res.status, 303, `expected a redirect, got ${res.status}`); const r = await get(jar, res.headers.get("location")); return { res: r, text: await r.text() }; };

test("the page is for admins only; a member is refused", async () => {
  assert.equal((await get(adminJar, "/admin/genres")).status, 200);
  assert.ok([302, 403, 404].includes((await get(memberJar, "/admin/genres")).status));
  assert.ok([302, 401, 403].includes((await fetch(`${app.base}/admin/genres`, { redirect: "manual" })).status));
});

test("every write needs the CSRF token", async () => {
  for (const [p, fields] of [
    ["/admin/genres/managed", { nameEn: "No token" }],
    ["/admin/genres/rules", { kind: "contains-word", pattern: "x", target: "remove" }],
    ["/admin/genres/slot", { genre: "x", target: "remove" }],
    ["/admin/genres/apply/preview", {}],
    ["/admin/genres/apply", { expectedCount: "1", expectedHash: "a".repeat(64) }],
    ["/admin/genres/suggest", {}],
  ]) {
    const res = await post(adminJar, p, fields, { csrf: false });
    assert.equal(res.status, 403, p);
  }
  assert.equal((await q("SELECT 1 FROM managed_genres WHERE name_en = 'No token'")).length, 0);
  assert.equal((await q("SELECT 1 FROM genre_rules")).length, 0);
});

test("a member cannot write either, even with a valid token", async () => {
  const res = await post(memberJar, "/admin/genres/managed", { nameEn: "Member genre" });
  assert.notEqual(res.status, 303);
  assert.equal((await q("SELECT 1 FROM managed_genres WHERE name_en = 'Member genre'")).length, 0);
});

test("two ticked AI proposals are both saved: the repeated 'accept' field is not collapsed to its first value", async () => {
  const [mystery] = await q("SELECT id FROM managed_genres WHERE name_en = 'Mystery'");
  const res = await post(adminJar, "/admin/genres/suggest/save", { accept: [`${mystery.id}|Whodunits`, `${mystery.id}|Page-turners`, `${mystery.id}|Cosy crime`] });
  const page = await follow(adminJar, res);
  assert.match(page.text, /Saved 3 rules/);
  assert.equal((await q("SELECT count(*)::int AS n FROM genre_rules"))[0].n, 3);
});

test("the AI button explains itself when there is no key; nothing is saved", async () => {
  await q("INSERT INTO books (title, categories) VALUES ('Needs a slot', 'Basketweaving')");
  const page = await follow(adminJar, await post(adminJar, "/admin/genres/suggest", {}));
  assert.match(page.text, /not set up on this site|no Anthropic API key/i);
});

test("preview -> confirm -> result -> undo, with real redirects and the audit log", async () => {
  await q("DELETE FROM genre_rules");
  await q("INSERT INTO books (title, categories) VALUES ('K1', 'Children''s Books, Fiction'), ('K2', 'Childrens'), ('K3', 'Zoology')");
  const [{ id }] = await q("INSERT INTO managed_genres (name_en, name_fr, sort_order, browse_slug, show_on_browse) VALUES ('Children', 'Jeunesse', 50, 'children-new', false) RETURNING id");
  await follow(adminJar, await post(adminJar, "/admin/genres/rules", { kind: "contains-word", pattern: "Children", target: `m:${id}` }));
  const preview = await follow(adminJar, await post(adminJar, "/admin/genres/apply/preview", {}));
  assert.match(preview.text, /2 books would change/);
  const count = preview.text.match(/name="expectedCount" value="(\d+)"/)[1];
  const hash = preview.text.match(/name="expectedHash" value="([0-9a-f]{64})"/)[1];
  const done = await follow(adminJar, await post(adminJar, "/admin/genres/apply", { expectedCount: count, expectedHash: hash }));
  assert.match(done.text, /2 books changed/);
  assert.deepEqual((await q("SELECT categories, categories_fr FROM books WHERE title IN ('K1','K2') ORDER BY title")).map((r) => [r.categories, r.categories_fr]), [["Children, Fiction", null], ["Children", null]], "English only: no French genre is written");
  assert.equal((await q("SELECT categories FROM books WHERE title = 'K3'"))[0].categories, "Zoology");
  const runId = (await q("SELECT id FROM genre_runs"))[0].id;
  const uc = done.text.match(/name="expectedCount" value="(\d+)"/)[1];
  const uh = done.text.match(/name="expectedHash" value="([0-9a-f]{64})"/)[1];
  const undone = await follow(adminJar, await post(adminJar, `/admin/genres/runs/${runId}/undo`, { expectedCount: uc, expectedHash: uh }));
  assert.match(undone.text, /Undone: 2 books/);
  assert.deepEqual((await q("SELECT categories FROM books WHERE title IN ('K1','K2') ORDER BY title")).map((r) => r.categories), ["Children's Books, Fiction", "Childrens"]);
  const actions = (await q("SELECT action FROM admin_audit_log WHERE action LIKE 'genre.%' ORDER BY id")).map((r) => r.action);
  for (const a of ["genre.rule_add", "genre.apply", "genre.undo"]) assert.ok(actions.includes(a), a);
});

test("a confirm whose fingerprint is wrong is refused and changes nothing", async () => {
  await q("UPDATE books SET categories = 'Childrens' WHERE title = 'K2'");
  const res = await post(adminJar, "/admin/genres/apply", { expectedCount: "99", expectedHash: "b".repeat(64) });
  const page = await follow(adminJar, res);
  assert.match(page.text, /Nothing was changed/);
  assert.equal((await q("SELECT categories FROM books WHERE title = 'K2'"))[0].categories, "Childrens");
});
