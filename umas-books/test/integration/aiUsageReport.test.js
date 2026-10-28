// "AI usage" section of the report /admin/reports/lookup-sources: admin only, numbers after simulated calls (fetch
// injected; the recorder writes to the test database), the red banner after a credit error, the period filter, the
// CSV tables, the table created by migration 087 and the 36-month pruning. Runs on its own throwaway database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 4391;
const PASSWORD = "AiUsage-Test-1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const URL = "/admin/reports/lookup-sources";
const CREDIT_BODY = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } });

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
  const ai = require("../../src/lib/aiUsageStats");
  stats = ai.createAiUsageStats({ getPool: () => pool, log: () => {} });
  ai.setStats(stats);
  adminJar = await login((await makeUser(true)).email);
  memberJar = await login((await makeUser(false)).email);
});
after(async () => {
  require("../../src/lib/aiUsageStats").setStats(null);
  await pool.end();
  app.stop();
});

async function makeUser(admin) {
  const email = `ai-${Date.now()}-${++n}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, email_verified_at) VALUES ($1, $2, $3, $4, now()) RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 4), admin ? "Ai Admin" : "Ai Member", admin]
  );
  return { id: rows[0].id, email };
}
async function login(email) {
  const j = makeCookieJar();
  const token = await fetchCsrfToken(app.base, j);
  const res = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: j.header(), "x-forwarded-for": "10.79.2.1" },
    body: new URLSearchParams({ email, password: PASSWORD, _csrf: token }).toString(),
  });
  j.capture(res);
  assert.equal(res.status, 302);
  return j;
}
async function get(path, jar = adminJar) {
  const res = await fetch(`${app.base}${path}`, { redirect: "manual", headers: { cookie: jar ? jar.header() : "", "x-forwarded-for": "10.79.2.1" } });
  return { res, text: await res.text() };
}
const answer = (text, usage) => new Response(JSON.stringify({ content: [{ type: "text", text }], usage }), { status: 200 });
// With the global fetch replaced for one call (the three modules use it directly).
async function viaFetch(impl, fn) {
  const real = globalThis.fetch;
  const key = process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = impl;
  process.env.ANTHROPIC_API_KEY = "test-key";
  const warn = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { globalThis.fetch = real; console.warn = warn; if (key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = key; }
}

// The cells of the "AI usage per feature" table: { "Description": [calls, ok, failed, 429, credit, in, out, searches, avg ms, usd, eur] }.
function featureRows(html) {
  const section = html.split("AI usage per feature")[1].split("</table>")[0];
  const out = {};
  for (const tr of section.split("<tr>").slice(2)) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
    if (cells.length) out[cells[0]] = cells.slice(1);
  }
  return out;
}

test("the table exists with the (day, feature) key", async () => {
  const { rows } = await pool.query("SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = 'ai_usage_stats'::regclass AND i.indisprimary ORDER BY a.attname");
  assert.deepEqual(rows.map((r) => r.attname), ["day", "feature"]);
});

test("admin only: a guest is sent to login, a non-admin is refused, the CSV tables too", async () => {
  for (const path of [URL, `${URL}?format=csv&table=ai`, `${URL}?format=csv&table=ai_daily`]) {
    const guest = await get(path, null);
    assert.ok([302, 303].includes(guest.res.status), `guest: ${guest.res.status}`);
    const member = await get(path, memberJar);
    assert.ok([302, 303, 403].includes(member.res.status), `member: ${member.res.status}`);
    assert.doesNotMatch(member.text, /AI usage/);
  }
});

test("empty: every feature is listed with zeros, no banner, no NaN", async () => {
  const { text } = await get(URL);
  assert.match(text, /AI usage per feature/);
  const rows = featureRows(text);
  for (const f of ["Description", "French translation", "Genre suggestion", "Cover photo reading", "Price check (web search)", "All features"]) assert.ok(rows[f], f);
  assert.equal(rows.Description[0], "0");
  assert.doesNotMatch(text, /NaN|undefined|Anthropic API credit ran out/);
});

test("after simulated calls the report shows calls, outcomes, tokens, searches, cost estimate and no text", async () => {
  const { generateBookDescription } = require("../../src/lib/bookDescription");
  const { translateEmptyFrench } = require("../../src/lib/collectionTranslate");
  const { generateBookGenres } = require("../../src/lib/bookGenre");
  const { extractBookInfoFromPhoto } = require("../../src/lib/coverVision");
  const { fetchMarketData } = require("../../src/lib/pricing/market");

  await viaFetch(async () => answer("Quiet Secret Words", { input_tokens: 1000, output_tokens: 100 }), async () => {
    await generateBookDescription({ title: "Secret Title Alpha" });
    await generateBookDescription({ title: "Secret Title Alpha" });
    await translateEmptyFrench({ title_en: "Quiet Secret Words" });
  });
  await viaFetch(async () => new Response("{}", { status: 429 }), () => generateBookDescription({ title: "T" }));
  await viaFetch(async () => new Response("oops", { status: 500 }), () => generateBookGenres({ title: "T" }));
  await viaFetch(async () => answer('{"isbn":null,"title":"A","author":"B"}', { input_tokens: 1600, output_tokens: 40 }), () => extractBookInfoFromPhoto(Buffer.from("x"), "image/png"));
  await fetchMarketData({ isbn: "9780143127550" }, { env: { ANTHROPIC_API_KEY: "k" }, fetchImpl: async () => answer("{}", { input_tokens: 5000, output_tokens: 300, server_tool_use: { web_search_requests: 4 } }) });

  await stats.flush();
  const { res, text } = await get(URL);
  assert.equal(res.status, 200);
  assert.doesNotMatch(text, /Secret Title|Quiet Secret|Anthropic API credit ran out/, "no text, and no banner without a credit error");
  const rows = featureRows(text);
  // calls, ok, failed, 429, credit, input, output, searches, avg ms, USD, EUR
  assert.deepEqual(rows.Description.slice(0, 8), ["3", "2", "0", "1", "0", "2,000".replace(",", ""), "200", "0"]);
  assert.deepEqual(rows["French translation"].slice(0, 8), ["1", "1", "0", "0", "0", "1000", "100", "0"]);
  assert.deepEqual(rows["Genre suggestion"].slice(0, 5), ["1", "0", "1", "0", "0"]);
  assert.deepEqual(rows["Cover photo reading"].slice(0, 8), ["1", "1", "0", "0", "0", "1600", "40", "0"]);
  assert.deepEqual(rows["Price check (web search)"].slice(0, 8), ["1", "1", "0", "0", "0", "5000", "300", "4"]);
  assert.deepEqual(rows["All features"].slice(0, 8), ["7", "5", "1", "1", "0", String(2000 + 1000 + 1600 + 5000), String(200 + 100 + 40 + 300), "4"]);
  // cost: 1000 in x $1/M + 100 out x $5/M = $0.0015 for the translation
  assert.equal(rows["French translation"][9], "$0.0015");
  assert.match(rows["French translation"][10], /^€0\.00\d\d$/);
  assert.match(text, /prices last checked 2026-10-09/);
  assert.match(text, /AI usage per month/);
  assert.match(text, /AI usage per day/);
});

test("a credit-balance answer shows the red banner with the time and the top-up instructions", async () => {
  const { generateBookDescription } = require("../../src/lib/bookDescription");
  assert.equal(await viaFetch(async () => new Response(CREDIT_BODY, { status: 400 }), () => generateBookDescription({ title: "T" })), null);
  await stats.flush();
  const { text } = await get(URL);
  assert.match(text, /role="alert"[^>]*>\s*<strong>Anthropic API credit ran out at [^<]+: top up at console\.anthropic\.com &gt; Billing\./);
  assert.equal(featureRows(text).Description[4], "1", "counted in the credit column");
  // the banner shows whatever the period
  assert.match((await get(`${URL}?period=today`)).text, /Anthropic API credit ran out at/);
});

test("the banner goes away when the last credit error is older than 24 hours", async () => {
  await pool.query("UPDATE ai_usage_stats SET last_credit_error_at = now() - interval '25 hours'");
  const { text } = await get(URL);
  assert.doesNotMatch(text, /Anthropic API credit ran out/);
  assert.equal(featureRows(text).Description[4], "1", "the count stays");
});

test("the period filter, and per-month and per-day tables", async () => {
  const day = (k) => new Date(Date.now() - k * 86400000).toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
  await pool.query("DELETE FROM ai_usage_stats");
  const ins = (d, calls) => pool.query("INSERT INTO ai_usage_stats (day, feature, calls, ok, input_tokens, output_tokens, duration_ms_sum, duration_n) VALUES ($1, 'genre', $2, $2, $2 * 100, $2 * 10, $2 * 300, $2)", [d, calls]);
  await ins(day(0), 1);
  await ins(day(5), 2);
  await ins(day(20), 4);
  await ins(day(120), 8);
  const col = async (q) => (featureRows((await get(`${URL}${q}`)).text)["Genre suggestion"] || [])[0];
  assert.equal(await col("?period=today"), "1");
  assert.equal(await col("?period=7d"), "3");
  assert.equal(await col(""), "7", "default: last 30 days");
  assert.equal(await col("?period=all"), "15");
  assert.equal(await col("?period=nonsense"), "7");
  const all = (await get(`${URL}?period=all`)).text;
  assert.ok(all.split("AI usage per day")[1].includes(day(120)), "the daily table lists the old day");
  assert.equal(featureRows(all)["Genre suggestion"][8], "300", "average response");
});

test("the CSV: AI tables download with a header row, counts, no personal data, logged in the admin activity", async () => {
  const csv = async (q) => fetch(`${app.base}${URL}?format=csv&${q}`, { headers: { cookie: adminJar.header(), "x-forwarded-for": "10.79.2.1" } });
  const res = await csv("table=ai&period=all");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.match(res.headers.get("content-disposition"), /attachment; filename="umas-books-lookup-sources-ai-all\.csv"/);
  const body = await res.text();
  assert.match(body, /"Feature","Calls made","Succeeded","Failed \(error\)","Refused: rate limit \(429\)","Credit balance too low \/ billing","Input tokens","Output tokens","Web searches","Average response \(ms\)","Estimated cost \(USD\)","Estimated cost \(EUR\)"/);
  assert.match(body, /"Genre suggestion",15,15,0,0,0,1500,150,0,300,/);
  assert.doesNotMatch(body, /@/);
  const daily = (await (await csv("table=ai_daily&period=all")).text()).replace(/^\uFEFF/, "").trim().split("\r\n");
  assert.equal(daily.length, 1 + 4, "every daily row");
  assert.match(daily[0], /^"Day \(Paris\)","Feature"/);
  const monthly = (await (await csv("table=ai_monthly&period=all")).text());
  assert.match(monthly, /"Month","Feature"/);
  assert.ok((await pool.query("SELECT 1 FROM admin_audit_log WHERE action = 'report.csv' AND detail = 'lookup-sources'")).rows.length >= 3);
});

test("the recorder upserts increments into the same (day, feature) row", async () => {
  await pool.query("DELETE FROM ai_usage_stats");
  stats.recordCall("cover", { status: 200, data: { usage: { input_tokens: 10, output_tokens: 5 } }, ms: 100 });
  await stats.flush();
  stats.recordCall("cover", { status: 400, bodyText: CREDIT_BODY, ms: 300 });
  stats.recordCall("cover", { status: 200, data: { usage: { input_tokens: 4_000_000_000, output_tokens: 1 } }, ms: 100 });
  await stats.flush();
  const { rows } = await pool.query("SELECT calls, ok, credit_errors, input_tokens::text AS input_tokens, output_tokens::int AS output_tokens, duration_ms_sum::int AS ms, duration_n, last_credit_error_at IS NOT NULL AS has_credit FROM ai_usage_stats WHERE feature = 'cover'");
  assert.deepEqual(rows, [{ calls: 3, ok: 2, credit_errors: 1, input_tokens: "4000000010", output_tokens: 6, ms: 500, duration_n: 3, has_credit: true }], "bigint tokens do not overflow");
});

test("pruning removes daily rows older than 36 months only", async () => {
  const { pruneAiUsageStats } = require("../../src/lib/aiUsageStats");
  await pool.query("DELETE FROM ai_usage_stats");
  await pool.query("INSERT INTO ai_usage_stats (day, feature, calls) VALUES (current_date - interval '40 months', 'genre', 1), (current_date - interval '35 months', 'genre', 1), (current_date, 'genre', 1)");
  assert.equal(await pruneAiUsageStats(pool), 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ai_usage_stats")).rows[0].n, 2);
});
