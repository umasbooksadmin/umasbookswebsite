// Why Google Books lookups fail: googleStatus() keeps a kind, a count per kind, the time of the last error and a
// short safe reason; never the URL (it carries the key) nor a body. No behaviour change to the lookup itself.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const sources = require("../../src/lib/bookSources");
const { DEFAULT_MAX_BYTES } = require("../../src/lib/boundedBody");
const { isbn13From } = require("../helpers/isbn");

const forms = sources.isbnForms(isbn13From("978014312755"));
const signal = new AbortController().signal;
const helpers = { pickGenres: () => null };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const run = (fetchImpl, now) => sources.googleBooks({ forms, fetchImpl, signal, helpers, now });
beforeEach(() => { process.env.GOOGLE_BOOKS_API_KEY = "AIzaSECRETKEY"; sources.resetSourcePauses(); });

test("an HTTP error is counted by status, with Google's short reason, and the result is unchanged", async () => {
  const r = await run(async () => json({ error: { code: 400, message: "x".repeat(200), errors: [{ reason: "keyInvalid" }] } }, 400), () => 5000);
  assert.deepEqual(r, { state: "error", status: 400 });
  const g = sources.googleStatus();
  assert.deepEqual(g.counts, { "http 400": 1 });
  assert.equal(g.lastKind, "http 400");
  assert.equal(g.lastAt, 5000);
  assert.equal(g.lastReason, "keyInvalid");
});

test("without a reason word the message is truncated to 80 characters", async () => {
  await run(async () => json({ error: { message: "m".repeat(300) } }, 500));
  assert.equal(sources.googleStatus().lastReason.length, 80);
});

test("network, timeout, parse and too-large failures are told apart", async () => {
  const mk = (name) => Object.assign(new Error("boom"), { name });
  assert.deepEqual(await run(async () => { throw mk("TypeError"); }), { state: "error" });
  await run(async () => { throw mk("AbortError"); });
  await run(async () => new Response("not json", { status: 200 }));
  const pad = "a".repeat(DEFAULT_MAX_BYTES + 10);
  await run(async () => new Response(JSON.stringify({ items: [], pad })));
  const g = sources.googleStatus();
  assert.deepEqual(g.counts, { network: 1, timeout: 1, parse: 1, "too large": 1 });
  assert.equal(g.total, 4);
  assert.equal(g.lastReason, null);
});

test("a 404 and a good answer are not failures; the key and URL are never stored", async () => {
  let seenUrl = "";
  await run(async (u) => { seenUrl = u; return json({}, 404); });
  await run(async () => json({ items: [] }), () => 9000);
  const g = sources.googleStatus();
  assert.equal(g.total, 0);
  assert.equal(g.lastOkAt, 9000);
  assert.match(seenUrl, /AIzaSECRETKEY/); // the key is sent to Google ...
  assert.doesNotMatch(JSON.stringify(g), /AIza|googleapis|isbn:/); // ... and kept nowhere
});

test("a reason that looks like it holds a key is scrubbed", async () => {
  await run(async () => json({ error: { message: "bad request key=AIzaSECRETKEY&x" } }, 400));
  assert.doesNotMatch(sources.googleStatus().lastReason, /AIzaSECRETKEY/);
});
