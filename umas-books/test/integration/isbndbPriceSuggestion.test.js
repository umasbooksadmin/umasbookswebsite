// GET /admin/inventory/isbndb-price: the suggested publisher's price for a New book (lib/isbndbPrice.js).
// ISBNdb is mocked at global.fetch; no key is real. The Add Book page only shows it, never fills the field.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");

const db = prepareDatabase("isbndb_price", { isolated: true });
const { pool } = require("../../src/db");
const { isbn13From } = require("../helpers/isbn");

const realFetch = global.fetch;
const isbndbCalls = [];
let isbndbAnswer = () => new Response(JSON.stringify({ book: { title: "T", msrp: 8.99 } }), { status: 200, headers: { "content-type": "application/json" } });
global.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1:")) return realFetch(url, init);
  if (u.startsWith("https://api2.isbndb.com/")) { isbndbCalls.push(u); return isbndbAnswer(u); }
  throw new Error(`test refused a real outbound request to ${u}`);
};

let server;
before(async () => {
  db.create();
  process.env.ISBNDB_API_KEY = "test-key";
  process.env.ISBNDB_MIN_INTERVAL_MS = "0";
  server = await listen(buildApp([require("../../src/routes/admin/inventoryLookup"), require("../../src/routes/admin/inventory")]));
});
after(async () => { global.fetch = realFetch; await server.close(); await pool.end(); db.drop(); });
let seq = 0;
const isbn = () => isbn13From(`978${String(Date.now()).slice(-6)}${String(++seq).padStart(3, "0")}`);
beforeEach(() => { isbndbCalls.length = 0; require("../../src/lib/bookSources").resetSourcePauses(); process.env.ISBNDB_API_KEY = "test-key"; });

const admin = { "x-test-user": JSON.stringify({ id: 1, email: "a@example.test", displayName: "A", isAdmin: true }) };
const member = { "x-test-user": JSON.stringify({ id: 2, email: "m@example.test", displayName: "M", isAdmin: false, isMember: true }) };
const get = async (path, headers = admin) => { const r = await realFetch(`${server.base}${path}`, { headers, redirect: "manual" }); return { status: r.status, text: await r.text() }; };
const price = async (i, cond = "new", headers) => { const r = await get(`/admin/inventory/isbndb-price?isbn=${i}&condition=${cond}`, headers); return { status: r.status, body: r.text.startsWith("{") ? JSON.parse(r.text) : null }; };

test("a New book gets the original USD price and the converted suggestion; nothing is saved", async () => {
  const before = (await pool.query("SELECT count(*)::int AS n FROM book_copies")).rows[0].n;
  const { status, body } = await price(isbn());
  assert.equal(status, 200);
  assert.equal(body.state, "price");
  assert.deepEqual(body.original, { amount: 8.99, currency: "USD" });
  assert.equal(body.eur, 8.25); // 8.99 x 0.92 (default rate), nearest 0.05
  assert.equal(body.approximate, true);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM book_copies")).rows[0].n, before);
});

test("not called for used books (any condition but new) and not for an invalid ISBN", async () => {
  for (const c of ["very_good", "good", "acceptable", "", "NEW"]) {
    const { body } = await price(isbn(), c);
    assert.equal(body.state, "not_new", c);
  }
  assert.equal(isbndbCalls.length, 0);
  assert.equal((await price("9780143127551")).status, 400);
  assert.equal(isbndbCalls.length, 0);
});

test("the second ask for the same ISBN is served from the cache", async () => {
  const i = isbn();
  await price(i); await price(i);
  assert.equal(isbndbCalls.length, 1);
});

test("no price: the answer is 'none'; no key: 'off'; refused key: 'unavailable' then no more calls", async () => {
  isbndbAnswer = () => new Response(JSON.stringify({ book: { title: "T", msrp: 0 } }), { status: 200 });
  assert.equal((await price(isbn())).body.state, "none");
  delete process.env.ISBNDB_API_KEY;
  const n = isbndbCalls.length;
  assert.equal((await price(isbn())).body.state, "off");
  assert.equal(isbndbCalls.length, n);
  process.env.ISBNDB_API_KEY = "test-key";
  const log = console.warn; console.warn = () => {};
  isbndbAnswer = () => new Response("{}", { status: 401 });
  assert.equal((await price(isbn())).body.state, "unavailable");
  assert.equal((await price(isbn())).body.state, "unavailable");
  console.warn = log;
  assert.equal(isbndbCalls.length, n + 1, "401 pauses ISBNdb");
  isbndbAnswer = () => new Response(JSON.stringify({ book: { msrp: 8.99 } }), { status: 200 });
});

test("the exchange rate is the editable one on Pricing settings", async () => {
  const { saveSettings, getSettingsAndRow } = require("../../src/lib/pricing/settings");
  const { row } = await getSettingsAndRow(pool, Date.now(), { fresh: true });
  const values = { usd_eur: 0.5, gbp_eur: Number(row.gbp_eur) };
  await saveSettings(pool, { ...values, levels: row.levels.map(Number), ...Object.fromEntries(["mass_market_price", "trade_price", "hardcover_min_price", "a_max", "a_price", "b_max", "b_price", "c_max", "c_factor", "used_fraction", "rounding_step", "fallback_hardcover", "fallback_trade", "fallback_mass_market", "fallback_unknown", "clearance_after_copies", "clearance_price"].map((k) => [k, Number(row[k])])), clearance_scope: row.clearance_scope, clearance_applies_to: row.clearance_applies_to, hardcover_min_applies_to_clearance: row.hardcover_min_applies_to_clearance === true });
  const { body } = await price(isbn());
  assert.equal(body.eur, 4.5, "8.99 x 0.5 = 4.495 -> 4.50");
  assert.equal(body.rate, 0.5);
});

test("only an admin can ask", async () => {
  assert.notEqual((await get(`/admin/inventory/isbndb-price?isbn=${isbn()}&condition=new`, {})).status, 200);
  assert.notEqual((await get(`/admin/inventory/isbndb-price?isbn=${isbn()}&condition=new`, member)).status, 200);
});

test("the Add Book page has the suggestion area, hidden, with the 'Use this price' button and keeps the legal help text; the field itself stays empty", async () => {
  const { text } = await get("/admin/inventory/new");
  assert.match(text, /data-isbndb-price[^>]*hidden/);
  assert.match(text, /Use this price/);
  assert.match(text, /fixed book price law/);
  assert.match(text, /<input id="publisherPrice"[^>]*value=""/);
});
