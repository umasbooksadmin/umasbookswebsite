// Cost and abuse caps for the paid AI (lib/aiLimits.js): the shared daily cap is ATOMIC (never exceeded by parallel
// calls), AI calls are skipped gracefully at the cap, one alert mail a day, the per-admin 10-a-minute limiters of the
// two AI endpoints, the text length caps, invalid ISBNs refused without an outside call, the price check's own cap
// made atomic, and one shared run for concurrent identical requests. Real database; fetch and mail stubbed.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");
const { isbn13From } = require("../helpers/isbn");

const db = prepareDatabase("ai_caps", { isolated: true });
const { pool } = require("../../src/db");
const { requireAdmin } = require("../../src/middleware/auth");

const mailer = require("../../src/mailer");
const sent = [];
mailer.sendMail = async (opts) => { sent.push(opts); };
const errorAlert = require("../../src/lib/errorAlert");

const limits = require("../../src/lib/aiLimits");
const { generateBookDescription } = require("../../src/lib/bookDescription");
const { translateEmptyFrench } = require("../../src/lib/collectionTranslate");
// A translation call (books have none since 2026-10-28: the collection one is the translation feature here).
const translateTitle = async (text) => { const r = await translateEmptyFrench({ title_en: text }); return r.ok && r.filled.length ? r.title_fr : null; };
const { generateBookGenres } = require("../../src/lib/bookGenre");
const { extractBookInfoFromPhoto } = require("../../src/lib/coverVision");
const { lookupMarket } = require("../../src/lib/pricing/market");
const aiUsageStats = require("../../src/lib/aiUsageStats");
const aiUsageReport = require("../../src/lib/aiUsageReport");

process.env.ANTHROPIC_API_KEY = "test-key-not-real";

const realFetch = global.fetch;
const anthropicBodies = [];
const catalogUrls = [];
let anthropicDelayMs = 0;
global.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1:")) return realFetch(url, init);
  if (u.startsWith("https://api.anthropic.com/v1/messages")) {
    anthropicBodies.push(JSON.parse(init.body));
    if (anthropicDelayMs) await new Promise((r) => setTimeout(r, anthropicDelayMs));
    const content = JSON.parse(init.body).messages[0].content;
    const text = Array.isArray(content) ? '{"isbn": null, "title": null, "author": null}' : "A short blurb.";
    return new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  catalogUrls.push(u);
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};

let server;
let adminId;
let otherAdminId;
before(async () => {
  db.create();
  errorAlert.setAlertRetryDelay(0);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
  const gate = express.Router();
  gate.use("/admin/inventory", requireAdmin, upload.fields([{ name: "photo", maxCount: 1 }, { name: "coverPhoto", maxCount: 1 }]));
  server = await listen(buildApp([gate, require("../../src/routes/admin/inventoryLookup"), require("../../src/routes/admin/inventory")]));
  const mk = async (n) => (await pool.query("INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ($1, 'x', $2, true) RETURNING id", [`cap-${n}-${Date.now()}@example.test`, `Cap ${n}`])).rows[0].id;
  adminId = await mk("a");
  otherAdminId = await mk("b");
});
after(async () => {
  global.fetch = realFetch;
  limits.setAiLimits(null);
  delete process.env.AI_DAILY_MAX_CALLS;
  await server.close();
  await pool.end();
  db.drop();
});
beforeEach(async () => {
  sent.length = 0;
  anthropicBodies.length = 0;
  catalogUrls.length = 0;
  anthropicDelayMs = 0;
  delete process.env.AI_DAILY_MAX_CALLS;
  delete process.env.PRICING_AI_DAILY_MAX;
  await pool.query("DELETE FROM ai_daily_cap");
  await pool.query("DELETE FROM alert_flags");
  limits.setAiLimits(limits.createAiLimits({ log: () => {} }));
});

const warnQuiet = () => { const w = console.warn; console.warn = () => {}; return () => { console.warn = w; }; };
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const rowOf = async (scope) => ((await pool.query("SELECT calls FROM ai_daily_cap WHERE scope = $1 AND day = (now() AT TIME ZONE 'Europe/Paris')::date", [scope])).rows[0] || { calls: 0 }).calls;
const userHeader = (id = adminId) => ({ "x-test-user": JSON.stringify({ id, email: "a@example.test", displayName: "Admin", isAdmin: true }) });

async function request(path, { method = "GET", form, files, headers = {}, userId } = {}) {
  let body;
  const h = { ...userHeader(userId), ...headers };
  if (files) {
    body = new FormData();
    for (const [k, v] of Object.entries(form || {})) body.append(k, v);
    for (const [k, f] of Object.entries(files)) body.append(k, new Blob([f.buffer], { type: f.type }), f.name);
  } else if (form) {
    body = new URLSearchParams(form).toString();
    h["content-type"] = "application/x-www-form-urlencoded";
  }
  const res = await realFetch(`${server.base}${path}`, { method, redirect: "manual", headers: h, body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { res, status: res.status, text, json, location: res.headers.get("location") };
}
let adminSeq = 0;
// A limiter counts per admin account and lives in memory: each test that spends requests uses its own admin.
const freshAdmin = async () => (await pool.query("INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ($1, 'x', 'Fresh', true) RETURNING id", [`cap-fresh-${++adminSeq}-${Date.now()}@example.test`])).rows[0].id;
const photo = async () => ({ photo: { buffer: await sharp({ create: { width: 50, height: 50, channels: 3, background: "#fff" } }).jpeg().toBuffer(), type: "image/jpeg", name: "p.jpg" } });

// ------------------------------------------------------------ the atomic shared cap

test("AI_DAILY_MAX_CALLS defaults to 600 and is read from the environment; 0 switches the AI off", () => {
  assert.equal(limits.DEFAULT_DAILY_MAX, 600);
  assert.equal(limits.dailyMax({}), 600);
  assert.equal(limits.dailyMax({ AI_DAILY_MAX_CALLS: "1000" }), 1000);
  assert.equal(limits.dailyMax({ AI_DAILY_MAX_CALLS: "0" }), 0);
  assert.equal(limits.dailyMax({ AI_DAILY_MAX_CALLS: "lots" }), 600);
  assert.equal(limits.dailyMax({ AI_DAILY_MAX_CALLS: "-3" }), 600);
});

test("20 parallel calls against a cap of 7: exactly 7 get a slot, the counter never goes past 7", async () => {
  const l = limits.createAiLimits({ getPool: () => pool, env: { AI_DAILY_MAX_CALLS: "7" }, send: async () => true, log: () => {} });
  const results = await Promise.all(Array.from({ length: 20 }, () => l.acquireAiCall()));
  assert.equal(results.filter((r) => r.ok).length, 7);
  assert.equal(await rowOf("all"), 7);
  const refused = results.find((r) => !r.ok);
  assert.equal(refused.message, "Daily AI limit reached (7). Resets at midnight Paris time.");
  const more = await Promise.all(Array.from({ length: 10 }, () => l.acquireAiCall()));
  assert.equal(more.filter((r) => r.ok).length, 0);
  assert.equal(await rowOf("all"), 7);
  await settle();
});

test("two 'instances' (two limiter objects, one database) share the cap", async () => {
  const mkLimits = () => limits.createAiLimits({ getPool: () => pool, env: { AI_DAILY_MAX_CALLS: "5" }, send: async () => true, log: () => {} });
  const a = mkLimits();
  const b = mkLimits();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).acquireAiCall()));
  assert.equal(results.filter((r) => r.ok).length, 5);
  assert.equal(await rowOf("all"), 5);
  await settle();
});

test("the price check cap is atomic too, and a slot taken in vain is given back when the shared cap is full", async () => {
  const l = limits.createAiLimits({ getPool: () => pool, env: { AI_DAILY_MAX_CALLS: "1000" }, send: async () => true, log: () => {} });
  const results = await Promise.all(Array.from({ length: 20 }, () => l.acquirePriceCall(3)));
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.equal(await rowOf("price"), 3);
  assert.equal(await rowOf("all"), 3, "the shared counter only counts calls that were allowed");

  await pool.query("DELETE FROM ai_daily_cap");
  const tight = limits.createAiLimits({ getPool: () => pool, env: { AI_DAILY_MAX_CALLS: "2" }, send: async () => true, log: () => {} });
  const r2 = await Promise.all(Array.from({ length: 10 }, () => tight.acquirePriceCall(50)));
  assert.equal(r2.filter((r) => r.ok).length, 2);
  assert.equal(await rowOf("all"), 2);
  assert.equal(await rowOf("price"), 2, "refused checks did not keep a price slot");
  await settle();
});

test("lookupMarket: 20 different ISBNs in parallel with PRICING_AI_DAILY_MAX=5 make exactly 5 AI calls", async () => {
  const env = { PRICING_AI: "1", ANTHROPIC_API_KEY: "k", PRICING_AI_DAILY_MAX: "5" };
  const calls = [];
  const fetchImpl = async (_u, init) => { calls.push(init.body); return new Response(JSON.stringify({ content: [{ type: "text", text: '{"originalPrice":null,"comparables":[]}' }] }), { status: 200 }); };
  const restore = warnQuiet();
  try {
    await Promise.all(Array.from({ length: 20 }, (_, i) => lookupMarket(pool, { isbn: isbn13From(`97801432${String(i).padStart(4, "0")}`) }, { fetchImpl, env })));
  } finally { restore(); }
  assert.equal(calls.length, 5);
  assert.equal(await rowOf("price"), 5);
});

test("lookupMarket: 20 parallel checks of the SAME ISBN share one run (one AI call, one slot)", async () => {
  const env = { PRICING_AI: "1", ANTHROPIC_API_KEY: "k" };
  let calls = 0;
  const fetchImpl = async () => { calls += 1; await settle(30); return new Response(JSON.stringify({ content: [{ type: "text", text: '{"originalPrice":null,"comparables":[]}' }] }), { status: 200 }); };
  const isbn = isbn13From("978014312755");
  const out = await Promise.all(Array.from({ length: 20 }, () => lookupMarket(pool, { isbn }, { fetchImpl, env })));
  assert.equal(calls, 1);
  assert.equal(await rowOf("all"), 1);
  assert.equal(out.length, 20);
});

test("lookupMarket refuses an ISBN with a wrong check digit without any AI call or slot", async () => {
  const env = { PRICING_AI: "1", ANTHROPIC_API_KEY: "k" };
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response("{}"); };
  assert.equal(await lookupMarket(pool, { isbn: "9780143127551" }, { fetchImpl, env }), null);
  assert.equal(calls, 0);
  assert.equal(await rowOf("all"), 0);
});

// ------------------------------------------------------------ graceful degradation at the cap

test("at the cap every AI feature is skipped (null, no outbound call) and nothing throws", async () => {
  process.env.AI_DAILY_MAX_CALLS = "2";
  const restore = warnQuiet();
  try {
    assert.equal(await generateBookDescription({ title: "One", author: "A" }), "A short blurb.");
    assert.equal(await translateTitle("Text to translate"), "A short blurb.");
    assert.equal(anthropicBodies.length, 2);
    assert.equal(await generateBookDescription({ title: "Three", author: "A" }), null);
    assert.equal(await translateTitle("Another text"), null);
    assert.equal(await generateBookGenres({ title: "Three" }), null);
    assert.equal(await extractBookInfoFromPhoto(Buffer.from("x"), "image/jpeg"), null);
    assert.equal(await lookupMarket(pool, { isbn: isbn13From("978014399999") }, { fetchImpl: async () => { throw new Error("must not be called"); }, env: { PRICING_AI: "1", ANTHROPIC_API_KEY: "k", AI_DAILY_MAX_CALLS: "2" } }), null);
  } finally { restore(); }
  assert.equal(anthropicBodies.length, 2, "no outbound call after the cap");
  assert.equal(await rowOf("all"), 2);
  const st = await limits.getAiLimits().status();
  assert.deepEqual([st.reached, st.used, st.max], [true, 2, 2]);
});

test("without an API key no slot is taken", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const restore = warnQuiet();
  try { assert.equal(await generateBookDescription({ title: "X" }), null); } finally { restore(); process.env.ANTHROPIC_API_KEY = "test-key-not-real"; }
  assert.equal(await rowOf("all"), 0);
});

test("identical concurrent AI requests share one call and one slot", async () => {
  anthropicDelayMs = 40;
  const out = await Promise.all(Array.from({ length: 6 }, () => generateBookDescription({ title: "Same Title", author: "Same Author" })));
  assert.ok(out.every((d) => d === "A short blurb."));
  assert.equal(anthropicBodies.length, 1);
  assert.equal(await rowOf("all"), 1);
});

test("text sent to the AI is capped: title 200, author 200, description 2000", async () => {
  await generateBookDescription({ title: "T".repeat(100000), author: "A".repeat(5000), publisher: "P".repeat(5000), publishedYear: 1999 });
  await generateBookGenres({ title: "T".repeat(100000), author: "A".repeat(5000), description: "D".repeat(100000) });
  assert.equal(anthropicBodies.length, 2);
  for (const b of anthropicBodies) assert.ok(b.messages[0].content.length < 3500, `prompt is bounded (${b.messages[0].content.length})`);
  const desc = anthropicBodies[0].messages[0].content;
  assert.ok(desc.includes("T".repeat(200)) && !desc.includes("T".repeat(201)));
  assert.ok(desc.includes("A".repeat(200)) && !desc.includes("A".repeat(201)));
  const genre = anthropicBodies[1].messages[0].content;
  assert.ok(genre.includes("D".repeat(2000)) && !genre.includes("D".repeat(2001)));
});

// ------------------------------------------------------------ the alert mail

test("the first refused call of a day sends ONE mail to the alert address; later refusals do not; next day it sends again", async () => {
  const l = limits.createAiLimits({ getPool: () => pool, env: { AI_DAILY_MAX_CALLS: "1" }, log: () => {}, send: (m) => errorAlert.sendAdminAlert(m) });
  assert.equal((await l.acquireAiCall()).ok, true);
  await Promise.all(Array.from({ length: 5 }, () => l.acquireAiCall()));
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, errorAlert.ALERT_TO);
  assert.match(sent[0].subject, /Daily AI limit reached/);
  assert.match(sent[0].text, /AI_DAILY_MAX_CALLS/);
  assert.match(sent[0].text, /Render/);
  assert.equal((await pool.query("SELECT 1 FROM alert_flags WHERE key = 'ai-daily-cap'")).rowCount, 1);
  await l.acquireAiCall();
  await settle();
  assert.equal(sent.length, 1, "still one");

  // a second process on the same day (nothing in its memory) is also stopped by the flag
  const other = limits.createAiLimits({ getPool: () => pool, env: { AI_DAILY_MAX_CALLS: "1" }, log: () => {}, send: (m) => errorAlert.sendAdminAlert(m) });
  await other.acquireAiCall();
  await settle();
  assert.equal(sent.length, 1);

  // the alert of yesterday does not silence today
  await pool.query("UPDATE alert_flags SET last_sent_at = now() - interval '26 hours' WHERE key = 'ai-daily-cap'");
  const fresh = limits.createAiLimits({ getPool: () => pool, env: { AI_DAILY_MAX_CALLS: "1" }, log: () => {}, send: (m) => errorAlert.sendAdminAlert(m) });
  await fresh.acquireAiCall();
  await settle();
  assert.equal(sent.length, 2);
});

test("a mail that cannot be sent is tried again by the next refused call, and never makes the call fail", async () => {
  let ok = false;
  const attempts = [];
  const l = limits.createAiLimits({ getPool: () => pool, env: { AI_DAILY_MAX_CALLS: "0" }, log: () => {}, send: async (m) => { attempts.push(m); return ok; } });
  const r = await l.acquireAiCall();
  assert.equal(r.ok, false);
  await settle();
  assert.equal(attempts.length, 1);
  ok = true;
  await l.acquireAiCall();
  await settle();
  assert.equal(attempts.length, 2);
  await l.acquireAiCall();
  await settle();
  assert.equal(attempts.length, 2, "delivered: no more");
});

test("database down: the cap still holds, counted in memory", async () => {
  const broken = { query: async () => { throw new Error("db down"); } };
  const l = limits.createAiLimits({ getPool: () => broken, env: { AI_DAILY_MAX_CALLS: "3" }, log: () => {}, send: async () => true });
  const results = await Promise.all(Array.from({ length: 10 }, () => l.acquireAiCall()));
  assert.equal(results.filter((r) => r.ok).length, 3);
  await settle();
});

// ------------------------------------------------------------ routes

test("POST generate-description: friendly message at the daily cap (HTTP 429 JSON) and the book form can still be saved", async () => {
  process.env.AI_DAILY_MAX_CALLS = "0";
  const restore = warnQuiet();
  try {
    const r = await request("/admin/inventory/generate-description", { method: "POST", form: { title: "Some Book" } });
    assert.equal(r.status, 429);
    assert.match(r.json.error, /Daily AI limit reached \(0\)\. Resets at midnight Paris time\./);
    assert.equal(anthropicBodies.length, 0);
    // the book still saves, with no description
    const title = `Capped ${Date.now()}`;
    const saved = await request("/admin/inventory", { method: "POST", form: { title, condition: "very_good", price: "6" }, headers: { accept: "application/json" } });
    assert.ok(saved.status < 400, `save works at the cap (${saved.status} ${saved.text.slice(0, 120)})`);
    await require("../../src/lib/afterResponse").settled();
    const { rows } = await pool.query("SELECT description FROM books WHERE title = $1", [title]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].description, null);
  } finally { restore(); }
});

test("POST generate-description: a huge title is clamped; the 11th request in a minute gets a friendly JSON 429; another admin is not affected", async () => {
  const me = await freshAdmin();
  const big = "T".repeat(60000);
  const first = await request("/admin/inventory/generate-description", { method: "POST", userId: me, form: { title: big, author: "A".repeat(30000) } });
  assert.equal(first.status, 200);
  assert.ok(anthropicBodies[0].messages[0].content.length < 1500);
  for (let i = 1; i < 10; i++) assert.equal((await request("/admin/inventory/generate-description", { method: "POST", userId: me, form: { title: `Book ${i}` } })).status, 200);
  const blocked = await request("/admin/inventory/generate-description", { method: "POST", userId: me, form: { title: "Book 11" } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error, "Too many AI requests: wait a minute and try again.");
  const calls = anthropicBodies.length;
  assert.equal((await request("/admin/inventory/generate-description", { method: "POST", form: { title: "Other admin" }, userId: otherAdminId })).status, 200, "per admin, not global");
  assert.equal(anthropicBodies.length, calls + 1, "the blocked request made no AI call (the other admin's made the description only: no translation)");
});

test("POST /admin/inventory/lookup with a photo: the 11th photo in a minute is refused with the message on the page; typing an ISBN is not counted", async () => {
  const files = await photo();
  const me = await freshAdmin();
  for (let i = 0; i < 10; i++) {
    const r = await request("/admin/inventory/lookup", { method: "POST", files, form: {}, userId: me });
    assert.equal(r.status, 303);
  }
  const eleventh = await request("/admin/inventory/lookup", { method: "POST", files, form: {}, userId: me });
  assert.equal(eleventh.status, 303);
  const cookie = (eleventh.res.headers.getSetCookie() || []).map((c) => c.split(";")[0]).join("; ");
  const page = await request(eleventh.location, { headers: { cookie }, userId: me });
  assert.match(page.text, /Too many AI requests: wait a minute and try again\./);
  assert.equal(anthropicBodies.filter((b) => Array.isArray(b.messages[0].content)).length, 10, "the 11th made no vision call");
  const json = await request("/admin/inventory/lookup", { method: "POST", files, form: {}, headers: { accept: "application/json" }, userId: me });
  assert.equal(json.status, 429);
  // a typed ISBN is not an AI request: never limited by it
  for (let i = 0; i < 12; i++) {
    const r = await request("/admin/inventory/lookup", { method: "POST", form: { isbn: isbn13From("978014312755") }, userId: me });
    assert.equal(r.status, 303);
  }
});

test("POST lookup of a photo at the daily cap says so", async () => {
  process.env.AI_DAILY_MAX_CALLS = "0";
  const restore = warnQuiet();
  try {
    const me = await freshAdmin();
    const r = await request("/admin/inventory/lookup", { method: "POST", files: await photo(), form: {}, userId: me });
    const cookie = (r.res.headers.getSetCookie() || []).map((c) => c.split(";")[0]).join("; ");
    const page = await request(r.location, { headers: { cookie }, userId: me });
    assert.match(page.text, /Daily AI limit reached \(0\)\. Resets at midnight Paris time\./);
  } finally { restore(); }
});

test("invalid ISBN: 'That ISBN is not valid: check the digits' from both lookups, with no catalog request", async () => {
  const bad = "9780143127551";
  const j = await request(`/admin/inventory/lookup?isbn=${bad}`);
  assert.equal(j.status, 400);
  assert.equal(j.json.error, "That ISBN is not valid: check the digits.");
  const r = await request("/admin/inventory/lookup", { method: "POST", form: { isbn: bad } });
  const cookie = (r.res.headers.getSetCookie() || []).map((c) => c.split(";")[0]).join("; ");
  const page = await request(r.location, { headers: { cookie } });
  assert.match(page.text, /That ISBN is not valid: check the digits\./);
  assert.equal(catalogUrls.length, 0, "no outside call");
  // valid ISBN-10 with X, hyphenated: goes through to the catalogs
  const ok = await request(`/admin/inventory/lookup?isbn=${encodeURIComponent("0-8044-2957-X")}`);
  assert.equal(ok.status, 200);
  assert.ok(catalogUrls.length > 0);
});

test("the scan lookup tells the person when the AI daily limit was reached", async () => {
  process.env.AI_DAILY_MAX_CALLS = "0";
  const restore = warnQuiet();
  try { await generateBookDescription({ title: "Trigger" }); } finally { restore(); }
  const r = await request(`/admin/inventory/lookup?isbn=${isbn13From("978014312755")}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.aiNotice, "Daily AI limit reached (0). Resets at midnight Paris time.");
});

test("the AI usage report shows a banner when the daily cap is used up", async () => {
  const period = { from: null, to: null, label: "All time" };
  assert.equal((await aiUsageReport.build(pool, period)).banner, null);
  process.env.AI_DAILY_MAX_CALLS = "1";
  await limits.getAiLimits().acquireAiCall();
  const banner = (await aiUsageReport.build(pool, period)).banner;
  assert.ok(banner && banner.level === "danger");
  assert.match(banner.text, /Daily AI limit reached \(1\)\. Resets at midnight Paris time\./);
  assert.match(banner.text, /AI_DAILY_MAX_CALLS/);
  aiUsageStats.setStats(null);
  await settle();
});

