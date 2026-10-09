// Suggested prices end to end (in-process, own throwaway database because the
// pricing rules are one global row): the add-book page and the copy edit page,
// the JSON endpoint, the learning-loop columns, clearance, the market cache and
// daily cap, the Pricing rules page and the Price check page.
//
// The network is never touched: global.fetch is replaced, answers Anthropic
// (market check / description) and Open Library from this file, and refuses
// everything else.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.PRICING_AI = "1";
process.env.ANTHROPIC_API_KEY = "test-key-not-real";
delete process.env.PRICING_AI_DAILY_MAX;

const { adminHarness } = require("../helpers/adminHarness");
const h = adminHarness("pricing_admin", ["priceSuggestions", "inventory", "pricing"], { isolated: true });

const realFetch = global.fetch;
const market = { calls: [], answer: null, status: 200 };
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

global.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1:")) return realFetch(url, init);
  if (u.startsWith("https://api.anthropic.com/v1/messages")) {
    const body = JSON.parse(init.body);
    if (body.tools) {
      market.calls.push(body);
      if (market.status !== 200) return new Response("overloaded", { status: market.status });
      return jsonRes({ content: [{ type: "text", text: JSON.stringify(market.answer || { originalPrice: null, comparables: [] }) }] });
    }
    return jsonRes({ content: [{ type: "text", text: "A blurb." }] });
  }
  if (u.startsWith("https://openlibrary.org/")) return jsonRes({});
  throw new Error(`test refused a real outbound request to ${u}`);
};

let seq = 0;
// A valid ISBN-13 (real check digit: the ISBN-10 form of it must find the same book).
const isbn13 = () => {
  const body = `978${String(Date.now()).slice(-6)}${String(100 + ++seq).padStart(3, "0")}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 ? 3 : 1);
  return body + String((10 - (sum % 10)) % 10);
};
const isbn10Of = (i13) => {
  const body = i13.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(body[i]);
  const c = (11 - (sum % 11)) % 11;
  return body + (c === 10 ? "X" : String(c));
};
const tag = () => `Pq${Date.now().toString(36)}${++seq}`;

const setMarket = (prices, original = null) => {
  market.status = 200;
  market.answer = {
    originalPrice: original == null ? null : { amount: original, currency: "EUR" },
    comparables: prices.map((p, i) => ({
      site: i % 2 ? "eBay" : "AbeBooks", url: `https://www.${i % 2 ? "ebay" : "abebooks"}.fr/listing/${seq}-${i}`,
      price: { amount: p, currency: "EUR" }, condition: "Very Good", note: "",
    })),
  };
};

const DEFAULTS_SQL = `UPDATE pricing_settings SET levels='[3,5,8,10]', mass_market_price=5, hardcover_min_price=10, hardcover_min_applies_to_clearance=false,
  a_max=6, a_price=5, b_max=20, b_price=8, c_max=50, c_factor=0.75, used_fraction=0.35, rounding_step=0.5,
  fallback_hardcover=12, fallback_trade=8, fallback_mass_market=4, fallback_unknown=8, usd_eur=0.92, gbp_eur=1.15,
  clearance_after_copies=2, clearance_price=1, clearance_scope='extra', clearance_applies_to='set_a' WHERE id=1`;
const { clearSettingsCache } = require("../../src/lib/pricing/settings");
async function resetSettings() {
  await h.pool.query(DEFAULTS_SQL);
  clearSettingsCache();
}

const SETTINGS_FORM = {
  levels: "3, 5, 8, 10", mass_market_price: "5", hardcover_min_price: "10", a_max: "6", a_price: "5", b_max: "20", b_price: "8",
  c_max: "50", c_factor: "0.75", used_fraction: "0.35", rounding_step: "0.5",
  fallback_hardcover: "12", fallback_trade: "8", fallback_mass_market: "4", fallback_unknown: "8",
  usd_eur: "0.92", gbp_eur: "1.15", clearance_after_copies: "2", clearance_price: "1",
  clearance_scope: "extra", clearance_applies_to: "set_a",
};

before(async () => {
  await h.start();
});
after(async () => {
  global.fetch = realFetch;
  await h.stop();
});
beforeEach(async () => {
  market.calls.length = 0;
  market.answer = null;
  market.status = 200;
  process.env.PRICING_AI = "1";
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  delete process.env.PRICING_AI_DAILY_MAX;
  await resetSettings();
});

// ----------------------------------------------------------------- helpers

// Each call is made by a fresh admin: the endpoint allows only 30 a minute per person.
const json = async (path, user) => {
  const { res, text } = await h.get(path, user || (await h.makeUser({ admin: true })));
  return { res, body: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null, text };
};
const suggestion = async (params) => (await json(`/admin/inventory/price-suggestion?${new URLSearchParams(params)}`)).body;

async function seedBook({ isbn = isbn13(), title = tag(), copies = [{}] } = {}) {
  const [book] = await h.q(
    "INSERT INTO books (isbn, title, authors, description, description_fr, cover_url) VALUES ($1, $2, 'A. Writer', 'd', 'd', '/c.png') RETURNING id",
    [isbn, title]
  );
  const ids = [];
  let age = copies.length;
  for (const c of copies) {
    const [row] = await h.q(
      `INSERT INTO book_copies (book_id, condition, price, status, is_clearance, suggested_level, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() - ($7 || ' minutes')::interval) RETURNING id`,
      [book.id, c.condition || "good", c.price === undefined ? 6 : c.price, c.status || "in_stock", Boolean(c.clearance), c.level || null, String(age--)]
    );
    ids.push(row.id);
  }
  return { id: book.id, isbn, title, ids };
}
const copiesOf = (isbn) => h.q("SELECT c.* FROM book_copies c JOIN books b ON b.id = c.book_id WHERE b.isbn = $1 ORDER BY c.id", [isbn]);
const auditRows = (action) => h.q("SELECT * FROM admin_audit_log WHERE action = $1 ORDER BY id", [action]);

// A new copy of a book through the real add-book form.
async function addCopy(fields) {
  const isbn = fields.isbn || isbn13();
  const r = await h.post("/admin/inventory", {
    title: fields.title || tag(), isbn, condition: "good", status: "in_stock", description: "d", descriptionFr: "d", coverUrl: "/c.png", ...fields,
  });
  assert.equal(r.res.status, 302, r.text.slice(0, 300));
  return (await copiesOf(isbn)).pop();
}

// ------------------------------------------------------------------- access

test("every pricing and suggestion route: anonymous -> /login, member -> 403", async () => {
  const routes = [
    ["GET", "/admin/pricing"], ["POST", "/admin/pricing"], ["GET", "/admin/pricing/review"], ["POST", "/admin/pricing/review/1"], ["POST", "/admin/pricing/clearance"],
    ["GET", "/admin/inventory/price-suggestion?isbn=1"], ["POST", "/admin/inventory/suggest"],
    ["POST", "/admin/inventory/1/copies/1/suggest"], ["POST", "/admin/inventory/1/copies/1/use-price"],
  ];
  for (const [method, path] of routes) {
    const call = (user) => (method === "GET" ? h.get(path, user) : h.post(path, {}, { user }));
    const anon = await call(null);
    assert.equal(anon.res.status, 302, `${method} ${path} anonymous`);
    assert.equal(anon.res.headers.get("location"), "/login");
    const member = await call(h.member);
    assert.equal(member.res.status, 403, `${method} ${path} member`);
  }
  assert.equal(market.calls.length, 0);
});

// ------------------------------------------------------------ the intake page

test("add-book page after an ISBN lookup: suggestion, price pre-filled, 'Why this price?' with listing links", async () => {
  const isbn = isbn13();
  setMarket([12, 14, 16]); // median 14 -> Rule B -> EUR 8
  const { res, text } = await h.post("/admin/inventory/lookup", { isbn });
  assert.equal(res.status, 200);
  assert.match(text, /Suggested EUR 8\.00 \(range 5\.00-10\.00, medium confidence\)/);
  assert.match(text, /name="price"[^>]*value="8"/);
  assert.match(text, /name="suggestedPrice" value="8"/);
  assert.match(text, /name="suggestedLevel" value="8"/);
  assert.match(text, /value="8" data-price="8" checked/, "the EUR 8 option is selected");
  assert.match(text, /data-suggested-tag="8">Suggested</, "and labelled Suggested");
  assert.match(text, /<summary>Why this price\?<\/summary>/);
  assert.match(text, /Rule B \(mid-range standard stock\)/);
  assert.match(text, /Based on 3 used listings \(AbeBooks, eBay\), the market value is about EUR 14\.00/);
  assert.match(text, /<a href="https:\/\/www\.abebooks\.fr\/listing\/[^"]+" target="_blank" rel="noopener">AbeBooks<\/a>: EUR 12\.00/);
  assert.match(text, /Suggest price<\/button>/, "no-JavaScript button");
  assert.equal(market.calls.length, 1);
  // the same book again (a second copy, another condition): answered from the cache, no new AI call
  await h.post("/admin/inventory/lookup", { isbn });
  await h.get(`/admin/inventory/price-suggestion?isbn=${isbn}&condition=acceptable`);
  assert.equal(market.calls.length, 1);
  assert.equal((await h.q("SELECT state FROM price_lookups WHERE isbn = $1", [isbn]))[0].state, "ok");
});

test("add-book page: AI off (the default) -> rules with the usual value for the binding, no call; no ISBN -> manual review", async () => {
  process.env.PRICING_AI = "0";
  const { text } = await h.post("/admin/inventory/lookup", { isbn: isbn13() });
  assert.match(text, /Suggested EUR 8\.00 \(range 5\.00-10\.00, low confidence\)/);
  assert.match(text, /We found no price information/);
  assert.equal(market.calls.length, 0);

  // A blank form shows no alert before anything is typed (and focuses the ISBN box, not the price) ...
  const blank = await h.get("/admin/inventory/new");
  assert.doesNotMatch(blank.text, /Manual review: no ISBN barcode/);
  assert.doesNotMatch(blank.text, /name="price"[^>]*autofocus/);
  // ... the notice appears once the price panel is evaluated for a title with no ISBN.
  const manual = await h.post("/admin/inventory/suggest", { title: "Typed By Hand", condition: "very_good" });
  assert.match(manual.text, /Manual review: no ISBN barcode/);
  assert.match(manual.text, /name="price"[^>]*value=""/);
  assert.match(manual.text, /name="price"[^>]*autofocus/);
  assert.match(manual.text, /name="suggestedLevel" value="review"/);
  assert.doesNotMatch(manual.text, /name="suggestedPrice" value="\d/);
});

test("the no-JavaScript 'Suggest price' button re-shows the form with everything typed and the suggestion", async () => {
  setMarket([2, 3, 4]); // Rule A
  const isbn = isbn13();
  const r = await h.post("/admin/inventory/suggest", {
    title: "My Title", author: "My Author", isbn, condition: "good", binding: "", location: "fiction a1", acquisitionCost: "1.5", copyNotes: "dog-eared", price: "99",
  });
  assert.equal(r.res.status, 200);
  assert.match(r.text, /value="My Title"/);
  assert.match(r.text, /value="fiction a1"/);
  assert.match(r.text, /dog-eared/);
  assert.match(r.text, /name="acquisitionCost"[^>]*value="1.5"/);
  assert.match(r.text, /Suggested EUR 5\.00/);
  assert.match(r.text, /name="price"[^>]*value="5"/, "set to the suggestion");
  assert.equal((await copiesOf(isbn)).length, 0, "nothing is saved");
});

test("the Binding select feeds the pricing: the form exposes it, the no-JS button and the endpoint use it (mass market EUR 5, hardcover EUR 10 floor)", async () => {
  setMarket([2, 3, 4]); // Rule A would give EUR 5 for a paperback
  const page = await h.get("/admin/inventory/new");
  assert.match(page.text, /<select id="binding" name="binding">/);
  assert.match(page.text, /<option value="mass_market"/);
  assert.match(page.text, /price-suggestion\.js/);
  const script = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../public/price-suggestion.js"), "utf8");
  assert.match(script, /byId\("binding"\)/, "the script reads the select the form really has");
  assert.match(script, /p\.set\("binding"/, "and forwards it to the endpoint");

  const viaForm = async (binding) => {
    const r = await h.post("/admin/inventory/suggest", { title: "T", isbn: isbn13(), condition: "very_good", binding });
    assert.equal(r.res.status, 200);
    return r.text;
  };
  const mm = await viaForm("mass_market");
  assert.match(mm, /Suggested EUR 5\.00/);
  assert.match(mm, /<option value="mass_market" selected>/, "the chosen binding stays selected");
  assert.match(await viaForm("hardcover"), /Suggested EUR 10\.00/, "the hardcover floor applies");
  assert.match(await viaForm("hardcover"), /<option value="hardcover" selected>/);

  const isbn = isbn13();
  await addCopy({ isbn, binding: "mass_market", price: "5" });
  assert.equal((await h.q("SELECT binding FROM books WHERE isbn = $1", [isbn]))[0].binding, "mass_market");
  const viaEndpoint = await suggestion({ isbn, binding: "mass_market", condition: "very_good" });
  assert.deepEqual([viaEndpoint.price, viaEndpoint.ruleSet], [5, "mass_market"]);
});

// ---------------------------------------------------------- the JSON endpoint

test("endpoint: JSON, no-store, and the condition never changes the suggestion", async () => {
  const isbn = isbn13();
  setMarket([3, 4, 5]); // Rule A: EUR 5
  const first = await json(`/admin/inventory/price-suggestion?${new URLSearchParams({ isbn, condition: "good" })}`);
  assert.equal(first.res.status, 200);
  assert.match(first.res.headers.get("content-type"), /json/);
  assert.equal(first.res.headers.get("cache-control"), "no-store");
  assert.deepEqual([first.body.price, first.body.ruleSet, first.body.level, first.body.levelText], [5, "A", 5, "5"]);
  assert.equal(first.body.label, "Suggested EUR 5.00 (range 3.00-8.00, medium confidence)");
  assert.equal(first.body.comparables.length, 3);
  assert.ok(first.body.rationale.length >= 2);
  const results = [];
  for (const condition of ["good", "very_good", "good", "acceptable", "fair", "poor", "", "nonsense"]) {
    const b = await suggestion({ isbn, condition });
    results.push(JSON.stringify([b.price, b.level, b.ruleSet, b.rationale]));
  }
  assert.equal(new Set(results).size, 1);
  assert.equal(market.calls.length, 1);
});

test("endpoint: new -> publisher price (none without it); mass market EUR 5 without a lookup; hardcover floor; no ISBN -> review", async () => {
  const isbn = isbn13();
  setMarket([3, 4, 5]);
  const fresh = await suggestion({ isbn, condition: "new", publisherPrice: "12.50" });
  assert.deepEqual([fresh.price, fresh.ruleSet, fresh.basis, fresh.low, fresh.high], [12.5, "new", "publisher", 11.88, 12.5]);
  const none = await suggestion({ isbn, condition: "new" });
  assert.equal(none.price, null);
  assert.match(none.label, /publisher's price/);
  assert.equal(market.calls.length, 0, "new books never trigger a lookup");

  const mm = await suggestion({ isbn, binding: "mass_market" });
  assert.deepEqual([mm.price, mm.ruleSet], [5, "mass_market"]);
  assert.equal(market.calls.length, 0, "mass market never triggers a lookup");

  const hc = await suggestion({ isbn, binding: "hardcover" });
  assert.deepEqual([hc.price, hc.ruleSet, hc.floorApplied], [10, "A", true]);
  assert.match(hc.rationale.join(" "), /Hardback: minimum price EUR 10\.00/);
  assert.equal(market.calls.length, 1);

  const review = await suggestion({ isbn: "", binding: "trade" });
  assert.deepEqual([review.price, review.needsReview, review.reviewMessage], [null, true, "Manual review: no ISBN barcode"]);
  const high = await suggestion({ isbn: isbn13() }); // answer still [3,4,5]
  assert.equal(high.price, 5);
  setMarket([80, 90, 100]);
  const valuable = await suggestion({ isbn: isbn13() });
  assert.deepEqual([valuable.price, valuable.level, valuable.reviewMessage], [null, "review", "Manual review: online value EUR 50.00 or more"]);
  assert.match(valuable.rationale.join(" "), /check the listings/);
});

test("endpoint: odd input never breaks it", async () => {
  for (const q of ["copyId=abc", "copyId=999999", "isbn=%3Cscript%3E", `isbn=${"9".repeat(500)}`, "condition[]=a&condition[]=b", "binding=__proto__&condition=new&publisherPrice=x"]) {
    const { res, body } = await json(`/admin/inventory/price-suggestion?${q}`);
    assert.equal(res.status, 200, q);
    assert.ok("price" in body);
  }
});

test("endpoint: 30 a minute per person, then 429 as JSON; another person is not affected", async () => {
  const busy = await h.makeUser({ admin: true });
  for (let i = 0; i < 30; i++) {
    const { res } = await h.get("/admin/inventory/price-suggestion?isbn=", busy);
    assert.equal(res.status, 200, `request ${i + 1}`);
  }
  const blocked = await h.get("/admin/inventory/price-suggestion?isbn=", busy);
  assert.equal(blocked.res.status, 429);
  assert.match(blocked.res.headers.get("content-type"), /json/);
  assert.match(JSON.parse(blocked.text).error, /Too many price checks/);
  const other = await h.get("/admin/inventory/price-suggestion?isbn=", await h.makeUser({ admin: true }));
  assert.equal(other.res.status, 200);
});

// ---------------------------------------------------------------- learning loop

test("Save book (fast=0) and Save and add another (fast=1) store the same price and suggestion fields", async () => {
  const cases = [
    { priceLevel: "8", price: "8", suggestedPrice: "8", suggestedLevel: "8" },
    { priceLevel: "custom", price: "11", suggestedPrice: "8", suggestedLevel: "8" },
    { priceLevel: "clearance", price: "1", suggestedPrice: "1", suggestedLevel: "clearance" },
    { priceLevel: "custom", price: "5" },
  ];
  const pick = (c) => [c.price == null ? null : Number(c.price), c.suggested_price == null ? null : Number(c.suggested_price), c.suggested_level, c.price_basis, c.is_clearance];
  for (const c of cases) {
    const a = await addCopy({ ...c, fast: "0" });
    const b = await addCopy({ ...c, fast: "1" });
    assert.deepEqual(pick(b), pick(a), JSON.stringify(c));
  }
});

test("saving a copy records what was suggested: suggested / adjusted / manual / review", async () => {
  const kept = await addCopy({ priceLevel: "8", price: "8", suggestedPrice: "8", suggestedLevel: "8" });
  assert.deepEqual([Number(kept.price), Number(kept.suggested_price), kept.suggested_level, kept.price_basis, kept.is_clearance], [8, 8, "8", "suggested", false]);

  const changed = await addCopy({ priceLevel: "custom", price: "11", suggestedPrice: "8", suggestedLevel: "8" });
  assert.deepEqual([Number(changed.price), Number(changed.suggested_price), changed.price_basis], [11, 8, "adjusted"]);

  const otherLevel = await addCopy({ priceLevel: "10", price: "8", suggestedPrice: "8", suggestedLevel: "8" });
  assert.deepEqual([Number(otherLevel.price), otherLevel.price_basis], [10, "adjusted"], "the chosen level wins over the price box");

  const manual = await addCopy({ priceLevel: "5", price: "5" });
  assert.deepEqual([Number(manual.price), manual.suggested_price, manual.suggested_level, manual.price_basis], [5, null, null, "manual"]);

  const legacy = await addCopy({ price: "7.25" }); // an older form: price field only
  assert.deepEqual([Number(legacy.price), legacy.price_basis], [7.25, "manual"]);

  const review = await addCopy({ priceLevel: "custom", price: "", suggestedPrice: "", suggestedLevel: "review" });
  assert.deepEqual([review.price, review.suggested_price, review.suggested_level, review.price_basis], [null, null, "review", "manual"]);
});

test("tampered hidden fields are ignored beyond numeric validation; the chosen level's price comes from the settings, not the browser", async () => {
  for (const bad of ["abc", "-5", "0", "1e9", "999999999", ""]) {
    const c = await addCopy({ priceLevel: "5", suggestedPrice: bad, suggestedLevel: "<b>" });
    assert.equal(c.suggested_price, null, `suggestedPrice ${bad}`);
    assert.equal(c.suggested_level, null);
    assert.equal(c.price_basis, "manual");
  }
  const level = await addCopy({ priceLevel: "8", price: "99" });
  assert.equal(Number(level.price), 8);
  const notALevel = await addCopy({ priceLevel: "7", price: "4.20" });
  assert.equal(Number(notALevel.price), 4.2, "an unknown level is treated as Custom");
  const clearance = await addCopy({ priceLevel: "clearance", price: "99" });
  assert.deepEqual([Number(clearance.price), clearance.is_clearance], [1, true]);
});

test("new books keep the publisher-price path: levels and clearance are ignored", async () => {
  const c = await addCopy({ condition: "new", publisherPrice: "10", priceLevel: "clearance", price: "" });
  assert.deepEqual([Number(c.price), Number(c.publisher_price), c.is_clearance], [10, 10, false]);
  const tooLow = await h.post("/admin/inventory", { title: tag(), isbn: isbn13(), condition: "new", publisherPrice: "10", priceLevel: "custom", price: "5", description: "d", descriptionFr: "d", coverUrl: "/c.png" });
  assert.equal(tooLow.res.status, 200);
  assert.match(tooLow.text, /A new book must be sold at the publisher(&#39;|')s price/);
  assert.match(tooLow.text, /name="suggestedLevel"/, "the form is shown again with its price control");
});

// -------------------------------------------------------------------- clearance

test("clearance at intake: from the third copy in stock; reserved count, sold do not; ISBN-10 and ISBN-13 are the same book", async () => {
  setMarket([2, 3, 4]); // Rule A
  const book = await seedBook({ copies: [{ status: "in_stock" }, { status: "reserved" }, { status: "sold" }] });
  const page = await h.post("/admin/inventory/lookup", { isbn: book.isbn });
  assert.match(page.text, /Suggested: Clearance EUR 1\.00/);
  assert.match(page.text, /This is copy no\. 3 of this book in stock, so it is on clearance\./);
  assert.match(page.text, /name="suggestedLevel" value="clearance"/);
  assert.match(page.text, /name="price"[^>]*value="1"/);
  assert.match(page.text, /value="clearance" data-price="1" checked/);

  const viaIsbn10 = await suggestion({ isbn: isbn10Of(book.isbn) });
  assert.equal(viaIsbn10.level, "clearance", "ISBN-10 of the same book");

  // saving it as suggested: a clearance copy
  const saved = await addCopy({ isbn: book.isbn, priceLevel: "clearance", suggestedPrice: "1", suggestedLevel: "clearance" });
  assert.deepEqual([Number(saved.price), saved.is_clearance, saved.price_basis, saved.suggested_level], [1, true, "suggested", "clearance"]);
  // the volunteer overrides it: not clearance
  const overridden = await addCopy({ isbn: book.isbn, priceLevel: "5", suggestedPrice: "1", suggestedLevel: "clearance" });
  assert.deepEqual([Number(overridden.price), overridden.is_clearance, overridden.price_basis], [5, false, "adjusted"]);
  const custom = await addCopy({ isbn: book.isbn, priceLevel: "custom", price: "1", suggestedPrice: "1", suggestedLevel: "clearance" });
  assert.equal(custom.is_clearance, false, "a custom price that happens to be EUR 1 is not the clearance choice");
});

test("clearance counts for a mass market book with 0, 1, 2, 3 copies in stock (and the suggestion shows the copy number)", async () => {
  const book = await seedBook({ copies: [] });
  const expectations = [[5, "mass_market"], [5, "mass_market"], [1, "clearance"], [1, "clearance"]];
  for (let n = 0; n < expectations.length; n++) {
    const s = await suggestion({ isbn: book.isbn, binding: "mass_market" });
    assert.deepEqual([s.price, s.ruleSet], expectations[n], `${n} copies in stock`);
    if (s.ruleSet === "clearance") assert.match(s.rationale[0], new RegExp(`copy no\\. ${n + 1} `));
    await h.q("INSERT INTO book_copies (book_id, condition, price, status) VALUES ($1, 'good', 5, 'in_stock')", [book.id]);
    await h.q("INSERT INTO book_copies (book_id, condition, price, status) VALUES ($1, 'good', 5, 'sold')", [book.id]).catch(() => {});
  }
  // new books are never on clearance
  assert.equal((await suggestion({ isbn: book.isbn, binding: "mass_market", condition: "new", publisherPrice: "9" })).ruleSet, "new");
});

test("pricing an existing copy: only the copies before it count, so copy no. 3 is clearance whatever was added after it", async () => {
  const book = await seedBook({ copies: [{ price: 5 }, { price: 5 }, { price: 5 }, { price: 5 }] });
  const levels = [];
  for (const id of book.ids) levels.push((await suggestion({ copyId: id, binding: "mass_market" })).ruleSet);
  assert.deepEqual(levels, ["mass_market", "mass_market", "clearance", "clearance"]);
  const third = await suggestion({ copyId: book.ids[2], binding: "mass_market" });
  assert.match(third.rationale[0], /copy no\. 3 of this book/);
});

test("clearance rule set: Rule A only by default; every rule when set so; never over manual review", async () => {
  setMarket([12, 14, 16]); // Rule B
  const b = await seedBook({ copies: [{}, {}] });
  assert.equal((await suggestion({ isbn: b.isbn })).price, 8, "Rule B book is not on clearance by default");
  await h.post("/admin/pricing", { ...SETTINGS_FORM, clearance_applies_to: "all_sets" });
  const all = await suggestion({ isbn: b.isbn });
  assert.deepEqual([all.price, all.ruleSet], [1, "clearance"]);
  setMarket([80, 90]);
  const valuable = await seedBook({ copies: [{}, {}, {}] });
  const review = await suggestion({ isbn: valuable.isbn });
  assert.deepEqual([review.price, review.ruleSet], [null, "review"]);
});

test("clearance scope 'all': the third copy offers to reprice the others (unticked); ticking does it in one go with audit rows", async () => {
  setMarket([2, 3, 4]);
  await h.post("/admin/pricing", { ...SETTINGS_FORM, clearance_scope: "all" });
  const book = await seedBook({ copies: [{ price: 6 }, { price: 7 }, { price: 9, status: "reserved" }, { price: 4, clearance: true }] });
  const page = await h.post("/admin/inventory/lookup", { isbn: book.isbn });
  assert.match(page.text, /Also reprice the other 2 copies/);
  assert.match(page.text, /€6\.00, €7\.00/);
  assert.doesNotMatch(page.text, /name="repriceOthers"[^>]*checked/);

  // not ticked: nothing else changes
  await addCopy({ isbn: book.isbn, priceLevel: "clearance", suggestedPrice: "1", suggestedLevel: "clearance" });
  let prices = (await copiesOf(book.isbn)).map((c) => [Number(c.price), c.is_clearance]);
  assert.deepEqual(prices.slice(0, 4), [[6, false], [7, false], [9, false], [4, true]]);
  assert.equal((await auditRows("copy.reprice")).length, 0);

  // ticked: the in-stock, non-clearance copies follow (the reserved one keeps its price)
  await addCopy({ isbn: book.isbn, priceLevel: "clearance", suggestedPrice: "1", suggestedLevel: "clearance", repriceOthers: "1" });
  prices = (await copiesOf(book.isbn)).map((c) => [Number(c.price), c.is_clearance]);
  assert.deepEqual(prices.slice(0, 4), [[1, true], [1, true], [9, false], [4, true]]);
  const audit = await auditRows("copy.reprice");
  assert.deepEqual(audit.map((a) => a.detail).sort(), ["price 6.00 -> 1.00 (clearance)", "price 7.00 -> 1.00 (clearance)"]);
  assert.ok(audit.every((a) => a.target_type === "book_copy" && a.actor_user_id === h.admin.id));
});

test("ticking 'reprice the others' does nothing unless the copy is a clearance copy under scope 'all'", async () => {
  const book = await seedBook({ copies: [{ price: 6 }, { price: 7 }] });
  await addCopy({ isbn: book.isbn, priceLevel: "8", repriceOthers: "1" }); // scope 'extra'
  await h.post("/admin/pricing", { ...SETTINGS_FORM, clearance_scope: "all" });
  await addCopy({ isbn: book.isbn, priceLevel: "8", repriceOthers: "1" }); // not a clearance copy
  assert.deepEqual((await copiesOf(book.isbn)).slice(0, 2).map((c) => Number(c.price)), [6, 7]);
});

// ------------------------------------------------------------- the copy edit page

test("copy edit page: 'Suggest price' shows the suggestion and does NOT touch the stored price; 'Use this price' saves it and audits", async () => {
  setMarket([12, 14, 16]); // Rule B: 8
  const book = await seedBook({ copies: [{ price: 6.5 }] });
  const copyId = book.ids[0];
  const page = await h.get(`/admin/inventory/${book.id}`);
  assert.match(page.text, new RegExp(`formaction="/admin/inventory/${book.id}/copies/${copyId}/suggest"`));
  assert.match(page.text, /Custom\.\.\./);
  assert.doesNotMatch(page.text, /Suggested EUR/, "no suggestion (and no AI call) just from opening the page");
  assert.match(page.text, /data-ps-box hidden/);
  assert.equal(market.calls.length, 0);

  const shown = await h.post(`/admin/inventory/${book.id}/copies/${copyId}/suggest`, { condition: "good", price: "6.5" });
  assert.equal(shown.res.status, 200);
  assert.match(shown.text, /Suggested EUR 8\.00/);
  assert.match(shown.text, /Why this price\?/);
  assert.match(shown.text, /Use this price/);
  assert.match(shown.text, /target="_blank" rel="noopener"/);
  const [afterShow] = await h.q("SELECT price, suggested_price, price_basis FROM book_copies WHERE id = $1", [copyId]);
  assert.deepEqual([Number(afterShow.price), afterShow.suggested_price, afterShow.price_basis], [6.5, null, null]);

  const used = await h.post(`/admin/inventory/${book.id}/copies/${copyId}/use-price`, {});
  assert.equal(used.res.status, 302);
  const [afterUse] = await h.q("SELECT price, suggested_price, suggested_level, price_basis, is_clearance FROM book_copies WHERE id = $1", [copyId]);
  assert.deepEqual([Number(afterUse.price), Number(afterUse.suggested_price), afterUse.suggested_level, afterUse.price_basis, afterUse.is_clearance], [8, 8, "8", "suggested", false]);
  const audit = (await auditRows("copy.reprice")).find((a) => a.target_id === copyId);
  assert.equal(audit.detail, "price 6.50 -> 8.00");
});

test("'Use this price' never trusts the page: the suggestion is worked out again; a copy that needs review is not repriced", async () => {
  const review = await seedBook({ copies: [{ price: 6 }] });
  setMarket([90, 95]);
  const r = await h.post(`/admin/inventory/${review.id}/copies/${review.ids[0]}/use-price`, { price: "0.01", suggestedPrice: "0.01" });
  assert.equal(r.res.status, 200);
  assert.match(r.text, /Manual review: online value EUR 50\.00 or more/);
  assert.equal(Number((await h.q("SELECT price FROM book_copies WHERE id = $1", [review.ids[0]]))[0].price), 6);
  // a copy of another book id in the URL is not found
  const wrong = await h.post(`/admin/inventory/${review.id + 1000}/copies/${review.ids[0]}/use-price`, {});
  assert.equal(wrong.res.status, 302);
});

test("copy edit: saving with a level records the learning loop; clearance flag follows the chosen price", async () => {
  const book = await seedBook({ copies: [{ price: 1, clearance: true }, { price: 1, clearance: true }] });
  const [a, b] = book.ids;
  const flag = async (id) => (await h.q("SELECT price, is_clearance, price_basis, suggested_price FROM book_copies WHERE id = $1", [id]))[0];
  const post = (id, fields) => h.post(`/admin/inventory/${book.id}/copies/${id}`, { condition: "good", status: "in_stock", ...fields });

  // an older form without the price levels keeps the flag while the price is unchanged
  assert.equal((await post(a, { price: "1" })).res.status, 302);
  assert.equal((await flag(a)).is_clearance, true);
  // ... and loses it when the price is changed
  await post(a, { price: "3" });
  assert.deepEqual([Number(await (await flag(a)).price), (await flag(a)).is_clearance], [3, false]);

  // choosing Clearance in the form marks it; choosing another level clears it
  await post(b, { priceLevel: "5" });
  assert.deepEqual([Number((await flag(b)).price), (await flag(b)).is_clearance], [5, false]);
  await post(b, { priceLevel: "clearance", suggestedPrice: "1", suggestedLevel: "clearance" });
  const marked = await flag(b);
  assert.deepEqual([Number(marked.price), marked.is_clearance, marked.price_basis, Number(marked.suggested_price)], [1, true, "suggested", 1]);
  // an edit that does not carry a suggestion keeps the stored one
  await post(b, { priceLevel: "8" });
  const kept = await flag(b);
  assert.deepEqual([Number(kept.suggested_price), kept.price_basis, kept.is_clearance], [1, "adjusted", false]);
});

// --------------------------------------------------------------- Pricing rules

test("pricing rules page: shows the rules, the calculator and the sample table", async () => {
  const { res, text } = await h.get("/admin/pricing");
  assert.equal(res.status, 200);
  assert.match(text, /Pricing rules/);
  assert.match(text, /name="a_max"[^>]*value="6"/);
  assert.match(text, /name="clearance_after_copies"[^>]*value="2"/);
  assert.match(text, /name="levels"[^>]*value="3, 5, 8, 10"/);
  assert.match(text, /<th>Mass Market<\/th><th>Trade<\/th><th>Hardback<\/th><th>Other<\/th>/);
  assert.match(text, /<tr><td>5\.50<\/td><td>EUR 5\.00<\/td><td>EUR 5\.00<\/td><td>EUR 5\.00<\/td><td>EUR 10\.00<\/td><td>EUR 5\.00<\/td>/, "5.50: unknown 5, mass market 5, trade 5, hardback floored to 10, other 5");
  assert.match(text, /<tr><td>50\.00<\/td><td>Manual review<\/td><td>EUR 5\.00<\/td>(<td>Manual review<\/td>){3}/, "50: review except mass market");
  assert.match(text, /Any value, no ISBN<\/td><td colspan="5">Manual review/);
  assert.match(text, /Pricing rules<\/a>/, "in the admin menu");
});

test("pricing rules page: price colour chart lists every colour by name and follows the saved prices", async () => {
  const rowOf = (text, key) => (text.match(new RegExp(`<tr data-color="${key}">[\\s\\S]*?</tr>`)) || [""])[0];
  let text = (await h.get("/admin/pricing")).text;
  assert.match(text, /Price sticker colours/);
  const expect = { orange: "EUR 1", yellow: "EUR 3", green: "EUR 5", blue: "EUR 8", red: "EUR 10", purple: "Special price", white: "Publisher&#39;s price" };
  for (const [k, price] of Object.entries(expect)) {
    const row = rowOf(text, k);
    assert.match(row, new RegExp(`<strong>${k[0].toUpperCase() + k.slice(1)}</strong>`), `${k} name in text`);
    assert.ok(row.includes(price), `${k} price ${price}`);
  }
  assert.match(rowOf(text, "green"), /#237A3C/);
  assert.match(text, /@media print|Print this chart/);
  // Changing a level price and the clearance price in the settings changes the chart.
  await h.post("/admin/pricing", { ...SETTINGS_FORM, levels: "3, 6, 8, 10", clearance_price: "2" });
  text = (await h.get("/admin/pricing")).text;
  assert.ok(rowOf(text, "green").includes("EUR 6"), "green follows the 2nd standard price");
  assert.ok(rowOf(text, "orange").includes("EUR 2"), "orange follows the clearance price");
  await resetSettings();
});

test("pricing rules calculator: market value, binding, copies in stock, ISBN", async () => {
  const calc = async (q) => (await h.get(`/admin/pricing?${new URLSearchParams(q)}`)).text;
  assert.match(await calc({ calcMarket: "24", calcBinding: "hardcover" }), /EUR 18\.00<\/strong> &middot; Rule C/);
  assert.match(await calc({ calcMarket: "3", calcBinding: "hardcover" }), /EUR 10\.00<\/strong> &middot; Rule A \+ hardback minimum/);
  assert.match(await calc({ calcMarket: "3", calcBinding: "trade", calcCopies: "2" }), /EUR 1\.00<\/strong> &middot; Clearance/);
  assert.match(await calc({ calcMarket: "12", calcBinding: "trade", calcCopies: "2" }), /EUR 8\.00<\/strong> &middot; Rule B/);
  assert.match(await calc({ calcMarket: "80", calcBinding: "mass_market" }), /EUR 5\.00<\/strong> &middot; Mass market price/);
  assert.match(await calc({ calcMarket: "60" }), /Manual review: online value EUR 50\.00 or more/);
  assert.match(await calc({ calcMarket: "5", calcIsbn: "no" }), /Manual review: no ISBN barcode/);
  assert.equal((await h.get("/admin/pricing?calcMarket=abc&calcBinding=<x>&calcCopies=-4")).res.status, 200);
});

test("pricing rules: a bad form is refused with a message, nothing saved, no audit row", async () => {
  const before = (await auditRows("pricing.settings")).length;
  for (const bad of [{ a_max: "25" }, { c_factor: "5" }, { clearance_after_copies: "0" }, { levels: "5, 3" }, { clearance_scope: "x" }, { b_price: "abc" }]) {
    const r = await h.post("/admin/pricing", { ...SETTINGS_FORM, ...bad });
    assert.equal(r.res.status, 200, JSON.stringify(bad));
    assert.match(r.text, /role="alert"/);
    assert.match(r.text, new RegExp(`name="${Object.keys(bad)[0]}"[^>]*value="${bad[Object.keys(bad)[0]]}"|<select`), "what was typed is kept");
  }
  assert.equal((await auditRows("pricing.settings")).length, before);
  assert.equal(Number((await h.q("SELECT a_max FROM pricing_settings"))[0].a_max), 6);
});

test("pricing rules: saving changes the rules at once, is audited with the changed keys only, and an unchanged save is not", async () => {
  const before = (await auditRows("pricing.settings")).length;
  const r = await h.post("/admin/pricing", { ...SETTINGS_FORM, a_price: "4.5", clearance_applies_to: "all_sets", hardcover_min_applies_to_clearance: "1" });
  assert.equal(r.res.status, 302);
  assert.equal(r.res.headers.get("location"), "/admin/pricing?saved=1");
  const rows = await auditRows("pricing.settings");
  assert.equal(rows.length, before + 1);
  assert.deepEqual(rows[rows.length - 1].detail.split(", ").sort(), ["a_price", "clearance_applies_to", "hardcover_min_applies_to_clearance"]);
  assert.ok(!/\d/.test(rows[rows.length - 1].detail), "keys only, no values");
  assert.equal(rows[rows.length - 1].actor_user_id, h.admin.id);

  setMarket([2, 3, 4]);
  assert.equal((await suggestion({ isbn: isbn13() })).price, 4.5, "the new number is used immediately (cache cleared)");
  assert.match((await h.get("/admin/pricing?saved=1")).text, /Pricing rules saved\./);

  const again = await h.post("/admin/pricing", { ...SETTINGS_FORM, a_price: "4.5", clearance_applies_to: "all_sets", hardcover_min_applies_to_clearance: "1" });
  assert.equal(again.res.status, 302);
  assert.equal((await auditRows("pricing.settings")).length, before + 1, "nothing changed, nothing logged");
});

// ------------------------------------------------------------------ Price check

test("price check: lists in-stock copies priced differently from the suggestion; 'Use suggested' updates and audits", async () => {
  const book = await seedBook({ copies: [
    { price: 8 }, // what the rules suggest: not listed
    { price: 3 }, // a standard price, but not the suggestion
    { price: 13.37 }, // not a standard price
    { price: 1, clearance: true }, // clearance copy at the clearance price: fine
    { price: 9, condition: "new" }, // new books are not priced by these rules
    { price: 2, status: "sold" }, // not in stock
  ] });
  const [ok, three, odd, clearance, newCopy, sold] = book.ids;
  const page = await h.get("/admin/pricing/review");
  assert.equal(page.res.status, 200);
  const block = (id) => page.text.includes(`/admin/pricing/review/${id}"`);
  assert.deepEqual([ok, three, odd, clearance, newCopy, sold].map(block), [false, true, true, false, false, false]);
  assert.match(page.text, /Not one of the standard prices/);
  assert.match(page.text, /Differs from the suggested price/);

  const used = await h.post(`/admin/pricing/review/${three}`, { offset: "0" });
  assert.equal(used.res.status, 302);
  assert.equal(used.res.headers.get("location"), "/admin/pricing/review?offset=0");
  const [row] = await h.q("SELECT price, suggested_price, price_basis, is_clearance FROM book_copies WHERE id = $1", [three]);
  assert.deepEqual([Number(row.price), Number(row.suggested_price), row.price_basis, row.is_clearance], [8, 8, "suggested", false]);
  assert.equal((await auditRows("copy.reprice")).find((a) => a.target_id === three).detail, "price 3.00 -> 8.00");

  // copies that are not eligible are left alone
  for (const id of [newCopy, sold]) await h.post(`/admin/pricing/review/${id}`, {});
  assert.deepEqual((await h.q("SELECT price FROM book_copies WHERE id = ANY($1) ORDER BY id", [[newCopy, sold]])).map((r) => Number(r.price)), [9, 2]);
  assert.equal((await auditRows("copy.reprice")).filter((a) => [newCopy, sold].includes(a.target_id)).length, 0);
});

test("price check: uses online prices already looked up (never a new lookup) and paginates by offset", async () => {
  setMarket([2, 3, 4]);
  const book = await seedBook({ copies: [{ price: 8 }] });
  await suggestion({ isbn: book.isbn }); // one lookup, cached: value 3 -> Rule A -> EUR 5
  const calls = market.calls.length;
  const page = await h.get("/admin/pricing/review");
  assert.ok(page.text.includes(`/admin/pricing/review/${book.ids[0]}"`), "EUR 8 differs from the cached suggestion of EUR 5");
  assert.equal(market.calls.length, calls);
  const far = await h.get("/admin/pricing/review?offset=100000");
  assert.equal(far.res.status, 200);
  assert.match(far.text, /Nothing to check\./);
  assert.equal((await h.get("/admin/pricing/review?offset=abc")).res.status, 200);
});

test("price check: 'Needs review' lists copies saved for review with no price yet (or the starting price)", async () => {
  const book = await seedBook({ title: tag(), copies: [{ price: null, level: "review" }, { price: 5, level: "review" }, { price: 7, level: "review" }, { price: null, level: "review", status: "sold" }, { price: null }] });
  const page = await h.get("/admin/pricing/review");
  const needs = page.text.split("Needs review (")[1].split("Priced differently")[0];
  assert.ok(needs.includes(`/admin/inventory/${book.id}"`));
  assert.equal((needs.match(new RegExp(`/admin/inventory/${book.id}"`, "g")) || []).length, 2, "no price and price 5 only");
  assert.match(needs, /no price yet/);
});

test("clearance candidates: preview, then apply; extra copies only, honouring the rule set and exclusions", async () => {
  const lookup = (isbn, prices) => h.q("INSERT INTO price_lookups (isbn, data, state) VALUES ($1, $2, 'ok')", [isbn, JSON.stringify({ originalPrice: null, comparables: prices.map((p, i) => ({ site: "x", url: `https://x.example/${i}`, price: p })) })]);
  const cheap = await seedBook({ copies: [{ price: 5 }, { price: 5 }, { price: 6 }, { price: 7 }, { price: 7, status: "reserved" }, { price: 7, condition: "new" }, { price: 1, clearance: true }] });
  await lookup(cheap.isbn, [2, 3]); // Rule A
  const mid = await seedBook({ copies: [{ price: 8 }, { price: 8 }, { price: 8 }, { price: 8 }] });
  await lookup(mid.isbn, [12, 14]); // Rule B
  const precious = await seedBook({ copies: [{ price: 60 }, { price: 60 }, { price: 60 }] });
  await lookup(precious.isbn, [80, 90]); // manual review
  const few = await seedBook({ copies: [{ price: 5 }, { price: 5 }] });
  await lookup(few.isbn, [2, 3]);

  const preview = await h.get("/admin/pricing/review");
  const section = preview.text.split("Clearance candidates (")[1];
  // cheap: copies no. 3 and 4 (the first two stay; the reserved, new and clearance ones are left out)
  assert.ok(section.includes(`/admin/inventory/${cheap.id}"`));
  assert.ok(section.includes("No. 3 of 7") && section.includes("No. 4 of 7"));
  assert.ok(!section.includes("No. 1 of 7") && !section.includes("No. 2 of 7") && !section.includes("No. 5 of 7") && !section.includes("No. 6 of 7") && !section.includes("No. 7 of 7"));
  for (const other of [mid, precious, few]) assert.ok(!section.includes(`/admin/inventory/${other.id}"`), "not a candidate");
  assert.match(section, /Apply clearance to these \d+ copies/);

  const applied = await h.post("/admin/pricing/clearance", {});
  assert.equal(applied.res.status, 302);
  assert.match(applied.res.headers.get("location"), /^\/admin\/pricing\/review\?cleared=\d+$/);
  const state = (await copiesOf(cheap.isbn)).map((c) => [Number(c.price), c.is_clearance]);
  assert.deepEqual(state, [[5, false], [5, false], [1, true], [1, true], [7, false], [7, false], [1, true]]);
  const audits = (await auditRows("copy.reprice")).filter((a) => cheap.ids.includes(a.target_id));
  assert.deepEqual(audits.map((a) => a.detail).sort(), ["price 6.00 -> 1.00 (clearance)", "price 7.00 -> 1.00 (clearance)"]);
  assert.equal((await copiesOf(mid.isbn)).filter((c) => c.is_clearance).length, 0);
  assert.equal((await copiesOf(precious.isbn)).filter((c) => c.is_clearance).length, 0);
  assert.match((await h.get(applied.res.headers.get("location"))).text, /Clearance applied to \d+ copies\./);
  assert.ok(!(await h.get("/admin/pricing/review")).text.split("Clearance candidates (")[1].includes(`/admin/inventory/${cheap.id}"`), "nothing left to apply");

  // the rule set 'all rules' adds the Rule B book; scope 'all' includes its first copies too
  await h.post("/admin/pricing", { ...SETTINGS_FORM, clearance_applies_to: "all_sets", clearance_scope: "all" });
  const widened = (await h.get("/admin/pricing/review")).text.split("Clearance candidates (")[1];
  for (const n of [1, 2, 3, 4]) assert.ok(widened.includes(`No. ${n} of 4`), `copy ${n} of the Rule B book`);
  assert.ok(!widened.includes(`/admin/inventory/${precious.id}"`), "manual review is never a candidate");
  assert.ok(!widened.includes(`/admin/inventory/${few.id}"`), "only 2 copies: not more than the threshold");
  await h.post("/admin/pricing/clearance", {});
  assert.deepEqual((await copiesOf(mid.isbn)).map((c) => [Number(c.price), c.is_clearance]), [[1, true], [1, true], [1, true], [1, true]]);
});

// ------------------------------------------------------ market cache and daily cap

const { lookupMarket } = require("../../src/lib/pricing/market");
const { suggestPrice } = require("../../src/lib/pricing");
const { DEFAULT_SETTINGS } = require("../../src/lib/pricing/rules");

function fakeFetch(answer, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return status === 200 ? jsonRes({ content: [{ type: "text", text: JSON.stringify(answer) }] }) : new Response("no", { status });
  };
  impl.calls = calls;
  return impl;
}
const ENV = { PRICING_AI: "1", ANTHROPIC_API_KEY: "k" };
const answerWith = (prices) => ({ originalPrice: null, comparables: prices.map((p, i) => ({ site: "AbeBooks", url: `https://a.example/${i}`, price: { amount: p, currency: "EUR" }, condition: "Good", note: "" })) });
const ago = (isbn, interval) => h.q("UPDATE price_lookups SET fetched_at = now() - $2::interval WHERE isbn = $1", [isbn, interval]);

test("price_lookups cache: the second call costs nothing; after 30 days it is fetched again", async () => {
  const isbn = isbn13();
  const f = fakeFetch(answerWith([6, 7]));
  const first = await lookupMarket(h.pool, { isbn }, { fetchImpl: f, env: ENV });
  assert.equal(first.comparables.length, 2);
  assert.equal(first.fromCache, false);
  const second = await lookupMarket(h.pool, { isbn: isbn10Of(isbn) }, { fetchImpl: f, env: ENV }); // ISBN-10 of the same book
  assert.equal(second.fromCache, true);
  assert.equal(second.comparables.length, 2);
  assert.equal(f.calls.length, 1);
  await ago(isbn, "29 days");
  await lookupMarket(h.pool, { isbn }, { fetchImpl: f, env: ENV });
  assert.equal(f.calls.length, 1, "29 days old: still cached");
  await ago(isbn, "31 days");
  const again = await lookupMarket(h.pool, { isbn }, { fetchImpl: f, env: ENV });
  assert.equal(f.calls.length, 2, "31 days old: fetched again");
  assert.equal(again.fromCache, false);
  assert.equal((await h.q("SELECT count(*)::int AS n FROM price_lookups WHERE isbn = $1", [isbn]))[0].n, 1);
});

test("an empty answer is remembered for a week; a failure for an hour (so a broken service is not hammered)", async () => {
  const empty = isbn13();
  const fEmpty = fakeFetch({ originalPrice: null, comparables: [] });
  assert.equal((await lookupMarket(h.pool, { isbn: empty }, { fetchImpl: fEmpty, env: ENV })).comparables.length, 0);
  await lookupMarket(h.pool, { isbn: empty }, { fetchImpl: fEmpty, env: ENV });
  assert.equal(fEmpty.calls.length, 1);
  assert.equal((await h.q("SELECT state FROM price_lookups WHERE isbn = $1", [empty]))[0].state, "empty");
  await ago(empty, "8 days");
  await lookupMarket(h.pool, { isbn: empty }, { fetchImpl: fEmpty, env: ENV });
  assert.equal(fEmpty.calls.length, 2);

  const failing = isbn13();
  const fFail = fakeFetch(null, { status: 500 });
  assert.equal(await lookupMarket(h.pool, { isbn: failing }, { fetchImpl: fFail, env: ENV }), null);
  assert.equal(await lookupMarket(h.pool, { isbn: failing }, { fetchImpl: fFail, env: ENV }), null);
  assert.equal(fFail.calls.length, 1, "not retried straight away");
  assert.equal((await h.q("SELECT state, data FROM price_lookups WHERE isbn = $1", [failing]))[0].state, "failed");
  await ago(failing, "61 minutes");
  await lookupMarket(h.pool, { isbn: failing }, { fetchImpl: fFail, env: ENV });
  assert.equal(fFail.calls.length, 2);
});

test("daily cap (PRICING_AI_DAILY_MAX) is counted from the database: it survives restarts, and yesterday does not count", async () => {
  const todayCount = async () => (await h.q("SELECT count(*)::int AS n FROM price_lookups WHERE fetched_at >= (date_trunc('day', now() AT TIME ZONE 'Europe/Paris') AT TIME ZONE 'Europe/Paris')"))[0].n;
  const f = fakeFetch(answerWith([6, 7]));
  const used = await todayCount();
  const env = { ...ENV, PRICING_AI_DAILY_MAX: String(used + 1) };
  assert.ok(await lookupMarket(h.pool, { isbn: isbn13() }, { fetchImpl: f, env }), "one more is allowed");
  assert.equal(f.calls.length, 1);
  const blocked = isbn13();
  assert.equal(await lookupMarket(h.pool, { isbn: blocked }, { fetchImpl: f, env }), null, "the cap is reached");
  assert.equal(f.calls.length, 1, "and no call was made");
  assert.equal((await h.q("SELECT 1 FROM price_lookups WHERE isbn = $1", [blocked])).length, 0);
  // a "restart" (nothing is kept in memory) changes nothing; the next day's lookups start from zero
  await h.q("UPDATE price_lookups SET fetched_at = now() - interval '2 days' WHERE fetched_at >= now() - interval '1 hour'");
  assert.ok(await lookupMarket(h.pool, { isbn: blocked }, { fetchImpl: f, env }));
  assert.equal(await lookupMarket(h.pool, { isbn: isbn13() }, { fetchImpl: f, env: { ...ENV, PRICING_AI_DAILY_MAX: "0" } }), null, "0 switches lookups off");
});

test("fails open: AI off, no key, no ISBN, a broken database, a broken fetch: all give rules, never an error", async () => {
  const f = fakeFetch(answerWith([6, 7]));
  const isbn = isbn13();
  for (const env of [{}, { ANTHROPIC_API_KEY: "k" }, { PRICING_AI: "1" }, { PRICING_AI: "0", ANTHROPIC_API_KEY: "k" }]) {
    assert.equal(await lookupMarket(h.pool, { isbn }, { fetchImpl: f, env }), null);
  }
  assert.equal(await lookupMarket(h.pool, { isbn: "" }, { fetchImpl: f, env: ENV }), null);
  assert.equal(f.calls.length, 0);
  assert.equal((await h.q("SELECT 1 FROM price_lookups WHERE isbn = $1", [isbn])).length, 0, "nothing is stored when it is off");

  const brokenPool = { query: async () => { throw new Error("db down"); } };
  assert.equal(await lookupMarket(brokenPool, { isbn }, { fetchImpl: f, env: ENV }), null);
  const throwing = async () => { throw new Error("network down"); };
  const out = await suggestPrice(h.pool, { isbn: isbn13(), binding: "trade", condition: "good", existingCopies: 0 }, { fetchImpl: throwing, env: ENV, settings: DEFAULT_SETTINGS });
  assert.deepEqual([out.price, out.ruleSet, out.confidence], [8, "B", "low"]);
});

test("combiner with listings: 4+ listings trim outliers; one listing; the median drives the rule", async () => {
  const env = ENV;
  const run = async (prices, input = {}) => suggestPrice(h.pool, { isbn: isbn13(), condition: "good", existingCopies: 0, ...input }, { fetchImpl: fakeFetch(answerWith(prices)), env });
  const trimmed = await run([5, 6, 7, 8, 300]); // 300 is dropped
  assert.deepEqual([trimmed.price, trimmed.confidence], [8, "high"]);
  assert.match(trimmed.rationale.join(" "), /1 unusually high or low listing was ignored/);
  const single = await run([4]);
  assert.deepEqual([single.price, single.confidence], [5, "medium"]);
  assert.match(single.rationale.join(" "), /One listing is not much to go on/);
  const pricey = await run([30, 36]); // median 33 -> Rule C: 75% = 24.75 -> 25
  assert.deepEqual([pricey.price, pricey.level, pricey.ruleSet], [25, "custom", "C"]);
  assert.match(pricey.rationale.join(" "), /Rule C \(high value and collectible\): market value about EUR 33\.00 -> 75% = EUR 25\.00/);
  const usd = await suggestPrice(h.pool, { isbn: isbn13(), condition: "good" }, { env, fetchImpl: async () => jsonRes({ content: [{ type: "text", text: JSON.stringify({ originalPrice: null, comparables: [
    { site: "eBay", url: "https://e.example/1", price: { amount: 10, currency: "USD" }, condition: "", note: "" },
    { site: "eBay", url: "https://e.example/2", price: { amount: 10, currency: "GBP" }, condition: "", note: "" },
  ] }) }] }) });
  assert.match(usd.rationale.join(" "), /market value is about EUR 10\.35/, "median of 9.20 and 11.50, converted with the settings");
});
