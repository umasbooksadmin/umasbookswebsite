// The ISBN lookup asks several catalogs at once and merges them (lib/bookLookup.js, lib/bookSources.js):
// Open Library (brief + data API), the BnF for French books, Google Books, and ISBNdb as an optional paid
// last resort. fetch is injected; nothing touches the network.

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { lookupByIsbnDetailed, createTtlCache } = require("../../src/lib/bookLookup");
const sources = require("../../src/lib/bookSources");

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const hang = (init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
const brief = (isbn, data) => ({ records: { r: { isbns: [isbn], data } } });

// A fake internet: handlers by service, calls recorded.
function internet(h = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: init.headers || {} });
    if (u.includes("openlibrary.org/api/volumes/brief")) return (h.brief || (() => json({})))(u, init);
    if (u.includes("openlibrary.org/api/books")) return (h.data || (() => json({})))(u, init);
    if (u.includes("googleapis.com")) return (h.google || (() => json({ totalItems: 0 })))(u, init);
    if (u.includes("catalogue.bnf.fr")) return (h.bnf || (() => new Response("<x/>", { status: 200 })))(u, init);
    if (u.includes("isbndb.com")) return (h.isbndb || (() => json({}, 404)))(u, init);
    throw new Error(`unexpected request ${u}`);
  };
  f.calls = calls;
  f.count = (needle) => calls.filter((c) => c.url.includes(needle)).length;
  return f;
}
const run = (isbn, fetchImpl, o = {}) => lookupByIsbnDetailed(isbn, { fetchImpl, cache: createTtlCache(), hedgeMs: 0, timeoutMs: 1500, graceMs: 40, lateMs: 60, ...o });

const saved = {};
beforeEach(() => { for (const k of ["ISBNDB_API_KEY", "ISBNDB_API_BASE", "ISBNDB_MIN_INTERVAL_MS", "SCAN_LOOKUP_SOURCES"]) { saved[k] = process.env[k]; delete process.env[k]; } sources.resetSourcePauses(); });
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

const GOOGLE_ITEM = (isbn13, extra = {}) => ({ totalItems: 1, items: [{ volumeInfo: { title: "Google Title", authors: ["G. Author"], publisher: "G Pub", publishedDate: "2010-05-01", description: "From Google.", pageCount: 321, language: "en", industryIdentifiers: [{ type: "ISBN_13", identifier: isbn13 }], ...extra } }] });

test("primary miss, secondary hit: Open Library's brief has nothing, its data API has the book", async () => {
  const f = internet({ data: () => json({ "ISBN:9780143127550": { title: "Found by data API", authors: [{ name: "Ann A" }], publishers: [{ name: "Pub" }], publish_date: "May 2015", number_of_pages: 200 } }) });
  const r = await run("9780143127550", f);
  assert.equal(r.state, "found");
  assert.equal(r.book.title, "Found by data API");
  assert.equal(r.book.author, "Ann A");
  assert.equal(r.book.publishedYear, 2015);
  assert.equal(r.book.pages, 200);
  assert.deepEqual(r.via, ["openlibrary-data"]);
});

test("a book only Google Books has is found; a Google record for another ISBN is refused", async () => {
  const isbn = "9780143127550";
  const ok = await run(isbn, internet({ google: () => json(GOOGLE_ITEM(isbn)) }));
  assert.equal(ok.book.title, "Google Title");
  assert.equal(ok.book.publishedYear, 2010);
  assert.equal(ok.book.description, "From Google.");
  assert.equal(ok.book.coverUrl, null, "no cover invented");
  const wrong = await run(isbn, internet({ google: () => json(GOOGLE_ITEM("9780000000002")) }));
  assert.equal(wrong.book, null);
  assert.equal(wrong.state, "missing");
});

test("both slow: the answer is 'slow' at the deadline, nothing is invented", async () => {
  const f = internet({ brief: (u, init) => hang(init), data: (u, init) => hang(init), google: (u, init) => hang(init) });
  const t0 = performance.now();
  const r = await run("9780143127550", f, { timeoutMs: 200, lateMs: 50 });
  assert.equal(r.state, "slow");
  assert.equal(r.book, null);
  assert.ok(performance.now() - t0 < 1000);
});

test("a slow primary does not hold back a quick secondary: the answer comes after the grace time, not the deadline", async () => {
  const isbn = "9780143127550";
  const f = internet({ brief: (u, init) => hang(init), google: () => json(GOOGLE_ITEM(isbn, { authors: undefined })) });
  const t0 = performance.now();
  const r = await run(isbn, f, { timeoutMs: 3000 });
  assert.equal(r.book.title, "Google Title");
  assert.ok(performance.now() - t0 < 1500, "did not wait for the 3 s deadline");
});

test("ISBN-10 fallback: nothing under the 13-digit form, the record is under the ISBN-10", async () => {
  const f = internet({ brief: (u) => (u.includes("/0143127551.json") ? json(brief("0143127551", { title: "Under the ten digits", authors: [{ name: "X Y" }], publishers: [{ name: "P" }], publish_date: "2004" })) : json({})) });
  const r = await run("9780143127550", f);
  assert.equal(r.book.title, "Under the ten digits");
  assert.equal(r.book.isbn, "9780143127550", "the book keeps the ISBN that was scanned");
  assert.equal(f.count("brief/isbn/9780143127550"), 1);
  assert.equal(f.count("brief/isbn/0143127551"), 1);
  // And the other way round: an ISBN-10 typed, the record under the ISBN-13.
  const g = internet({ brief: (u) => (u.includes("/9780143127550.json") ? json(brief("9780143127550", { title: "Under the thirteen" })) : json({})) });
  assert.equal((await run("0143127551", g)).book.title, "Under the thirteen");
});

test("merge priority: the first source's title and fields win; gaps are filled from the others, nothing else", async () => {
  const isbn = "9780143127550";
  const f = internet({
    brief: () => json(brief(isbn, { title: "Open Library Title", authors: [{ name: "OL Author" }] })),
    google: () => json(GOOGLE_ITEM(isbn)),
  });
  const r = await run(isbn, f);
  assert.equal(r.book.title, "Open Library Title");
  assert.equal(r.book.author, "OL Author");
  assert.equal(r.book.publisher, "G Pub", "filled from Google");
  assert.equal(r.book.description, "From Google.");
  assert.equal(r.book.coverUrl, null);
  assert.deepEqual(r.via, ["openlibrary", "google"]);
});

test("negative cache: 'not in any catalog' is remembered briefly, a timeout is not", async () => {
  let now = 1000;
  const cache = createTtlCache({ now: () => now });
  const f = internet({});
  const isbn = "9791090636071";
  assert.equal((await lookupByIsbnDetailed(isbn, { fetchImpl: f, cache, hedgeMs: 0, timeoutMs: 1500, lateMs: 20 })).state, "missing");
  const calls = f.calls.length;
  const again = await lookupByIsbnDetailed(isbn, { fetchImpl: f, cache, hedgeMs: 0, timeoutMs: 1500 });
  assert.equal(again.state, "missing");
  assert.equal(again.cached, true);
  assert.equal(f.calls.length, calls, "no network on the repeat");
  now += 3 * 60 * 1000;
  const later = await lookupByIsbnDetailed(isbn, { fetchImpl: f, cache, hedgeMs: 0, timeoutMs: 1500, lateMs: 20 });
  assert.notEqual(later.cached, true, "the negative answer expired after a few minutes");

  const slow = internet({ brief: (u, init) => hang(init), data: (u, init) => hang(init), google: (u, init) => hang(init) });
  const c2 = createTtlCache();
  await lookupByIsbnDetailed(isbn, { fetchImpl: slow, cache: c2, hedgeMs: 0, timeoutMs: 100, lateMs: 20 });
  assert.equal(c2.size, 0, "a timeout is never cached");
});

test("French ISBNs also ask the BnF; others never do; the record is read as a French book", async () => {
  const xml = `<?xml version="1.0"?><srw:searchRetrieveResponse xmlns:srw="x"><srw:records><srw:record><srw:recordData><oai_dc:dc xmlns:oai_dc="y" xmlns:dc="z">
    <dc:title>Le petit prince / Antoine de Saint-Exup&#233;ry ; avec des aquarelles de l'auteur</dc:title><dc:creator>Saint-Exup&#233;ry, Antoine de (1900-1944). Auteur du texte</dc:creator>
    <dc:publisher>Gallimard (Paris)</dc:publisher><dc:date>2007</dc:date><dc:identifier>ISBN 9782070612758</dc:identifier><dc:format>1 vol. (113 p.) ; 18 cm</dc:format><dc:language>fre</dc:language>
    </oai_dc:dc></srw:recordData></srw:record></srw:records></srw:searchRetrieveResponse>`.replace(/&#233;/g, "é");
  const f = internet({ bnf: () => new Response(xml, { status: 200 }) });
  const r = await run("9782070612758", f);
  assert.equal(r.book.title, "Le petit prince");
  assert.equal(r.book.author, "Antoine de Saint-Exupéry");
  assert.equal(r.book.publisher, "Gallimard");
  assert.equal(r.book.publishedYear, 2007);
  assert.equal(r.book.language, "fre");
  assert.equal(r.book.pages, 113);
  const g = internet({});
  await run("9780143127550", g);
  assert.equal(g.count("bnf.fr"), 0);
});

test("Google answering 429 is left alone for a while; the lookup is not held up", async () => {
  const isbn = "9780143127550";
  const f = internet({ google: () => json({ error: { code: 429 } }, 429) });
  assert.equal((await run(isbn, f)).state, "missing");
  assert.equal(f.count("googleapis"), 1);
  await run("9780143127551", f);
  assert.equal(f.count("googleapis"), 1, "no second request inside the pause");
});

// ------------------------------------------------------------------ ISBNdb

const ISBNDB_BOOK = { book: { title: "ISBNdb Title", title_long: "ISBNdb Title: Long", authors: ["Zed Zed", "Yan Yan"], publisher: "Paid Pub", date_published: "2019-03-05", pages: 288, binding: "Paperback", language: "en", image: "https://images.isbndb.com/covers/x.jpg", synopsis: "<p>Great &amp; good.</p>", subjects: ["Fiction"] } };

test("ISBNdb: without ISBNDB_API_KEY it is never called", async () => {
  const f = internet({ isbndb: () => json(ISBNDB_BOOK) });
  const r = await run("9791090636071", f);
  assert.equal(r.state, "missing");
  assert.equal(f.count("isbndb.com"), 0);
});

test("ISBNdb: with a key, called once and only after the free sources found nothing; mapped to our fields; the cover is not used", async () => {
  process.env.ISBNDB_API_KEY = "secret-key-123";
  const logs = [];
  const log = console.warn;
  console.warn = (...a) => logs.push(a.join(" "));
  try {
    const f = internet({ isbndb: () => json(ISBNDB_BOOK) });
    const r = await run("9780143127550", f);
    assert.equal(f.count("isbndb.com"), 1);
    assert.equal(f.calls.findIndex((c) => c.url.includes("isbndb.com")), f.calls.length - 1, "after the free sources");
    const call = f.calls.find((c) => c.url.includes("isbndb.com"));
    assert.equal(call.url, "https://api2.isbndb.com/book/9780143127550");
    assert.equal(call.headers.Authorization, "secret-key-123");
    assert.match(call.headers["User-Agent"], /UmasBooks/);
    assert.equal(r.book.title, "ISBNdb Title");
    assert.equal(r.book.author, "Zed Zed, Yan Yan");
    assert.equal(r.book.publisher, "Paid Pub");
    assert.equal(r.book.publishedYear, 2019);
    assert.equal(r.book.binding, "trade", "Paperback mapped by mapBinding");
    assert.equal(r.book.description, "Great & good.");
    assert.equal(r.book.coverUrl, null, "ISBNdb's cover image is not used");
    assert.deepEqual(r.via, ["isbndb"]);
    assert.ok(!logs.join("\n").includes("secret-key-123"), "the key is never logged");
  } finally {
    console.warn = log;
  }
});

test("ISBNdb: not asked when the free sources already gave a complete book; asked to fill a missing publisher/year", async () => {
  process.env.ISBNDB_API_KEY = "k";
  const isbn = "9780143127550";
  const complete = internet({ brief: () => json(brief(isbn, { title: "T", authors: [{ name: "A" }], publishers: [{ name: "P" }], publish_date: "2001" })), isbndb: () => json(ISBNDB_BOOK) });
  await run(isbn, complete);
  assert.equal(complete.count("isbndb.com"), 0);
  const partial = internet({ brief: () => json(brief(isbn, { title: "Short record" })), isbndb: () => json(ISBNDB_BOOK) });
  const r = await run(isbn, partial);
  assert.equal(partial.count("isbndb.com"), 1);
  assert.equal(r.book.title, "Short record", "the free source keeps priority");
  assert.equal(r.book.publisher, "Paid Pub", "gap filled from ISBNdb");
});

test("ISBNdb: 401 is handled quietly: the lookup still answers, ISBNdb is left alone, the status says the key is refused", async () => {
  process.env.ISBNDB_API_KEY = "bad-key";
  const logs = [];
  const log = console.warn;
  console.warn = (...a) => logs.push(a.join(" "));
  try {
    const f = internet({ isbndb: () => json({ message: "Bad credentials." }, 401) });
    const r = await run("9791090636071", f);
    assert.equal(r.state, "missing", "the free sources' answer stands");
    assert.equal(sources.isbndbStatus().status, "invalid");
    assert.match(sources.isbndbStatus().lastError, /refused/);
    assert.ok(sources.isbndbStatus().pausedUntil > Date.now());
    await run("9791090636072", f);
    await run("9791090636073", f);
    assert.equal(f.count("isbndb.com"), 1, "no more calls while paused");
    assert.equal(logs.filter((l) => /ISBNdb/.test(l)).length, 1, "logged once");
    assert.ok(!logs.join("\n").includes("bad-key"));
  } finally {
    console.warn = log;
  }
});

test("ISBNdb: 429 pauses it for the Retry-After seconds; a 404 is a plain 'not there'", async () => {
  process.env.ISBNDB_API_KEY = "k";
  const f = internet({ isbndb: () => json({ message: "Daily quota exceeded, please try again later" }, 429, { "retry-after": "120" }) });
  await run("9791090636071", f);
  const st = sources.isbndbStatus();
  assert.equal(st.status, "rate_limited");
  assert.ok(st.pausedUntil - Date.now() > 100 * 1000 && st.pausedUntil - Date.now() <= 121 * 1000);
  sources.resetSourcePauses();
  const g = internet({ isbndb: () => json({ message: "Book not found" }, 404) });
  assert.equal((await run("9791090636071", g)).state, "missing");
  assert.equal(sources.isbndbStatus().status, "ok");
});

test("ISBNdb: requests are spaced by the rate limit however many scans run together; a long queue is skipped, not waited for", async () => {
  process.env.ISBNDB_API_KEY = "k";
  process.env.ISBNDB_MIN_INTERVAL_MS = "120";
  const stamps = [];
  const f = internet({ isbndb: () => { stamps.push(performance.now()); return json({}, 404); } });
  await Promise.all(["9791090636071", "9791090636072", "9791090636073"].map((i) => run(i, f, { timeoutMs: 3000 })));
  assert.equal(stamps.length, 3);
  assert.ok(stamps[1] - stamps[0] >= 100 && stamps[2] - stamps[1] >= 100, `spaced: ${stamps.map((s) => (s - stamps[0]).toFixed(0)).join(", ")}`);

  // A direct burst against the limiter: slots beyond MAX_QUEUE_WAIT_MS are refused at once.
  sources.resetSourcePauses();
  process.env.ISBNDB_MIN_INTERVAL_MS = "1000";
  const g = internet({ isbndb: () => json({}, 404) });
  const forms = sources.isbnForms("9791090636071");
  const outcomes = await Promise.all([0, 1, 2, 3, 4].map(() => sources.isbndb({ forms, fetchImpl: g, signal: new AbortController().signal, helpers: { pickGenres: () => null }, sleep: () => Promise.resolve() })));
  assert.ok(outcomes.some((o) => o.skipped), "the deep end of the queue was skipped");
  assert.ok(g.count("isbndb.com") <= 3);
});

test("ISBNdb: ISBNDB_API_BASE only accepts an https isbndb.com host (the key goes nowhere else)", () => {
  const log = console.warn;
  console.warn = () => {};
  try {
    assert.equal(sources.isbndbBase({}), "https://api2.isbndb.com");
    assert.equal(sources.isbndbBase({ ISBNDB_API_BASE: "https://api.premium.isbndb.com/" }), "https://api.premium.isbndb.com");
    assert.equal(sources.isbndbBase({ ISBNDB_API_BASE: "https://evil.example.com" }), "https://api2.isbndb.com");
    assert.equal(sources.isbndbBase({ ISBNDB_API_BASE: "http://api2.isbndb.com" }), "https://api2.isbndb.com");
    assert.equal(sources.isbndbBase({ ISBNDB_API_BASE: "https://isbndb.com.evil.test" }), "https://api2.isbndb.com");
  } finally {
    console.warn = log;
  }
});
