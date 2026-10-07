// lib/coverVision.js, lib/bookDescription.js (Anthropic) and lib/bookLookup.js
// (Open Library): request shape, response parsing, and that every failure
// mode (non-2xx, bad JSON, network error, timeout, missing key) falls
// through to null/[] without throwing. global.fetch is stubbed for the
// whole file and refuses any host that isn't the expected one, so nothing
// real can be sent.

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

const realFetch = global.fetch;
const realKey = process.env.ANTHROPIC_API_KEY;
const realWorkspace = process.env.ANTHROPIC_WORKSPACE_ID;

const calls = []; // { url, init }
let handler; // (url, init) => Response | Promise<Response>

const ALLOWED = ["https://api.anthropic.com/", "https://openlibrary.org/"];

beforeEach(() => {
  calls.length = 0;
  handler = () => { throw new Error("unexpected fetch"); };
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  delete process.env.ANTHROPIC_WORKSPACE_ID;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    assert.ok(ALLOWED.some((p) => u.startsWith(p)), `fetch to unexpected host: ${u}`);
    calls.push({ url: u, init });
    return handler(u, init);
  };
  mock.method(console, "warn", () => {});
});

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
  global.fetch = realFetch;
  if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = realKey;
  if (realWorkspace === undefined) delete process.env.ANTHROPIC_WORKSPACE_ID; else process.env.ANTHROPIC_WORKSPACE_ID = realWorkspace;
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const claudeText = (text) => json({ content: [{ type: "text", text }] });

// A fetch that never resolves until its AbortSignal fires, like a hung server.
function hang(_url, init) {
  return new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
}

// Fire pending (mocked) timers until `promise` settles.
async function runTimersUntilSettled(promise, stepMs) {
  let settled = false;
  const tracked = promise.finally(() => { settled = true; });
  for (let i = 0; i < 10 && !settled; i++) {
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(stepMs);
  }
  return tracked;
}

// ---------------------------------------------------------------- coverVision

const { extractBookInfoFromPhoto } = require("../../src/lib/coverVision");

test("coverVision: sends one Anthropic request with the image base64 and parses the JSON reply", async () => {
  handler = () => claudeText('{"isbn": "9780134685991", "title": "Effective Java", "author": "Joshua Bloch"}');
  const buf = Buffer.from("fake-image-bytes");
  const info = await extractBookInfoFromPhoto(buf, "image/png");

  assert.deepEqual(info, { isbn: "9780134685991", title: "Effective Java", author: "Joshua Bloch" });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["x-api-key"], "test-key-not-real");
  assert.equal(init.headers["anthropic-version"], "2023-06-01");
  assert.equal(init.headers["content-type"], "application/json");
  assert.ok(!("anthropic-workspace-id" in init.headers));
  assert.ok(init.signal instanceof AbortSignal);
  const body = JSON.parse(init.body);
  assert.match(body.model, /^claude-/);
  assert.equal(body.max_tokens, 300);
  const [imagePart, textPart] = body.messages[0].content;
  assert.deepEqual(imagePart, { type: "image", source: { type: "base64", media_type: "image/png", data: buf.toString("base64") } });
  assert.equal(textPart.type, "text");
  assert.match(textPart.text, /isbn/);
});

test("coverVision: forwards the workspace id header only when configured", async () => {
  process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_test";
  handler = () => claudeText('{"isbn": null, "title": "T", "author": null}');
  await extractBookInfoFromPhoto(Buffer.from("x"), "image/jpeg");
  assert.equal(calls[0].init.headers["anthropic-workspace-id"], "wrkspc_test");
});

test("coverVision: extracts JSON wrapped in prose / code fences and nulls missing fields", async () => {
  handler = () => claudeText('Here you go:\n```json\n{"title": "Dune"}\n```');
  assert.deepEqual(await extractBookInfoFromPhoto(Buffer.from("x"), "image/jpeg"), { isbn: null, title: "Dune", author: null });
});

test("coverVision: no API key means no request at all", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(await extractBookInfoFromPhoto(Buffer.from("x"), "image/jpeg"), null);
  assert.equal(calls.length, 0);
});

test("coverVision: every failure mode resolves to null without throwing", async (t) => {
  const cases = {
    "HTTP 500": () => new Response("boom", { status: 500 }),
    "HTTP 401": () => json({ error: "bad key" }, 401),
    "empty content array": () => json({ content: [] }),
    "no content field": () => json({ nope: true }),
    "model replied without JSON": () => claudeText("I cannot read this image."),
    "model replied with broken JSON": () => claudeText('{"title": "oops",}'),
    "response body isn't JSON": () => new Response("<html>", { status: 200 }),
    "network error": () => { throw new TypeError("fetch failed"); },
  };
  for (const [name, fn] of Object.entries(cases)) {
    await t.test(name, async () => {
      handler = fn;
      assert.equal(await extractBookInfoFromPhoto(Buffer.from("x"), "image/jpeg"), null);
    });
  }
});

test("coverVision: a hung request is aborted after 20s and returns null", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  handler = hang;
  const result = await runTimersUntilSettled(extractBookInfoFromPhoto(Buffer.from("x"), "image/jpeg"), 20000);
  assert.equal(result, null);
  assert.equal(calls[0].init.signal.aborted, true);
});

// ------------------------------------------------------------- bookDescription

const { generateBookDescription, translateDescriptionToFrench } = require("../../src/lib/bookDescription");

test("bookDescription: builds a prompt from the details, trims the reply", async () => {
  handler = () => claudeText("  A fine book about whales.\n");
  const out = await generateBookDescription({ title: "Moby Dick", author: "Herman Melville", publisher: "Harper", publishedYear: 1851 });
  assert.equal(out, "A fine book about whales.");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.max_tokens, 200);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(body.messages[0].role, "user");
  const prompt = body.messages[0].content;
  assert.match(prompt, /"Moby Dick"/);
  assert.match(prompt, /by Herman Melville/);
  assert.match(prompt, /published by Harper/);
  assert.match(prompt, /\(1851\)/);
});

test("bookDescription: optional details are left out of the prompt when absent", async () => {
  handler = () => claudeText("ok");
  await generateBookDescription({ title: "Bare Title" });
  const prompt = JSON.parse(calls[0].init.body).messages[0].content;
  assert.doesNotMatch(prompt, /published by|\(\d{4}\)/);
  assert.ok(prompt.includes('Title: "Bare Title" \n'), "no details appended after the title");
});

test("bookDescription: no title or no API key -> null with no request", async () => {
  assert.equal(await generateBookDescription({ title: "" }), null);
  assert.equal(await generateBookDescription({}), null);
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(await generateBookDescription({ title: "X" }), null);
  assert.equal(await translateDescriptionToFrench("Hello"), null);
  assert.equal(calls.length, 0);
});

test("bookDescription: translate sends the English text, returns the French", async () => {
  handler = () => claudeText("Un beau livre.");
  assert.equal(await translateDescriptionToFrench("A fine book."), "Un beau livre.");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.max_tokens, 250);
  assert.match(body.messages[0].content, /A fine book\./);
  assert.match(body.messages[0].content, /French/);
});

test("bookDescription: translate of empty text makes no request", async () => {
  assert.equal(await translateDescriptionToFrench(""), null);
  assert.equal(await translateDescriptionToFrench(null), null);
  assert.equal(calls.length, 0);
});

test("bookDescription: failures resolve to null (500, odd shape, network error, timeout)", async () => {
  handler = () => new Response("nope", { status: 529 });
  assert.equal(await generateBookDescription({ title: "X" }), null);
  handler = () => json({ content: [{ type: "tool_use" }] });
  assert.equal(await generateBookDescription({ title: "X" }), null);
  handler = () => { throw new TypeError("fetch failed"); };
  assert.equal(await translateDescriptionToFrench("Hi"), null);

  mock.timers.enable({ apis: ["setTimeout"] });
  handler = hang;
  assert.equal(await runTimersUntilSettled(generateBookDescription({ title: "X" }), 8000), null);
});

// ------------------------------------------------------------------ bookLookup

const { lookupByIsbn, searchByTitleAuthor, translateGenresToFrench, COMMON_GENRES, normalizeIsbn } = require("../../src/lib/bookLookup");

const volumeReply = (data, isbns = ["9780140328721"]) => json({ records: { "/books/OL1M": { isbns, data } } });

test("bookLookup: lookupByIsbn maps a found record, normalising the ISBN in the URL", async () => {
  handler = () => volumeReply({
    title: "Fantastic Mr Fox",
    authors: [{ name: "Roald Dahl" }, { name: "Quentin Blake" }],
    publishers: [{ name: "Puffin" }],
    publish_date: "October 1, 1988",
    description: { value: "A fox story." },
    cover: { medium: "https://covers.example/m.jpg", large: "https://covers.example/l.jpg" },
    subjects: [{ name: "Foxes" }, { name: "Fantasy fiction" }, { name: "Fiction" }, { name: "x:y" }],
    physical_format: "Mass Market Paperback",
  });
  const book = await lookupByIsbn("978-0-14-032872-1");
  assert.equal(calls[0].url, "https://openlibrary.org/api/volumes/brief/isbn/9780140328721.json");
  assert.equal(calls[0].init.headers["User-Agent"], "UmasBooksInventory/1.0");
  assert.deepEqual(book, {
    isbn: "9780140328721",
    title: "Fantastic Mr Fox",
    author: "Roald Dahl, Quentin Blake",
    publisher: "Puffin",
    publishedYear: 1988,
    description: "A fox story.",
    coverUrl: "https://covers.example/l.jpg",
    genre: "Fiction, Fantasy",
    genreFr: "Fiction, Fantasy",
    binding: "mass_market",
  });
});

test("bookLookup: lookupByIsbn reports the binding from physical_format (also under details), null when unknown", async () => {
  handler = () => volumeReply({ title: "A", physical_format: "Hardcover" });
  assert.equal((await lookupByIsbn("9780140328721")).binding, "hardcover");
  handler = () => json({ records: { "/books/OL1M": { isbns: ["9780140328721"], data: { title: "A" }, details: { details: { physical_format: "paperback" } } } } });
  assert.equal((await lookupByIsbn("9780140328721")).binding, "trade");
  handler = () => volumeReply({ title: "A", physical_format: "Audio CD" });
  assert.equal((await lookupByIsbn("9780140328721")).binding, "other");
  handler = () => volumeReply({ title: "A" });
  assert.equal((await lookupByIsbn("9780140328721")).binding, null);
});

test("bookLookup: lookupByIsbn handles sparse records (by_statement author, string description, medium cover)", async () => {
  handler = () => volumeReply({
    title: "Sparse",
    by_statement: "by  Jane Doe ",
    description: "plain",
    cover: { medium: "m.jpg" },
    subjects: [{ name: "Whimsy" }, { name: "Odd" }],
  });
  const book = await lookupByIsbn("0140328726");
  assert.equal(book.author, "Jane Doe");
  assert.equal(book.description, "plain");
  assert.equal(book.coverUrl, "m.jpg");
  assert.equal(book.publisher, null);
  assert.equal(book.publishedYear, null);
  assert.equal(book.genre, "Odd", "no standard genre -> shortest raw tag");

  handler = () => volumeReply({});
  const bare = await lookupByIsbn("0140328726");
  assert.deepEqual([bare.title, bare.author, bare.description, bare.coverUrl, bare.genre, bare.genreFr], [null, null, null, null, null, null]);
});

test("bookLookup: not-found shapes return null", async (t) => {
  const cases = {
    "empty object": () => json({}),
    "empty array": () => json([]),
    "record without isbns": () => json({ records: { a: { isbns: [], data: { title: "garbage" } } } }),
    "records empty": () => json({ records: {} }),
    "HTTP 404": () => new Response("", { status: 404 }),
    "HTTP 500": () => new Response("", { status: 500 }),
  };
  for (const [name, fn] of Object.entries(cases)) {
    await t.test(name, async () => {
      handler = fn;
      assert.equal(await lookupByIsbn("9780140328721"), null);
    });
  }
});

test("bookLookup: blank ISBN never hits the network", async () => {
  assert.equal(await lookupByIsbn(""), null);
  assert.equal(await lookupByIsbn("---"), null);
  assert.equal(await lookupByIsbn(undefined), null);
  assert.equal(calls.length, 0);
});

test("bookLookup: a network error is retried once, then gives up with null (no throw)", async () => {
  handler = () => { throw new TypeError("fetch failed"); };
  assert.equal(await lookupByIsbn("9780140328721"), null);
  assert.equal(calls.length, 2, "one retry");
});

test("bookLookup: a transient error followed by success still finds the book", async () => {
  let n = 0;
  handler = () => { if (++n === 1) throw new TypeError("ECONNRESET"); return volumeReply({ title: "Second Try" }); };
  assert.equal((await lookupByIsbn("9780140328721")).title, "Second Try");
});

test("bookLookup: invalid JSON from the server is treated as a miss", async () => {
  handler = () => new Response("not json", { status: 200 });
  assert.equal(await lookupByIsbn("9780140328721"), null);
});

test("bookLookup: a hung server times out (5s per attempt) and falls through to null", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  handler = hang;
  assert.equal(await runTimersUntilSettled(lookupByIsbn("9780140328721"), 5000), null);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.init.signal.aborted));
});

test("bookLookup: searchByTitleAuthor builds the query and maps docs", async () => {
  handler = () => json({ docs: [
    { title: "Dune", author_name: ["Frank Herbert"], isbn: ["111", "222"], cover_i: 42, first_publish_year: 1965, publisher: ["Chilton"], subject: ["Science Fiction", "Fiction"] },
    { title: "Bare" },
  ] });
  const results = await searchByTitleAuthor("Dune", "Frank Herbert");
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, "https://openlibrary.org/search.json");
  assert.equal(u.searchParams.get("title"), "Dune");
  assert.equal(u.searchParams.get("author"), "Frank Herbert");
  assert.equal(u.searchParams.get("limit"), "5");
  assert.deepEqual(results[0], {
    isbn: "111", title: "Dune", author: "Frank Herbert", publisher: "Chilton", publishedYear: 1965, description: null,
    coverUrl: "https://covers.openlibrary.org/b/id/42-L.jpg", genre: "Fiction, Science Fiction", genreFr: "Fiction, Science-fiction",
  });
  assert.deepEqual(results[1], {
    isbn: null, title: "Bare", author: null, publisher: null, publishedYear: null, description: null, coverUrl: null, genre: null, genreFr: null,
  });
});

test("bookLookup: searchByTitleAuthor caps at 5, omits unused params, and falls through on every failure", async () => {
  handler = () => json({ docs: Array.from({ length: 9 }, (_, i) => ({ title: `T${i}` })) });
  const results = await searchByTitleAuthor(null, "Only Author");
  assert.equal(results.length, 5);
  const u = new URL(calls[0].url);
  assert.equal(u.searchParams.has("title"), false);
  assert.equal(u.searchParams.get("author"), "Only Author");

  calls.length = 0;
  assert.deepEqual(await searchByTitleAuthor("", ""), []);
  assert.equal(calls.length, 0);

  handler = () => json({ docs: "nope" });
  assert.deepEqual(await searchByTitleAuthor("x"), []);
  handler = () => new Response("", { status: 503 });
  assert.deepEqual(await searchByTitleAuthor("x"), []);
  handler = () => { throw new TypeError("fetch failed"); };
  assert.deepEqual(await searchByTitleAuthor("x"), []);

  mock.timers.enable({ apis: ["setTimeout"] });
  handler = hang;
  assert.deepEqual(await runTimersUntilSettled(searchByTitleAuthor("x"), 5000), []);
});

test("bookLookup: translateGenresToFrench maps the taxonomy and keeps unknown free text", () => {
  assert.equal(translateGenresToFrench(null), null);
  assert.equal(translateGenresToFrench(""), null);
  assert.equal(translateGenresToFrench("Mystery,  history , Whimsy"), "Policier, Histoire, Whimsy");
  assert.ok(COMMON_GENRES.includes("Fantasy"));
  assert.equal(normalizeIsbn("0-8044-2957-x"), "080442957X");
});
