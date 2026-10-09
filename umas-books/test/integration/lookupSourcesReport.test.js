// Report "Book lookup sources used" (/admin/reports/lookup-sources): admin only, numbers after a few simulated
// lookups (fetch injected; the recorder writes to the test database), the period filter, the CSV, the table
// created by migration 084 and the 36-month pruning. Runs on its own throwaway database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 4390;
const PASSWORD = "Lookup-Test-1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const URL = "/admin/reports/lookup-sources";

let app;
let pool;
let adminJar;
let memberJar;
let stats;
let n = 0;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const { createLookupStats } = require("../../src/lib/lookupStats");
  stats = createLookupStats({ getPool: () => pool, log: () => {} });
  adminJar = await login((await makeUser(true)).email);
  memberJar = await login((await makeUser(false)).email);
});
after(async () => {
  await pool.end();
  app.stop();
});

async function makeUser(admin) {
  const email = `lk-${Date.now()}-${++n}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, email_verified_at) VALUES ($1, $2, $3, $4, now()) RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 4), admin ? "Lookup Admin" : "Lookup Member", admin]
  );
  return { id: rows[0].id, email };
}
async function login(email) {
  const j = makeCookieJar();
  const token = await fetchCsrfToken(app.base, j);
  const res = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: j.header(), "x-forwarded-for": "10.79.1.1" },
    body: new URLSearchParams({ email, password: PASSWORD, _csrf: token }).toString(),
  });
  j.capture(res);
  assert.equal(res.status, 302);
  return j;
}
async function get(path, jar = adminJar) {
  const res = await fetch(`${app.base}${path}`, { redirect: "manual", headers: { cookie: jar ? jar.header() : "", "x-forwarded-for": "10.79.1.1" } });
  return { res, text: await res.text() };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const brief = (isbn, data) => ({ records: { r: { isbns: [isbn], data } } });
function internet(h = {}) {
  return async (url) => {
    const u = String(url);
    if (u.includes("openlibrary.org/api/volumes/brief")) return (h.brief || (() => json({})))();
    if (u.includes("openlibrary.org/api/books")) return (h.data || (() => json({})))();
    if (u.includes("googleapis.com")) return (h.google || (() => json({ totalItems: 0 })))();
    if (u.includes("catalogue.bnf.fr")) return (h.bnf || (() => new Response("<x/>")))();
    throw new Error(`unexpected request ${u}`);
  };
}
const GOOGLE = (isbn13) => ({ totalItems: 1, items: [{ volumeInfo: { title: "G", authors: ["G A"], publisher: "G Pub", publishedDate: "2010", description: "From Google.", industryIdentifiers: [{ type: "ISBN_13", identifier: isbn13 }] } }] });
const lookup = async (isbn, f, cache) => {
  const { lookupByIsbnDetailed, createTtlCache } = require("../../src/lib/bookLookup");
  return lookupByIsbnDetailed(isbn, { fetchImpl: f, cache: cache || createTtlCache(), hedgeMs: 0, timeoutMs: 1500, graceMs: 40, lateMs: 60, stats });
};

// The table cells of the "Per source" table: { "Open Library": [asked, won, filled, ...] }.
function sourceRows(html) {
  const section = html.split("Per source")[1].split("</table>")[0];
  const out = {};
  for (const tr of section.split("<tr>").slice(2)) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
    if (cells.length) out[cells[0]] = cells.slice(1);
  }
  return out;
}

test("the table exists with the (day, source) key", async () => {
  const { rows } = await pool.query("SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = 'lookup_source_stats'::regclass AND i.indisprimary ORDER BY a.attname");
  assert.deepEqual(rows.map((r) => r.attname), ["day", "source"]);
});

test("admin only: a guest is sent to login, a non-admin is refused, the CSV too", async () => {
  for (const path of [URL, `${URL}?format=csv`]) {
    const guest = await get(path, null);
    assert.ok([302, 303].includes(guest.res.status), `guest: ${guest.res.status}`);
    const member = await get(path, memberJar);
    assert.ok([302, 303, 403].includes(member.res.status), `member: ${member.res.status}`);
    assert.doesNotMatch(member.text, /Per source/);
  }
});

test("after simulated lookups the report shows the counts, rates and no ISBN", async () => {
  const isbnA = "9780143127550";
  const isbnB = "9780306406157";
  const isbnC = "9781400033416";
  // A: Open Library has it, Google fills the description.  B: nobody.  C: only Google has it.  A again: cache.
  const cache = require("../../src/lib/bookLookup").createTtlCache();
  await lookup(isbnA, internet({ brief: () => json(brief(isbnA, { title: "Secret Title Alpha" })), google: () => json(GOOGLE(isbnA)) }), cache);
  await lookup(isbnA, internet(), cache);
  await lookup(isbnB, internet(), cache);
  await lookup(isbnC, internet({ google: () => json(GOOGLE(isbnC)) }), cache);
  await lookup("9780141439518", internet({ google: () => json({}, 429) }), cache);

  await stats.flush();
  const { res, text } = await get(URL);
  assert.equal(res.status, 200);
  assert.match(text, /How to read this/);
  assert.match(text, /Last 30 days/);
  assert.doesNotMatch(text, /97801431275|Secret Title Alpha/, "no ISBN or title");
  assert.match(text, /check your ISBNdb plan quota/);
  const rows = sourceRows(text);
  // columns: Asked, title, filled, redundant, nothing, errors, refused, cut short, avg ms
  const ol = rows["Open Library"];
  assert.deepEqual(ol.slice(0, 4), ["4", "1", "0", "0"], "OL asked for A, B, C, D; supplied A's title");
  // for the other three it found nothing, or (when Google's complete answer for C came first) was cut short
  assert.equal(Number(ol[4]) + Number(ol[7]), 3);
  assert.equal(ol[5] + ol[6], "00");
  const g = rows["Google Books"];
  assert.equal(g[0], "4");
  assert.equal(g[1], "1", "Google supplied C");
  assert.equal(g[2], "1", "Google filled A");
  assert.equal(g[3 + 3], "1", "one refused (429)");
  assert.equal(rows["Answered from memory (cache)"][0], "1");
  assert.equal(rows["Not found: filled by hand"][0], "2", "B and D: no title anywhere; C was found by Google");
  assert.ok(rows["ISBNdb (paid)"], "ISBNdb row is always listed");
  assert.equal(rows["ISBNdb (paid)"][0], "0");
  // totals: 5 lookups, 2 found (A and C) + the cache hit for A = 3 found of 5
  assert.match(text, /Lookups \(ISBNs looked up\)<\/td><td[^>]*>5</);
  assert.match(text, /Found with a title<\/td><td[^>]*>3 \(60%\)</);
  assert.match(text, /Answered from memory \(cache hits\)<\/td><td[^>]*>1 \(20%\)</);
});

test("the period filter, per-month and per-day tables, and the ISBNdb paid calls of this month", async () => {
  const day = (k) => new Date(Date.now() - k * 86400000).toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
  await pool.query("DELETE FROM lookup_source_stats");
  const ins = (d, source, asked, won, paid = 0) => pool.query("INSERT INTO lookup_source_stats (day, source, asked, won, paid_calls, ms_sum, ms_n) VALUES ($1, $2, $3, $4, $5, $6, $3)", [d, source, asked, won, paid, asked * 200]);
  await ins(day(0), "google", 10, 4);
  await ins(day(5), "google", 20, 8);
  await ins(day(20), "google", 40, 16);
  await ins(day(120), "google", 80, 32);
  await ins(day(0), "isbndb", 7, 3, 7);
  const col = async (q) => (sourceRows((await get(`${URL}${q}`)).text)["Google Books"] || [])[0];
  assert.equal(await col("?period=today"), "10");
  assert.equal(await col("?period=7d"), "30");
  assert.equal(await col(""), "70", "default: last 30 days");
  assert.equal(await col("?period=30d"), "70");
  assert.equal(await col("?period=all"), "150");
  assert.equal(await col("?period=nonsense"), "70");
  const monthStart = day(0).slice(0, 8) + "01";
  const thisMonth = (await pool.query("SELECT COALESCE(SUM(asked), 0)::int AS n FROM lookup_source_stats WHERE source = 'google' AND day >= $1", [monthStart])).rows[0].n;
  assert.equal(await col("?period=month"), String(thisMonth));
  const all = (await get(`${URL}?period=all`)).text;
  assert.match(all, /Per month/);
  assert.match(all, /Per day/);
  assert.ok(all.includes(day(120)), "the daily table lists the old day");
  assert.match(all, /ISBNdb paid calls this calendar month<\/td><td[^>]*>7</);
  assert.match(all, /Average response \(ms\)/);
  assert.match(all, /<td[^>]*>200</, "average response time is shown");
});

test("the CSV: attachment, header row, counts, no personal data, logged in the admin activity", async () => {
  const res = await fetch(`${app.base}${URL}?format=csv&period=all`, { headers: { cookie: adminJar.header(), "x-forwarded-for": "10.79.1.1" } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.match(res.headers.get("content-disposition"), /attachment; filename="umas-books-lookup-sources-sources-all\.csv"/);
  const body = await res.text();
  assert.match(body, /"Source","Asked","Supplied the title","Only filled missing fields"/);
  assert.match(body, /"Google Books",150,/);
  assert.doesNotMatch(body, /@/);
  const daily = await (await fetch(`${app.base}${URL}?format=csv&table=daily&period=all`, { headers: { cookie: adminJar.header(), "x-forwarded-for": "10.79.1.1" } })).text();
  assert.match(daily, /"Day \(Paris\)","Source"/);
  assert.equal(daily.trim().split("\r\n").length, 1 + 5, "every daily row");
  const { rows } = await pool.query("SELECT 1 FROM admin_audit_log WHERE action = 'report.csv' AND detail = 'lookup-sources'");
  assert.ok(rows.length >= 1);
});

test("the Reports list and the lookup diagnostics page link to the report", async () => {
  assert.match((await get("/admin/reports")).text, /href="\/admin\/reports\/lookup-sources"/);
  assert.match((await get("/admin/diagnostics/lookup")).text, /href="\/admin\/reports\/lookup-sources"/);
});

test("pruning removes daily rows older than 36 months only", async () => {
  const { pruneLookupStats } = require("../../src/lib/lookupStats");
  await pool.query("DELETE FROM lookup_source_stats");
  await pool.query("INSERT INTO lookup_source_stats (day, source, asked) VALUES (current_date - interval '40 months', 'google', 1), (current_date - interval '35 months', 'google', 1), (current_date, 'google', 1)");
  assert.equal(await pruneLookupStats(pool), 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM lookup_source_stats")).rows[0].n, 2);
});

test("the recorder upserts increments into the same (day, source) row", async () => {
  await pool.query("DELETE FROM lookup_source_stats");
  stats.record("bnf", { asked: 1, won: 1, ms: 100 });
  await stats.flush();
  stats.record("bnf", { asked: 2, errors: 1, ms: 300 });
  await stats.flush();
  const { rows } = await pool.query("SELECT asked, won, errors, ms_sum::int AS ms_sum, ms_n FROM lookup_source_stats WHERE source = 'bnf'");
  assert.deepEqual(rows, [{ asked: 3, won: 1, errors: 1, ms_sum: 400, ms_n: 2 }]);
});
