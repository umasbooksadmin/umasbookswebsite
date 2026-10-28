// Every genre list of the ADMIN is A to Z by name, ignoring capitals and accents (Sharon, 2026-10-28: "in the admin genre
// page, sort all genres in the page and in the drop downs alphabetically"), while the CUSTOMER Browse buttons keep their
// manual order (Browse position, managed_genres.browse_order). Through the REAL app (child process, real sessions, real
// CSRF) on a database of this file's own, with managed genres whose stored orders are NOT alphabetical: a lower-case name,
// an accented one and one with "&". Port 6495 is reserved for this file.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");
const { createAccount, loginOverHttp } = require("../helpers/accounts");

const PORT = 6495;
const FORM = { "content-type": "application/x-www-form-urlencoded" };
let app;
let db;
let jar;

// [name, sort_order (the old admin order), browse_order (the customer Browse order)]: neither is alphabetical.
const MANAGED = [
  ["zoology", 1, 1],
  ["Mystery", 2, 2],
  ["Éducation", 3, 3],
  ["art & Design", 4, 4],
  ["Biography", 5, 5],
  ["Elves", 6, 6],
];
const A_TO_Z = ["art & Design", "Biography", "Éducation", "Elves", "Mystery", "zoology"];
const BROWSE_ORDER = ["zoology", "Mystery", "Éducation", "art & Design", "Biography", "Elves"];
// Genres on books that are not managed ("Other" in the Inventory filter, Found genres on the Genres page).
const OTHER_A_TO_Z = ["Adult Fantasy", "apples", "Ćevapi", "Épic Fantasy", "Yoga", "Zany Fantasy"];

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  db = new Client({ connectionString: app.databaseUrl, ssl: false });
  await db.connect();
  process.env.DATABASE_URL = app.databaseUrl;
  await db.query("DELETE FROM genre_rules");
  await db.query("DELETE FROM managed_genres");
  for (const [name, sort, browse] of MANAGED) {
    await db.query(
      "INSERT INTO managed_genres (name_en, sort_order, show_on_browse, browse_slug, browse_order, colour, icon) VALUES ($1, $2, true, $3, $4, 'sage', 'book')",
      [name, sort, `g${sort}`, browse]
    );
  }
  // Zany Fantasy has the most books, so a "most books first" list would not be A to Z.
  const books = [["Zany Fantasy, Mystery"], ["Zany Fantasy"], ["Zany Fantasy"], ["Yoga"], ["apples, Ćevapi"], ["Adult Fantasy"], ["Épic Fantasy, Elves"]];
  for (const [i, [cats]] of books.entries()) await db.query("INSERT INTO books (title, categories) VALUES ($1, $2)", [`Alpha ${i}`, cats]);
  const admin = await createAccount({ query: (s, p) => db.query(s, p) }, { email: "genres-alpha@example.test", displayName: "Alpha Admin" });
  await db.query("UPDATE users SET is_admin = true WHERE id = $1", [admin.id]);
  jar = makeCookieJar();
  assert.equal((await loginOverHttp(app.base, jar, admin)).status, 302);
});
after(async () => { await db.end(); app.stop(); });

const q = async (sql, params) => (await db.query(sql, params)).rows;
const unescape = (s) => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
const get = async (path) => {
  const r = await fetch(`${app.base}${path}`, { redirect: "manual", headers: { cookie: jar.header() } });
  jar.capture(r);
  assert.equal(r.status, 200, path);
  return r.text();
};
async function post(path, fields) {
  const body = new URLSearchParams({ ...fields, _csrf: await fetchCsrfToken(app.base, jar) });
  const res = await fetch(`${app.base}${path}`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie: jar.header() }, body: body.toString() });
  jar.capture(res);
  assert.equal(res.status, 303, path);
}
const optionTexts = (html) => [...html.matchAll(/<option\b[^>]*>([^<]*)<\/option>/g)].map((m) => unescape(m[1]));
const selectById = (html, id) => html.match(new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`))[1];
const managedGroup = (selectHtml) => optionTexts(selectHtml.match(/<optgroup label="Managed genres">([\s\S]*?)<\/optgroup>/)[1]);

test("the seed really is out of alphabetical order (so the checks below mean something)", async () => {
  const bySort = (await q("SELECT name_en FROM managed_genres ORDER BY sort_order, id")).map((r) => r.name_en);
  assert.notDeepEqual(bySort, A_TO_Z);
  assert.deepEqual(bySort, BROWSE_ORDER);
});

test("Admin > Genres: the managed list, the add-rule dropdown, a saved rule's dropdown and every Slot into... dropdown are A to Z", async () => {
  const [mystery] = await q("SELECT id FROM managed_genres WHERE name_en = 'Mystery'");
  await post("/admin/genres/rules", { kind: "contains-word", pattern: "Fantasy", target: `m:${mystery.id}` });
  const html = await get("/admin/genres");

  const managedNames = [...html.matchAll(/<input form="mg-\d+" name="nameEn" value="([^"]*)"/g)].map((m) => unescape(m[1]));
  assert.deepEqual(managedNames, A_TO_Z, "Managed genres table");
  assert.deepEqual(managedGroup(selectById(html, "gn-target")), A_TO_Z, "Add a rule: becomes ...");

  const ruleSelect = html.match(/<select form="rule-\d+" name="target"[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.deepEqual(managedGroup(ruleSelect), A_TO_Z, "a saved rule's Becomes dropdown");
  assert.match(ruleSelect, new RegExp(`<option value="m:${mystery.id}" selected>Mystery</option>`), "the rule's own target stays selected");

  const slots = [...html.matchAll(/<select name="target" aria-label="Slot [^"]*"[^>]*>([\s\S]*?)<\/select>/g)].map((m) => m[1]);
  assert.ok(slots.length >= OTHER_A_TO_Z.length);
  for (const s of slots) {
    assert.equal(optionTexts(s)[0], "Slot into...", "the placeholder stays first");
    assert.deepEqual(managedGroup(s), A_TO_Z, "Slot into... dropdown");
  }

  // No up/down arrows any more on the managed genres (the list is A to Z); the Browse position box is still there and
  // the page says the Browse page follows it.
  assert.doesNotMatch(html, /aria-label="Move [^"]* (up|down)"[^>]*>&[ud]arr;<\/button>\s*<\/form>\s*<a class="gn-link" href="\/admin\/genres\/managed/);
  assert.doesNotMatch(html, /\/admin\/genres\/managed\/\d+\/move/);
  assert.equal([...html.matchAll(/name="browseOrder" type="number"/g)].length, MANAGED.length);
  assert.match(html, /listed A to Z/);
  assert.match(html, /follows the <strong>Browse position<\/strong> numbers/);
});

test("Admin > Genres: Found genres are A to Z by default; the other sorts still work", async () => {
  const names = (html) => [...html.matchAll(/<td class="gn-name">([^<]*)<\/td>/g)].map((m) => unescape(m[1]));
  const all = [...A_TO_Z.filter((n) => ["Mystery", "Elves"].includes(n)), ...OTHER_A_TO_Z].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  assert.deepEqual(names(await get("/admin/genres")), all, "default: Name A to Z");
  assert.match(await get("/admin/genres"), /<option value="name" selected>Name A to Z<\/option>/);
  assert.equal(names(await get("/admin/genres?sort=books"))[0], "Zany Fantasy", "Most books is still available");
  assert.deepEqual(names(await get("/admin/genres?sort=name-desc")), all.slice().reverse());
});

test("Admin > Genres: Show matches lists the genres A to Z", async () => {
  const json = JSON.parse(await get("/admin/genres/rules/preview?kind=contains-word&pattern=Fantasy"));
  const listed = [...json.takes, ...json.handled].map((t) => t.name);
  assert.deepEqual(json.takes.map((t) => t.name), json.takes.map((t) => t.name).slice().sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })));
  assert.deepEqual(json.handled.map((t) => t.name), ["Adult Fantasy", "Épic Fantasy", "Zany Fantasy"], "handled by the saved Fantasy rule, A to Z (not most books first)");
  assert.equal(listed.length, 3);
});

test("Inventory Genre filter: Any and No genre set first, then the managed genres A to Z, then Other (not managed) A to Z", async () => {
  const sel = selectById(await get("/admin/inventory"), "f-genre");
  const opts = optionTexts(sel);
  assert.deepEqual(opts.slice(0, 2), ["Any", "No genre set"]);
  const [managedPart, otherPart] = sel.split('<optgroup label="Other (not managed)">');
  assert.deepEqual(optionTexts(managedPart).slice(2), A_TO_Z);
  assert.deepEqual(optionTexts(otherPart), OTHER_A_TO_Z);

  // A genre typed in the address that is neither managed nor in use is added to Other at its A to Z place, selected.
  const typed = selectById(await get(`/admin/inventory?genre=${encodeURIComponent("Bees")}`), "f-genre").split('<optgroup label="Other (not managed)">')[1];
  assert.deepEqual(optionTexts(typed), ["Adult Fantasy", "apples", "Bees", "Ćevapi", "Épic Fantasy", "Yoga", "Zany Fantasy"]);
  assert.match(typed, /<option value="Bees" selected>Bees<\/option>/);
});

test("CUSTOMER Browse buttons keep the manual Browse position (not A to Z), in English and in French; sort_order is untouched", async () => {
  const before = await q("SELECT id, sort_order, browse_order FROM managed_genres ORDER BY id");
  for (const path of ["/books.html", "/fr/books.html"]) {
    const res = await fetch(`${app.base}${path}`);
    const html = await res.text();
    const list = html.match(/<div class="bk-track bk-tiles" id="bk-genre-list"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/section>/)[1];
    const labels = [...list.matchAll(/<span data-i18n="g\.[a-z0-9-]+"(?: lang="en")?>([^<]*)<\/span>/g)].map((m) => unescape(m[1]));
    assert.deepEqual(labels.slice(0, MANAGED.length), BROWSE_ORDER, `${path}: Browse position order`);
  }
  await get("/admin/genres");
  await get("/admin/inventory");
  assert.deepEqual(await q("SELECT id, sort_order, browse_order FROM managed_genres ORDER BY id"), before, "showing the admin pages changes no stored order");
});

test("changing a Browse position on Admin > Genres still moves the customer button; the admin list stays A to Z", async () => {
  const [elves] = await q("SELECT * FROM managed_genres WHERE name_en = 'Elves'");
  await post(`/admin/genres/managed/${elves.id}`, { nameEn: "Elves", colour: elves.colour, icon: elves.icon, showOnBrowse: "1", browseOrder: "0" });
  const html = await (await fetch(`${app.base}/books.html`)).text();
  const first = html.match(/id="bk-genre-list"[\s\S]*?<span data-i18n="g\.[a-z0-9-]+">([^<]*)<\/span>/)[1];
  assert.equal(first, "Elves", "Browse position 0 puts Elves first on the Browse page");
  const admin = await get("/admin/genres");
  assert.deepEqual([...admin.matchAll(/<input form="mg-\d+" name="nameEn" value="([^"]*)"/g)].map((m) => unescape(m[1])), A_TO_Z);
});
